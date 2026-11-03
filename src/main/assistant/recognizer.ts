// Chooses the right speech engine per utterance.
//
//   wake    Windows grammar spotter first (cheap). If it didn't hear "rog" and the
//           segment is short, Whisper double-checks: the old engine often mishears
//           real voices, Whisper rarely does.
//   command Whisper (local, GPU/CPU) - or the optional cloud transcriber - then the
//           normal interpreter. The Windows dictation engine is only a fallback.
//   confirm Whisper, mapped to yes / no.
//
// Implements the same SpeechPort the orchestrator already uses.
import { canonical } from '../../shared/text';
import type { Transcriber } from '../asr/whisper';
import type { SpeechPort } from './orchestrator';
import type { GrammarSpec, RecognitionResult, RecognizeMode } from './speechHost';

export interface RecognizerOptions {
  engine: 'whisper' | 'windows';
  wakeWords: string[];
  /** Optional cloud transcription for commands (e.g. Groq). Null when off. */
  cloud: Transcriber | null;
  /** Whisper's vocabulary prompt, to spot it being echoed back on near-silence. */
  prompt?: string;
}

/** Ways Whisper writes "rog" at the start of an utterance. */
// "Raj" is what Whisper most often writes for a spoken "Rog" (measured on this PC).
const WAKE_SOUNDALIKES = [
  'rog', 'rogue', 'rogg', 'roge', 'rogh', 'rodge', 'roj', 'rouge', 'rock', 'rok', 'rug', 'rag',
  'raj', 'raaj', 'rajj', 'raag', 'roque', 'rode', 'rob', 'roh', 'rough',
];
const LEADING_FILLER = new Set(['hey', 'hi', 'ok', 'okay', 'oh', 'so', 'yo', 'um', 'uh']);
const YES = ['yes', 'yeah', 'yep', 'yup', 'sure', 'do it', 'go ahead', 'confirm', 'okay', 'ok', 'correct', 'right'];
const NO = ['no', 'nope', 'cancel', 'stop', 'never mind', 'dont', 'don t'];

/** Whisper's well-known outputs for silence or noise. */
const HALLUCINATIONS = new Set(['', 'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'bye', 'okay', 'so', 'the']);

export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ') // [BLANK_AUDIO], (music), *coughs*
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * If a Whisper transcript starts with the wake word (or a sound-alike), returns the
 * rest of the utterance ("" when it was just "rog"); otherwise null.
 */
export function splitWake(transcript: string, wakeWords: string[]): string | null {
  const words = canonical(transcript).split(' ').filter(Boolean);
  while (words.length && LEADING_FILLER.has(words[0]!)) words.shift();
  if (!words.length) return null;
  const single = new Set([...WAKE_SOUNDALIKES, ...wakeWords.map((w) => canonical(w)).filter((w) => !w.includes(' '))]);
  if (!single.has(words[0]!)) return null;
  return words.slice(1).join(' ');
}

export function yesOrNo(transcript: string): 'yes' | 'no' | null {
  const t = ` ${canonical(transcript).replace(/'/g, ' ')} `;
  if (NO.some((w) => t.includes(` ${w} `))) return 'no';
  if (YES.some((w) => t.includes(` ${w} `))) return 'yes';
  return null;
}

/**
 * Brings quiet speech up to a healthy level (peak ≈ -3 dBFS, at most 16x gain) so
 * both recognizers hear a soft voice as clearly as a loud one.
 */
export function normalizeLevel(pcm: Int16Array): Int16Array {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i]!);
    if (v > peak) peak = v;
  }
  if (peak < 50) return pcm; // digital silence: amplifying would only add noise
  const gain = Math.min(16, (0.7 * 32767) / peak);
  if (gain < 1.2) return pcm;
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i]! * gain)));
  return out;
}

