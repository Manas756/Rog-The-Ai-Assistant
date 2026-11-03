// Bundles every process of the app with esbuild into dist/.
//   main      Node (Electron main process)         dist/main/index.js
//   preloads  sandboxed CommonJS                    dist/preload/*.js
//   renderers browser IIFE + static html/css        dist/renderer/**
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'dist');
const prod = process.argv.includes('--prod');
rmSync(out, { recursive: true, force: true });

const common = { bundle: true, sourcemap: prod ? false : 'linked', minify: prod, logLevel: 'warning', legalComments: 'none' };

await Promise.all([
  build({
    ...common,
    entryPoints: { index: join(root, 'src/main/index.ts'), whisperWorker: join(root, 'src/main/asr/whisperWorker.ts') },
    outdir: join(out, 'main'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // Loaded from node_modules at runtime (native ONNX Runtime binaries).
    external: ['electron', '@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web', 'sharp'],
  }),
  build({
    ...common,
    entryPoints: { orb: join(root, 'src/preload/orb.ts'), settings: join(root, 'src/preload/settings.ts') },
    outdir: join(out, 'preload'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: {
      'orb/main': join(root, 'src/renderer/orb/main.ts'),
      'settings/main': join(root, 'src/renderer/settings/main.ts'),
    },
    outdir: join(out, 'renderer'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  }),
]);

for (const page of ['orb', 'settings']) {
  mkdirSync(join(out, 'renderer', page), { recursive: true });
  for (const f of ['index.html', 'style.css']) {
    cpSync(join(root, 'src/renderer', page, f), join(out, 'renderer', page, f));
  }
}
console.log('built dist/');
