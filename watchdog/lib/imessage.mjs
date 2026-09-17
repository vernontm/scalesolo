// Send an iMessage from this Mac via AppleScript (osascript).
//
// Requires the macOS Messages app to be signed in. For a plain cell number
// that is not on iMessage, enable Text Message Forwarding on the paired
// iPhone (Settings > Messages > Text Message Forwarding) so Messages can
// route it as SMS; otherwise use an iMessage-capable handle.

import { execFile } from 'node:child_process'

// Normalize a US 10-digit number to +1XXXXXXXXXX. Leave anything already
// in +country form (or an email handle) untouched.
export function normalizeHandle(raw) {
  const s = String(raw || '').trim()
  if (!s) return s
  if (s.includes('@')) return s
  const digits = s.replace(/[^\d]/g, '')
  if (s.startsWith('+')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return s
}

const APPLESCRIPT = `on run {targetHandle, msg}
  tell application "Messages"
    try
      set svc to 1st account whose service type = iMessage
      set toRecipient to participant targetHandle of svc
      send msg to toRecipient
    on error
      -- Fallback: let Messages pick a service for the handle.
      send msg to participant targetHandle
    end try
  end tell
end run`

export function sendIMessage({ to, text, dryRun = false }) {
  const handle = normalizeHandle(to)
  if (dryRun) {
    console.log(`[dry-run] iMessage -> ${handle}: ${text}`)
    return Promise.resolve({ dryRun: true, to: handle, text })
  }
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', APPLESCRIPT, handle, text], (err, stdout, stderr) => {
      if (err) return reject(new Error(`osascript failed: ${stderr || err.message}`))
      resolve({ to: handle, text, stdout: (stdout || '').trim() })
    })
  })
}