/** Whisper sometimes repeats its prompt when it hears nothing useful. */
export function echoesPrompt(text: string, prompt?: string): boolean {
  if (!prompt) return false;
  const t = canonical(text);
  return t.split(' ').length >= 6 && canonical(prompt).includes(t);
}

const result = (text: string | null, grammar: string, confidence: number, ms: number): RecognitionResult => ({ text, grammar, confidence, alternates: [], ms });

export class HybridRecognizer implements SpeechPort {
  constructor(
    private readonly windows: SpeechPort,
    private readonly whisper: Transcriber,
    private readonly opts: () => RecognizerOptions,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  get ready(): boolean {
    return this.windows.ready || this.whisper.ready;
  }

  private useWhisper(): boolean {
    return this.opts().engine === 'whisper' && this.whisper.ready;
  }

  /** Accurate transcription: cloud (if configured) -> local Whisper -> null. */
  private async transcribe(pcm: Int16Array): Promise<{ text: string; ms: number } | null> {
    const cloud = this.opts().cloud;
    if (cloud?.ready) {
      try {
        return await cloud.transcribe(pcm);
      } catch (err) {
        this.log(`cloud transcription failed, using local: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!this.useWhisper()) return null;
    return this.whisper.transcribe(pcm);
  }

  async recognize(raw: Int16Array, mode: RecognizeMode): Promise<RecognitionResult> {
    const pcm = normalizeLevel(raw);
    const seconds = pcm.length / 16000;
    switch (mode) {
      case 'wake': {
        const quick = this.windows.ready ? await this.windows.recognize(pcm, 'wake') : null;
        if (quick && quick.grammar.startsWith('wake') && quick.confidence >= 0.75) return quick;
        // Double-check only what could be "rog" / "rog <short command>": short segments,
        // or ones the cheap engine half-matched. Long chatter never reaches Whisper,
        // which keeps idle CPU down in a talkative room.
        const plausible = seconds <= 2.5 || (quick?.grammar.startsWith('wake') ?? false);
        if (!this.useWhisper() || !plausible || seconds > 4) return quick ?? result(null, '', 0, 0);
        const t = await this.whisper.transcribe(pcm);
        const text = cleanTranscript(t.text);
        const rest = splitWake(text, this.opts().wakeWords);
        this.log(`whisper wake check: "${text}" (${t.ms} ms) -> ${rest === null ? 'not for ROG' : 'wake'}`);
        if (rest === null) return result(text || null, 'filler', 0.9, t.ms);
        return rest ? result(`rog ${rest}`, 'wake_dictation', 0.9, t.ms) : result('rog', 'wake', 0.9, t.ms);
      }
      case 'command': {
        const t = await this.transcribe(pcm);
        if (!t) return this.windows.recognize(pcm, 'command');
        const text = cleanTranscript(t.text);
        if (HALLUCINATIONS.has(canonical(text)) || echoesPrompt(text, this.opts().prompt)) return result(null, 'whisper', 0, t.ms);
        return result(text, 'whisper', 0.95, t.ms);
      }
      case 'guess':
        // Whisper already transcribed freely; a second pass would only repeat it.
        return this.useWhisper() ? result(null, '', 0, 0) : this.windows.recognize(pcm, 'guess');
      case 'confirm': {
        if (!this.useWhisper()) return this.windows.recognize(pcm, 'confirm');
        const t = await this.whisper.transcribe(pcm);
        const answer = yesOrNo(cleanTranscript(t.text));
        return answer ? result(answer, 'confirm', 0.95, t.ms) : result(cleanTranscript(t.text) || null, 'confirm_filler', 0.5, t.ms);
      }
    }
  }

  speak(text: string, opts: { voice?: string; rate?: number; volume?: number }): void {
    this.windows.speak(text, opts);
  }

  stopSpeaking(): void {
    this.windows.stopSpeaking();
  }

  setGrammar(spec: GrammarSpec): void {
    this.windows.setGrammar(spec);
  }
}
