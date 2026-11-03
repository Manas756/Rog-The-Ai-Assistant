// Main-process side of the Whisper utility process: start, request/response,
// bounded restarts, shutdown.
import { utilityProcess, type UtilityProcess } from 'electron';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Transcriber {
  readonly ready: boolean;
  transcribe(pcm: Int16Array): Promise<{ text: string; ms: number }>;
}

export const WHISPER_MODEL = 'onnx-community/whisper-base.en';
const TIMEOUT_MS = 10_000;

export function whisperModelInstalled(modelDir: string): boolean {
  return existsSync(join(modelDir, ...WHISPER_MODEL.split('/'), 'onnx', 'encoder_model_quantized.onnx'));
}

export class WhisperAsr extends EventEmitter<{ ready: [{ device: string; loadMs: number }]; fatal: [string]; log: [string] }> implements Transcriber {
  private child: UtilityProcess | null = null;
  private pending = new Map<string, { resolve(v: { text: string; ms: number }): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private crashes = 0;
  private stopping = false;
  private _ready = false;
  device = '';

  constructor(
    private readonly workerPath: string,
    private readonly modelDir: string,
    private readonly device_: () => 'gpu' | 'cpu',
    private readonly prompt: () => string,
  ) {
    super();
  }

  get ready(): boolean {
    return this._ready;
  }

  start(): void {
    if (this.child) return;
    this.stopping = false;
    const child = utilityProcess.fork(this.workerPath, [], { serviceName: 'ROG speech recognition (Whisper)', stdio: 'pipe' });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => this.emit('log', `whisper: ${d.toString().trim().slice(0, 300)}`));
    child.on('message', (m: { type: string; [k: string]: unknown }) => this.onMessage(m));
    child.on('exit', () => this.onExit());
    child.postMessage({ type: 'load', modelDir: this.modelDir, model: WHISPER_MODEL, device: this.device_(), prompt: this.prompt() });
  }

  private onMessage(m: { type: string; [k: string]: unknown }): void {
    if (m.type === 'ready') {
      this._ready = true;
      this.device = String(m.device);
      this.emit('ready', { device: this.device, loadMs: Number(m.loadMs) });
    } else if (m.type === 'fatal') {
      this.emit('fatal', String(m.msg));
    } else if (m.type === 'result') {
      const p = this.pending.get(String(m.id));
      if (!p) return;
      this.pending.delete(String(m.id));
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String(m.error)));
      else p.resolve({ text: String(m.text ?? ''), ms: Number(m.ms ?? 0) });
    }
  }

  private onExit(): void {
    this.child = null;
    this._ready = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('speech recognizer stopped'));
    }
    this.pending.clear();
    if (this.stopping) return;
    if (++this.crashes <= 3) setTimeout(() => this.start(), 1500);
    else this.emit('fatal', 'Whisper keeps stopping; using the Windows speech engine instead.');
  }

  transcribe(pcm: Int16Array): Promise<{ text: string; ms: number }> {
    if (!this._ready || !this.child) return Promise.reject(new Error('Whisper is not ready'));
    const id = String(this.nextId++);
    const copy = pcm.slice().buffer; // own buffer, safe to transfer
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('transcription timed out'));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.postMessage({ type: 'transcribe', id, pcm: copy });
    });
  }

  /** Vocabulary prompt (wake word + command words); takes effect on the next utterance. */
  updatePrompt(): void {
    this.child?.postMessage({ type: 'prompt', prompt: this.prompt() });
  }

  /** Restart with a different device (GPU/CPU). */
  restart(): void {
    this.stop();
    this.crashes = 0;
    setTimeout(() => this.start(), 300);
  }

  stop(): void {
    this.stopping = true;
    this._ready = false;
    this.child?.kill();
    this.child = null;
  }
}
