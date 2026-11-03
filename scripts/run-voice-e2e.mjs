// Bundles scripts/voice-e2e.ts for Node and runs it.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dirname, '..');
const out = join(tmpdir(), 'rog-voice-e2e.cjs');
await build({ entryPoints: [join(root, 'scripts/voice-e2e.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning' });
const r = spawnSync(process.execPath, [out, root], { stdio: 'inherit' });
process.exit(r.status ?? 1);
