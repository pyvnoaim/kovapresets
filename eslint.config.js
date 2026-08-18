// Three environments in one repo: main/core is Node, the renderer is a browser
// page with no Node access, and preload straddles both. Splitting them is the
// point of linting here - it's what catches a `require` that sneaked into the
// renderer, where it would be undefined at runtime.
const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  {
    // main process, core logic, release script
    files: ['src/main.js', 'src/core/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    // preload runs in Node but is handed to a browser context
    files: ['src/preload.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
  },
  {
    // renderer.js and hud.js are two classic <script> tags sharing one global
    // scope, so each one's top-level functions are the other's globals. Listing
    // that shared surface here is what keeps no-undef useful (it still catches
    // typos); add a name when a new one genuinely crosses the file boundary.
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        kova: 'readonly', // the preload bridge
        $: 'readonly',
        esc: 'readonly',
        toast: 'readonly',
        appConfirm: 'readonly',
        refresh: 'readonly',
        current: 'writable',
        hud: 'readonly',
      },
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      // `catch {}` is used deliberately where "it didn't work" is the handling
      // (best-effort cleanup, log writes that must never throw)
      'no-empty': ['error', { allowEmptyCatch: true }],
      // BOM strips are written as a literal BOM inside a regex, on purpose
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
      // the renderer's shared globals above are declared in one of the two
      // files; redeclaring within a file is still an error
      'no-redeclare': ['error', { builtinGlobals: false }],
    },
  },
]
