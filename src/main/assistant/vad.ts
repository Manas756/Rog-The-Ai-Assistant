// Energy-based voice activity detection over 16 kHz / 16-bit mono frames.
//
// This is Stage A's cheap front end: it runs on every 40 ms frame (a few
// hundred multiply-adds), while the speech engine only runs once per finished
// utterance. The noise floor adapts while nobody is speaking, so the detector
// works in both quiet rooms and noisy ones.

export const SAMPLE_RATE = 16_000;

export interface VadOptions {
  /** 0 = only loud speech, 1 = picks up quiet speech. */
  sensitivity: number;
  /** Silence needed to end an utterance. Shorter in wake mode for snappy wakes. */
  endSilenceMs: number;
  preRollMs?: number;
  maxUtteranceMs?: number;
  minSpeechMs?: number;
}

export type VadEvent =
  | { type: 'speech_start' }
  | { type: 'speech_end'; pcm: Int16Array; durationMs: number }
  /** Speech too short to be a word (a click, a cough): discarded. */
  | { type: 'speech_discarded' };

export function frameRms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

export class Vad {
  private opts: Required<VadOptions>;
  private noiseFloor = 120;
  private speaking = false;
  private onsetFrames = 0;
  private silenceMs = 0;
  private speechMs = 0;
  private preRoll: Int16Array[] = [];
  private preRollMsHeld = 0;
  private utterance: Int16Array[] = [];
  private utteranceMs = 0;
  private frameRms: number[] = [];

  constructor(opts: VadOptions) {
    this.opts = { preRollMs: 300, maxUtteranceMs: 10_000, minSpeechMs: 160, ...opts };
  }

  configure(opts: Partial<VadOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Current start threshold in raw int16 RMS units (exposed for the mic test UI). */
  get threshold(): number {
    const s = Math.min(1, Math.max(0, this.opts.sensitivity));
    const ratio = 3.0 - 1.4 * s; // how far above the noise floor speech must be
    // Absolute minimum (int16 RMS, AGC off). Measured on this laptop: silence ~40,
    // room chatter 200-600, a voice at normal distance from ~300 up. Kept low so
    // quiet speech isn't missed; recognition rejects what isn't for ROG.
    const minimum = 400 - 260 * s;
    return Math.max(minimum, this.noiseFloor * ratio);
  }

  reset(): void {
    this.speaking = false;
    this.onsetFrames = 0;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.preRoll = [];
    this.preRollMsHeld = 0;
    this.utterance = [];
    this.utteranceMs = 0;
  }

  push(frame: Int16Array): VadEvent[] {
    const ms = (frame.length / SAMPLE_RATE) * 1000;
    const rms = frameRms(frame);
    const events: VadEvent[] = [];
    const start = this.threshold;
    // Hysteresis: easier to continue than to start, but never down into the noise.
    const keep = Math.max(start * 0.5, this.noiseFloor * 2);

    if (!this.speaking) {
      // Adapt to background noise only while nobody is talking.
      if (rms < start) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      this.preRoll.push(frame);
      this.preRollMsHeld += ms;
      while (this.preRollMsHeld > this.opts.preRollMs && this.preRoll.length > 1) {
        const dropped = this.preRoll.shift()!;
        this.preRollMsHeld -= (dropped.length / SAMPLE_RATE) * 1000;
      }
      this.onsetFrames = rms >= start ? this.onsetFrames + 1 : 0;
      if (this.onsetFrames >= 2) {
        this.frameRms = [];
        this.speaking = true;
        this.utterance = [...this.preRoll];
        this.utteranceMs = this.preRollMsHeld;
        this.preRoll = [];
        this.preRollMsHeld = 0;
        this.speechMs = ms * this.onsetFrames;
        this.silenceMs = 0;
        events.push({ type: 'speech_start' });
      }
      return events;
    }

    this.utterance.push(frame);
    this.utteranceMs += ms;
    this.frameRms.push(rms);
    if (rms >= keep) {
      this.speechMs += ms;
      this.silenceMs = 0;
    } else {
      this.silenceMs += ms;
    }

    const ended = this.silenceMs >= this.opts.endSilenceMs;
    const tooLong = this.utteranceMs >= this.opts.maxUtteranceMs;
    if (ended || tooLong) {
      if (tooLong) {
        // Never-ending "speech" is almost always music or a noisy room: learn it as
        // the new floor so the next segment needs to be clearly louder.
        const sorted = [...this.frameRms].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        this.noiseFloor = Math.max(this.noiseFloor, median * 0.8);
      }
      const pcm = concat(this.utterance);
      const durationMs = this.utteranceMs;
      const speechMs = this.speechMs;
      this.reset();
      events.push(speechMs >= this.opts.minSpeechMs ? { type: 'speech_end', pcm, durationMs } : { type: 'speech_discarded' });
    }
    return events;
  }
}

function concat(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
