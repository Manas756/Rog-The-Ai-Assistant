// Owns the PowerShell speech host process: start, restart on crash (bounded),
// request/response for recognition, fire-and-forget TTS, clean shutdown.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

export type RecognizeMode = 'wake' | 'command' | 'confirm' | 'guess';

export interface RecognitionResult {
  text: string | null;
  confidence: number;
  grammar: string;
  alternates: Array<{ text: string; confidence: number }>;
  ms: number;
}

export interface GrammarSpec {
  wakeWords: string[];
  phrases: string[];
  dictationPrefixes: string[];
}

interface HostEvents {
  ready: [{ voices: string[]; recognizer: string }];
  fatal: [string];
  exit: [number | null];
  tts: [boolean];
  log: [string];
}

const RECOGNIZE_TIMEOUT_MS = 8000;

export class SpeechHost extends EventEmitter<HostEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<string, { resolve(r: RecognitionResult): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private grammar: GrammarSpec | null = null;
  private crashes: number[] = [];
  private stopping = false;
  private _ready = false;
  voices: string[] = [];

  constructor(private readonly scriptPath: string) {
    super();
  }

  get ready(): boolean {
    return this._ready;
  }

  start(): void {
    if (this.child) return;
    this.stopping = false;
    const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-File', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.emit('log', `speech host stderr: ${chunk.trim().slice(0, 500)}`));
    child.on('error', (err) => this.emit('fatal', `Couldn't start the speech engine: ${err.message}`));
    child.on('exit', (code) => this.onExit(code));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
    if (this.buf.length > 1_000_000) this.buf = ''; // never buffer unbounded garbage
  }

  private onLine(line: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      this.emit('log', `speech host: ${line.slice(0, 200)}`);
      return;
    }
    switch (ev.t) {
      case 'ready':
        this._ready = true;
        this.voices = Array.isArray(ev.voices) ? ev.voices.filter((v): v is string => typeof v === 'string') : [];
        if (this.grammar) this.send({ cmd: 'grammar', ...this.grammar });
        this.emit('ready', { voices: this.voices, recognizer: String(ev.recognizer ?? '') });
        break;
      case 'fatal':
        this.emit('fatal', String(ev.msg ?? 'speech engine failed'));
        break;
      case 'result': {
        const p = this.pending.get(String(ev.id));
        if (!p) return;
        this.pending.delete(String(ev.id));
        clearTimeout(p.timer);
        if (!ev.ok) return p.reject(new Error(String(ev.error ?? 'recognition failed')));
        p.resolve({
          text: typeof ev.text === 'string' ? ev.text : null,
          confidence: typeof ev.confidence === 'number' ? ev.confidence : 0,
          grammar: typeof ev.grammar === 'string' ? ev.grammar : '',
          alternates: Array.isArray(ev.alternates)
            ? ev.alternates.filter((a): a is { text: string; confidence: number } => typeof a?.text === 'string')
            : [],
          ms: typeof ev.ms === 'number' ? ev.ms : 0,
        });
        break;
      }
      case 'tts_start':
        this.emit('tts', true);
        break;
      case 'tts_end':
        this.emit('tts', false);
        break;
      case 'log':
      case 'error':
        this.emit('log', String(ev.msg ?? ''));
        break;
    }
  }

  private onExit(code: number | null): void {
    this.child = null;
    this._ready = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('speech engine stopped'));
    }
    this.pending.clear();
    this.emit('exit', code);
    if (this.stopping) return;
    // Restart at most 3 times per minute, then give up and report.
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 60_000);
    this.crashes.push(now);
    if (this.crashes.length <= 3) setTimeout(() => this.start(), 1000);
    else this.emit('fatal', 'The speech engine keeps stopping. Voice control is paused.');
  }

  private send(msg: Record<string, unknown>): boolean {
    if (!this.child || !this.child.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    return true;
  }

  setGrammar(spec: GrammarSpec): void {
    this.grammar = spec;
    if (this._ready) this.send({ cmd: 'grammar', ...spec });
  }

  recognize(pcm: Int16Array, mode: RecognizeMode): Promise<RecognitionResult> {
    if (!this._ready) return Promise.reject(new Error('speech engine is not ready'));
    const id = String(this.nextId++);
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('recognition timed out'));
      }, RECOGNIZE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ cmd: 'recognize', id, mode, pcm: b64 });
    });
  }

  speak(text: string, opts: { voice?: string; rate?: number; volume?: number }): void {
    this.send({ cmd: 'speak', text, ...opts });
  }

  stopSpeaking(): void {
    this.send({ cmd: 'stopSpeaking' });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    this.send({ cmd: 'shutdown' });
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
