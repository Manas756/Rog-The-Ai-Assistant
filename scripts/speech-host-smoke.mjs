// Smoke test for the speech host: sends synthesized utterances through the same
// stdin protocol the Electron main process uses, and prints results + latency.
// Usage: node scripts/speech-host-smoke.mjs <dir-with-16k-mono-wavs>
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const script = join(import.meta.dirname, '..', 'resources', 'speech', 'speech-host.ps1');
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});
const t0 = Date.now();
const events = [];
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const ev = JSON.parse(line);
    events.push(ev);
    console.log(`  <- +${Date.now() - t0}ms`, JSON.stringify(ev));
  }
});

const control = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred) => { while (!events.some(pred)) await sleep(20); };

child.on('exit', () => process.exit());
await until((e) => e.t === 'ready' || e.t === 'fatal');
control({
  cmd: 'grammar',
  phrases: ['open leet code', 'start leet code mode', 'open github', 'mute yourself', 'stop listening'],
  dictationPrefixes: ['search youtube for', 'search google for'],
});
await until((e) => e.t === 'grammar_loaded');

const cases = [['wake', 'wake'], ['command', 'leet'], ['wake', 'oneshot'], ['command', 'search'], ['wake', 'noise'], ['confirm', 'yes']];
for (const [mode, file] of cases) {
  const pcm = readFileSync(join(dir, file + '.wav')).subarray(44).toString('base64');
  const id = `${mode}-${file}`;
  console.log(`-> ${id}`);
  control({ cmd: 'recognize', id, mode, pcm });
  await until((e) => e.t === 'result' && e.id === id);
}
control({ cmd: 'speak', text: 'Done. Your workspace is ready.' });
await until((e) => e.t === 'tts_end');
control({ cmd: 'shutdown' });
child.on('exit', (code) => console.log('exit', code, 'total ms', Date.now() - t0));
