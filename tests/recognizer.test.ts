import { describe, expect, it, vi } from 'vitest';
import { HybridRecognizer, cleanTranscript, splitWake, yesOrNo } from '../src/main/assistant/recognizer';
import type { SpeechPort } from '../src/main/assistant/orchestrator';
import type { RecognitionResult } from '../src/main/assistant/speechHost';
import type { Transcriber } from '../src/main/asr/whisper';

const WAKE = ['rog', 'rogue', 'hey rog', 'okay rog'];
const r = (text: string | null, grammar: string, confidence = 0.9): RecognitionResult => ({ text, grammar, confidence, alternates: [], ms: 5 });

describe('transcript helpers', () => {
  it('strips Whisper annotations', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript(' (music) Open YouTube. ')).toBe('Open YouTube.');
  });

  it('finds the wake word and its sound-alikes at the start', () => {
    expect(splitWake('Rog, open YouTube.', WAKE)).toBe('open youtube');
    expect(splitWake('Hey Rogue!', WAKE)).toBe('');
    expect(splitWake('Rock, play some music', WAKE)).toBe('play some music');
    expect(splitWake('Raj', WAKE)).toBe(''); // how Whisper actually wrote "Rog" here
    expect(splitWake('Okay, rog open notes', WAKE)).toBe('open notes');
    expect(splitWake('I think we should open YouTube', WAKE)).toBeNull();
    expect(splitWake('', WAKE)).toBeNull();
  });

  it('maps confirmations', () => {
    expect(yesOrNo('Yes, please.')).toBe('yes');
    expect(yesOrNo('Yeah go ahead')).toBe('yes');
    expect(yesOrNo("No, don't.")).toBe('no');
    expect(yesOrNo('Cancel that')).toBe('no');
    expect(yesOrNo('What was that?')).toBeNull();
  });
});

describe('HybridRecognizer', () => {
  function setup(opts: { windowsWake?: RecognitionResult; whisperText?: string; engine?: 'whisper' | 'windows'; cloud?: Transcriber | null } = {}) {
    const windows: SpeechPort = {
      ready: true,
      recognize: vi.fn(async (_p, mode) => (mode === 'wake' ? (opts.windowsWake ?? r('the weather', 'filler', 0.5)) : r('windows text', 'command'))),
      speak: vi.fn(),
      stopSpeaking: vi.fn(),
      setGrammar: vi.fn(),
    };
    const whisper: Transcriber = { ready: true, transcribe: vi.fn(async () => ({ text: opts.whisperText ?? '', ms: 400 })) };
    const rec = new HybridRecognizer(windows, whisper, () => ({ engine: opts.engine ?? 'whisper', wakeWords: WAKE, cloud: opts.cloud ?? null }));
    return { rec, windows, whisper };
  }
  const second = new Int16Array(16000);

  it('uses the cheap Windows wake result when it is confident', async () => {
    const { rec, whisper } = setup({ windowsWake: r('rog', 'wake', 0.93) });
    expect((await rec.recognize(second, 'wake')).grammar).toBe('wake');
    expect(whisper.transcribe).not.toHaveBeenCalled();
  });

  it('double-checks with Whisper when Windows missed the wake word', async () => {
    const { rec } = setup({ whisperText: 'Rog, open YouTube.' });
    expect(await rec.recognize(second, 'wake')).toMatchObject({ text: 'rog open youtube', grammar: 'wake_dictation' });
  });

  it('ignores other speech and long segments', async () => {
    const a = setup({ whisperText: 'I was just saying hello' });
    expect((await a.rec.recognize(second, 'wake')).grammar).toBe('filler');
    const b = setup({ whisperText: 'rog' });
    await b.rec.recognize(new Int16Array(16000 * 6), 'wake');
    await b.rec.recognize(new Int16Array(16000 * 3), 'wake'); // 3 s of chatter the cheap engine called filler
    expect(b.whisper.transcribe).not.toHaveBeenCalled();
    // ...but a 3 s segment the cheap engine half-matched as a wake phrase is checked.
    const c = setup({ windowsWake: r('rog open', 'wake_command', 0.5), whisperText: 'Rog, open Steam.' });
    expect((await c.rec.recognize(new Int16Array(16000 * 3), 'wake')).text).toBe('rog open steam');
  });

  it('transcribes commands with Whisper and drops silence hallucinations', async () => {
    expect(await setup({ whisperText: ' Open my notes. ' }).rec.recognize(second, 'command')).toMatchObject({ text: 'Open my notes.', grammar: 'whisper' });
    expect((await setup({ whisperText: 'Thank you.' }).rec.recognize(second, 'command')).text).toBeNull();
  });

  it('prefers the cloud transcriber when configured, falling back to local Whisper', async () => {
    const cloud: Transcriber = { ready: true, transcribe: vi.fn(async () => ({ text: 'open steam', ms: 150 })) };
    expect((await setup({ cloud }).rec.recognize(second, 'command')).text).toBe('open steam');
    const failing: Transcriber = { ready: true, transcribe: vi.fn(async () => Promise.reject(new Error('HTTP 401'))) };
    expect((await setup({ cloud: failing, whisperText: 'open steam' }).rec.recognize(second, 'command')).text).toBe('open steam');
  });

  it('falls back to the Windows engine when Whisper is off', async () => {
    const { rec, whisper } = setup({ engine: 'windows' });
    expect((await rec.recognize(second, 'command')).text).toBe('windows text');
    expect(whisper.transcribe).not.toHaveBeenCalled();
  });

  it('answers confirmations from Whisper', async () => {
    expect(await setup({ whisperText: 'Yes please' }).rec.recognize(second, 'confirm')).toMatchObject({ text: 'yes', grammar: 'confirm' });
  });
});

describe('level normalization', () => {
  it('boosts quiet speech and leaves loud speech and silence alone', async () => {
    const { normalizeLevel } = await import('../src/main/assistant/recognizer');
    const quiet = Int16Array.from({ length: 1600 }, (_, i) => Math.round(Math.sin(i / 5) * 800));
    const boosted = normalizeLevel(quiet);
    expect(Math.max(...boosted)).toBeGreaterThan(8000);
    const loud = Int16Array.from({ length: 1600 }, (_, i) => Math.round(Math.sin(i / 5) * 30000));
    expect(normalizeLevel(loud)).toBe(loud);
    const silent = new Int16Array(1600);
    expect(normalizeLevel(silent)).toBe(silent);
  });
});
