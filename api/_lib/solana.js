// USDT-on-Solana payout sender. This is the ONLY money-OUT code path in the app.
//
// The wallet's secret key lives ONLY in the SOLANA_PAYOUT_SECRET_KEY env var
// (Ray exports it from Phantom and pastes it into Vercel — it is never printed,
// logged, committed, or returned to a client). Nothing here fires on its own:
// api/payouts.js only calls sendUsdt() after an owner/admin explicitly confirms
// a release. preflight() is read-only (no funds move, no accounts created) and
// backs the dry-run preview.
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount,
  createTransferCheckedInstruction, TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import bs58 from 'bs58'

// Tether USDT SPL mint on Solana mainnet (6 decimals). Overridable via env.
const DEFAULT_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const USDT_DECIMALS = 6
// Enough SOL to cover the network fee plus, if the recipient has no USDT
// account yet, the ~0.00204 SOL rent to create their associated token account.
const MIN_SOL_LAMPORTS = 3_000_000 // 0.003 SOL

const mintPubkey = () => new PublicKey(process.env.USDT_SOLANA_MINT || DEFAULT_USDT_MINT)
const rpcUrl = () => process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
const connection = () => new Connection(rpcUrl(), 'confirmed')

// USDT dollar amount → integer base units (6 decimals), rounded to the cent-safe
// smallest unit. Returns a BigInt.
export function toBaseUnits(usdt) {
  const n = Number(usdt)
  if (!Number.isFinite(n) || n < 0) throw httpErr(400, 'invalid amount')
  return BigInt(Math.round(n * 10 ** USDT_DECIMALS))
}
export const fromBaseUnits = (units) => Number(units) / 10 ** USDT_DECIMALS

function httpErr(status, message, code) {
  const e = new Error(message); e.status = status; if (code) e.code = code; return e
}

// Load the payout keypair from env. Accepts a Phantom base58 export (the common
// case) OR a JSON byte array (Solana CLI id.json). Never logs the key material.
export function loadPayoutKeypair() {
  const raw = (process.env.SOLANA_PAYOUT_SECRET_KEY || '').trim()
  if (!raw) throw httpErr(500, 'Payout wallet is not configured (SOLANA_PAYOUT_SECRET_KEY missing).', 'no_wallet_key')
  let bytes
  try {
    if (raw.startsWith('[')) {
      bytes = Uint8Array.from(JSON.parse(raw))
    } else {
      bytes = bs58.decode(raw)
    }
  } catch {
    throw httpErr(500, 'Payout wallet key is malformed (expected a Phantom base58 key or a JSON byte array).', 'bad_wallet_key')
  }
  if (bytes.length !== 64) {
    throw httpErr(500, 'Payout wallet key is the wrong length (expected a 64-byte secret key).', 'bad_wallet_key')
  }
  try {
    return Keypair.fromSecretKey(bytes)
  } catch {
    throw httpErr(500, 'Payout wallet key could not be loaded.', 'bad_wallet_key')
  }
}

// Address is a syntactically valid, on-curve Solana wallet (not a program/PDA).
export function validateAddress(address) {
  let pk
  try { pk = new PublicKey(String(address || '').trim()) } catch {
    return { ok: false, reason: 'Not a valid Solana address.' }
  }
  if (!PublicKey.isOnCurve(pk.toBytes())) {
    return { ok: false, reason: 'That address is a program/PDA, not a normal wallet.' }
  }
  return { ok: true, pubkey: pk }
}

async function readTokenBalance(conn, ata) {
  try {
    const acct = await getAccount(conn, ata)
    return acct.amount // BigInt base units
  } catch {
    return null // account does not exist yet
  }
}

// Read-only preview: can the payout wallet send `amountUsdt` to `toAddress`?
// Creates nothing and moves nothing. Returns balances + a blocking-issues list.
export async function preflight(toAddress, amountUsdt) {
  const issues = []
  const v = validateAddress(toAddress)
  if (!v.ok) return { ok: false, issues: [v.reason], recipient: toAddress }

  let from
  try { from = loadPayoutKeypair() } catch (e) { return { ok: false, issues: [e.message], recipient: toAddress } }

  const conn = connection()
  const mint = mintPubkey()
  const need = toBaseUnits(amountUsdt)

  const fromAta = getAssociatedTokenAddressSync(mint, from.publicKey)
  const toAta = getAssociatedTokenAddressSync(mint, v.pubkey)
  const [solLamports, fromBal, toExists] = await Promise.all([
    conn.getBalance(from.publicKey),
    readTokenBalance(conn, fromAta),
    getAccount(conn, toAta).then(() => true).catch(() => false),
  ])

  if (fromBal === null) issues.push('Payout wallet holds no USDT yet (no USDT token account).')
  else if (fromBal < need) issues.push(`Payout wallet USDT balance ${fromBaseUnits(fromBal)} is less than ${Number(amountUsdt)}.`)
  if (solLamports < MIN_SOL_LAMPORTS) issues.push(`Payout wallet needs at least 0.003 SOL for fees (has ${(solLamports / 1e9).toFixed(4)}).`)

  return {
    ok: issues.length === 0,
    issues,
    recipient: v.pubkey.toBase58(),
    sender: from.publicKey.toBase58(),
    sol_balance: solLamports / 1e9,
    usdt_balance: fromBal === null ? 0 : fromBaseUnits(fromBal),
    recipient_has_usdt_account: toExists,
    amount: Number(amountUsdt),
  }
}

// Send `amountUsdt` USDT to `toAddress`. Creates the recipient's USDT account if
// missing (sender pays the rent). Throws on any pre-broadcast failure so the
// caller can safely release the reservation; returns the tx signature on success.
export async function sendUsdt(toAddress, amountUsdt) {
  const v = validateAddress(toAddress)
  if (!v.ok) throw httpErr(400, v.reason, 'bad_recipient')
  const from = loadPayoutKeypair()
  const conn = connection()
  const mint = mintPubkey()
  const amount = toBaseUnits(amountUsdt)
  if (amount <= 0n) throw httpErr(400, 'Amount must be greater than zero.', 'zero_amount')

  // Source account must already exist and be funded.
  const fromAta = getAssociatedTokenAddressSync(mint, from.publicKey)
  const fromBal = await readTokenBalance(conn, fromAta)
  if (fromBal === null) throw httpErr(400, 'Payout wallet has no USDT account to send from.', 'insufficient_usdt')
  if (fromBal < amount) throw httpErr(400, `Insufficient USDT: have ${fromBaseUnits(fromBal)}, need ${Number(amountUsdt)}.`, 'insufficient_usdt')

  // Get-or-create the recipient's USDT account (sender is payer). This is the
  // last pre-broadcast step that can fail cleanly.
  const toAcct = await getOrCreateAssociatedTokenAccount(conn, from, mint, v.pubkey)

  const ix = createTransferCheckedInstruction(
    fromAta, mint, toAcct.address, from.publicKey, amount, USDT_DECIMALS, [], TOKEN_PROGRAM_ID,
  )
  const tx = new Transaction().add(ix)
  const signature = await sendAndConfirmTransaction(conn, tx, [from], {
    commitment: 'confirmed', maxRetries: 3,
  })
  return { signature, from: from.publicKey.toBase58(), to: v.pubkey.toBase58(), amount: Number(amountUsdt) }
}

export const explorerTxUrl = (sig) => `https://solscan.io/tx/${sig}`
