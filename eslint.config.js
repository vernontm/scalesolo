// ESLint v9 flat config. Deliberately minimal: only rules that
// catch real bugs (duplicate imports, dupe keys, undef references,
// shadowed vars, etc). Skips every style / formatting / hook-deps
// rule so the existing codebase doesn't drown in warnings and so
// CI doesn't fail on cosmetic stuff.
//
// The single thing this config exists to prevent: another
// FUNCTION_INVOCATION_FAILED at runtime from a duplicate import
// that should have been a 0.5-second lint failure at build time.

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  // Ignore generated / vendored directories
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'public/**',
      // HyperFrames marketing project trees use their own scripts +
      // CDN-loaded GSAP — lint will hit false positives on the
      // GSAP / hf-seek globals. Skip the whole subtree.
      'marketing/**',
    ],
  },

  // Base recommended config — high-signal, low-noise.
  js.configs.recommended,

  // Project-specific overrides + globals.
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2024,
        // React + JSX
        React: 'readonly',
        // Vercel Edge / fetch globals not always in `node`
        Request:  'readonly',
        Response: 'readonly',
        Headers:  'readonly',
        FormData: 'readonly',
        URL:      'readonly',
        URLSearchParams: 'readonly',
        // Web Crypto (used by api/_lib/meta-capi.js — runs on both
        // Edge and Node 20)
        crypto: 'readonly',
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // ── The class of bug we care about most ───────────────────
      // Catches `import X from 'a'; import X from 'a'` (the exact
      // crash from c845e4f) and any other duplicate-import pattern.
      'no-duplicate-imports': 'error',

      // Catches object literal `{ a: 1, a: 2 }` typos and dupe
      // function args. Both rare but always real bugs.
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-class-members': 'error',

      // Catches `let x = 1; let x = 2` re-declarations.
      'no-redeclare': 'error',

      // Identifier used but never defined. Catches typos in symbol
      // names like `consoel.log()` or referencing a deleted import.
      'no-undef': 'error',

      // Self-assignment / self-comparison / unreachable code — all
      // either bugs or dead code that the compiler should have
      // caught.
      'no-self-assign':    'error',
      'no-self-compare':   'error',
      'no-unreachable':    'error',
      'no-constant-condition': 'error',

      // Misc bug-catchers from eslint:recommended that we want to
      // keep at error level rather than warn.
      'no-control-regex':  'error',
      'no-debugger':       'error',
      'no-empty':          ['error', { allowEmptyCatch: true }],
      'no-func-assign':    'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',

      // ── Knobs we explicitly relax so the existing tree passes ─
      // (Turn any of these back to 'warn' or 'error' when you want
      //  to start cleaning up the codebase. Off for now.)
      'no-unused-vars':    'off',  // would flag thousands of legacy lines
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'off',
      'no-cond-assign':    'off',
      'no-async-promise-executor': 'off',
      'no-misleading-character-class': 'off',
      'no-fallthrough':    'off',
      'no-case-declarations': 'off',
      'no-inner-declarations': 'off',
      'no-extra-boolean-cast': 'off',
      'no-sparse-arrays':  'off',
      'getter-return':     'off',
    },
  },

  // JSX files have additional globals not present elsewhere.
  {
    files: ['**/*.jsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },

  // React Hooks plugin. Applied to BOTH .js and .jsx because the
  // codebase keeps some custom hooks (useAbortableFetch /
  // useAutosave / useUndoRedo) in plain .js files. Without this
  // the `// eslint-disable-next-line react-hooks/exhaustive-deps`
  // comments in those files error out as "rule not found."
  //
  // Both core rules off for now: the existing codebase has
  // intentional `use*` function names that aren't actually hooks
  // (e.g. Spaces.jsx::useTemplate is just an async function), and
  // legacy useEffect bodies have many missing-dep warnings we're
  // not ready to clean up. Disabling lets the disable-directives
  // resolve cleanly without flooding the build with noise.
  {
    files: ['**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks':   'off',
      'react-hooks/exhaustive-deps':  'off',
    },
  },
]
