// Bundles the Codex design kit into dist/index.es.js (ESM) and copies the
// stylesheet closure into dist/. tsc (run first, see package.json) emits the
// .d.ts tree; this script produces the runtime bundle and the CSS.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  outfile: join(dist, 'index.es.js'),
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  target: ['es2020'],
  logLevel: 'info',
});

// Ship the styles so cssEntry can point at a single compiled stylesheet.
for (const f of ['styles.css', 'tokens.css', 'components.css']) {
  copyFileSync(join(root, 'src/styles', f), join(dist, f));
}

console.log('design-kit build complete');
