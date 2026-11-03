// Voice pipeline integration test without Electron:
//   synthesized speech (Windows TTS -> 16 kHz WAV) -> 40 ms frames -> VAD
//   -> real PowerShell speech host -> interpreter -> policy -> executor (mock launcher)
// Run: node scripts/run-voice-e2e.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGrammar } from '../src/main/assistant/grammar';
import { Assistant } from '../src/main/assistant/orchestrator';
import { SpeechHost } from '../src/main/assistant/speechHost';
import type { Launcher } from '../src/main/actions/types';
import { DEFAULT_COMMANDS, DEFAULT_SITES } from '../src/shared/defaults';
import { commandSchema, settingsSchema } from '../src/shared/schemas';

const root = process.argv[2]!;
const dir = mkdtempSync(join(tmpdir(), 'rog-e2e-'));

function synth(name: string, text: string, voice = 'Microsoft David Desktop'): Int16Array {
  const path = join(dir, `${name}.wav`);
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('${voice}'); $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${path}', $f); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  const buf = readFileSync(path).subarray(44);
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streams PCM in real time as 40 ms frames with silence padding, like the mic worklet does. */
async function speak(assistant: Assistant, pcm: Int16Array): Promise<void> {
  const FRAME = 640;
  const noise = () => Int16Array.from({ length: FRAME }, () => (Math.random() - 0.5) * 80);
  for (let i = 0; i < 10; i++) (assistant.onAudioFrame(noise()), await sleep(40));
  for (let o = 0; o < pcm.length; o += FRAME) {
    const f = new Int16Array(FRAME);
    f.set(pcm.subarray(o, o + FRAME));
    assistant.onAudioFrame(f);
    await sleep(40);
  }
  for (let i = 0; i < 30; i++) (assistant.onAudioFrame(noise()), await sleep(40));
}

async function main() {
  let settings = settingsSchema.parse({ sites: DEFAULT_SITES, speech: { enabled: false } });
  const commands = DEFAULT_COMMANDS.map((c) => commandSchema.parse(c));
  const launched: string[] = [];
  const launcher: Launcher = {
    openUrl: async (url) => (launched.push(url), { ok: true, stage: 'started', message: 'ok', pid: 1 }),
    launchApp: async (id) => (launched.push(id), { ok: true, stage: 'started', message: 'ok', pid: 1 }),
    openFolder: async () => ({ ok: true, stage: 'requested', message: 'ok' }),
    openInEditor: async () => ({ ok: true, stage: 'started', message: 'ok' }),
    power: async (op) => (launched.push(`power:${op}`), { ok: true, stage: 'requested', message: 'ok' }),
    isKnownApp: (id) => id === 'browser-brave',
    appName: (id) => id,
  };
  const host = new SpeechHost(join(root, 'resources', 'speech', 'speech-host.ps1'));
  const assistant = new Assistant({
    settings: () => settings,
    commands: () => commands,
    installedBrowsers: () => ['brave'],
    installedEditors: () => ['vscode'],
    speech: host,
    launcher,
    llm: async (text) => ({ kind: 'unknown', text, reason: 'off' }),
    setMicOpen: () => undefined,
    updateSettings: (p) => (settings = settingsSchema.parse({ ...settings, ...(p as object) })),
    hideOrb: () => undefined,
    grammar: () => buildGrammar(settings, commands, ['brave'], ['vscode']),
  });
  const trace: string[] = [];
  assistant.machine.onChange((s, prev) => s.state !== prev && trace.push(s.state));
  assistant.on('heard', (h) => console.log(`   heard[${h.mode}] "${h.text}" grammar=${h.grammar} conf=${h.confidence} accepted=${h.accepted} (${h.ms} ms)`));

  const t0 = Date.now();
  host.start();
  await new Promise<void>((r) => host.once('ready', () => r()));
  console.log(`speech host ready in ${Date.now() - t0} ms`);
  assistant.start();
  assistant.onMicStatus({ open: true });
  await sleep(1500); // grammar load

  const cases: Array<{ name: string; utterances: string[]; expect: (l: string[]) => boolean }> = [
    { name: 'wake, then LeetCode mode', utterances: ['Rog', 'start leet code mode'], expect: (l) => l.join() === 'https://leetcode.com/,https://music.youtube.com/' },
    { name: 'one-shot open GitHub', utterances: ['Rog, open git hub'], expect: (l) => l.join() === 'https://github.com/' },
    { name: 'search template with dictation', utterances: ['Rog', 'search youtube for graph algorithms'], expect: (l) => l.length === 1 && l[0]!.startsWith('https://www.youtube.com/results?search_query=') },
    { name: 'open brave', utterances: ['Rog', 'open brave'], expect: (l) => l.join() === 'browser-brave' },
    { name: 'ordinary speech does not wake ROG', utterances: ['I think the weather is really nice today'], expect: (l) => l.length === 0 },
    { name: 'guess: loose phrasing after wake', utterances: ['Rog', 'could you please open git hub for me'], expect: (l) => l.join() === 'https://github.com/' },
    { name: 'guess: loose one-shot', utterances: ['Rog, can you play some music'], expect: (l) => l.join() === 'https://music.youtube.com/' },
    { name: 'guess: "rogue" chatter stays quiet', utterances: ['Rogue one was a great movie'], expect: (l) => l.length === 0 },
  ];

  let passed = 0;
  for (const c of cases) {
    launched.length = 0;
    trace.length = 0;
    console.log(`\n▶ ${c.name}`);
    const start = Date.now();
    for (const u of c.utterances) {
      await speak(assistant, synth(u.replace(/\W+/g, '_'), u));
      await sleep(600);
    }
    await sleep(2500);
    const ok = c.expect(launched);
    if (ok) passed++;
    console.log(`   states: ${trace.join(' → ') || '(none)'}`);
    console.log(`   launched: ${JSON.stringify(launched)}  ${ok ? 'PASS' : 'FAIL'}  (${Date.now() - start} ms incl. playback)`);
  }

  console.log(`\n${passed}/${cases.length} voice scenarios passed`);
  assistant.dispose();
  await host.stop();
  writeFileSync(join(dir, 'done'), '');
  process.exit(passed === cases.length ? 0 : 1);
}

void main();
