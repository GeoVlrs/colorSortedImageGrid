// The single place that touches `gifenc`.
//
// It must be imported as a default and destructured. The tempting
// `import { GIFEncoder } from 'gifenc'` throws at load time:
//
//   SyntaxError: Named export 'GIFEncoder' not found. The requested module
//   'gifenc' is a CommonJS module, which may not support all module.exports
//   as named exports.
//
// The package ships an esbuild CommonJS bundle with no `exports` map, and
// Node's cjs-module-lexer cannot see through esbuild's `__export` pattern to
// discover the names. Verified against gifenc 1.0.3 on Node 24.
//
// Isolating it here means there is exactly one line to revisit if the package
// ever ships proper ESM, instead of one per call site.

import gifenc from 'gifenc';

export const { GIFEncoder, quantize, applyPalette } = gifenc;
