// Pre-bundle the Solana payout helpers into ONE self-contained ESM file.
//
// Why: @solana/web3.js pulls in jayson, rpc-websockets, node-fetch and native
// addons that use dynamic requires. Vercel's serverless file tracer misses
// some of those, so importing the raw package crashed the function on their
// runtime (FUNCTION_INVOCATION_FAILED) even though it works locally. Bundling
// everything into api/_lib/solana.bundle.mjs removes all external node_modules
// from the trace, so the function is self-contained.
//
// Runs from `prebuild` (so Vercel regenerates it on every deploy) and can be
// run by hand with `npm run bundle:solana` after bumping the @solana packages.
// The output is committed too, as a belt-and-suspenders so the file is always
// present for the function tracer.
import { build } from 'esbuild'

// createRequire + __filename/__dirname shims: the bundled CJS deps reference
// require()/__filename, which do not exist in an ESM output on their own.
const banner = [
  "import { createRequire as __cr } from 'module';",
  "import { fileURLToPath as __fp } from 'url';",
  "import { dirname as __dp } from 'path';",
  'const require = __cr(import.meta.url);',
  'const __filename = __fp(import.meta.url);',
  'const __dirname = __dp(__filename);',
].join(' ')

await build({
  entryPoints: ['api/_lib/solana.js'],
  outfile: 'api/_lib/solana.bundle.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Optional native accelerators for `ws`; they have pure-JS fallbacks, so keep
  // them external rather than trying to bundle .node binaries.
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: banner },
  legalComments: 'none',
  logLevel: 'info',
})

console.log('bundled api/_lib/solana.js -> api/_lib/solana.bundle.mjs')
