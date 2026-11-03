// "It can guess": second-pass dictation, containment matching, quiet one-shots.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGrammar } from '../src/main/assistant/grammar';
import { Assistant, type SpeechPort } from '../src/main/assistant/orchestrator';
import type { RecognitionResult, RecognizeMode } from '../src/main/assistant/speechHost';
import { containment, interpretLocally } from '../src/main/intent/localInterpreter';
import { defaultCommands, fakeLauncher, makeCtx, makeSettings } from './helpers';

const rec = (text: string | null, grammar: string, confidence = 0.9): RecognitionResult => ({ text, grammar, confidence, alternates: [], ms: 5 });

describe('containment matching', () => {
  it('scores sentences that contain a trigger', () => {
    expect(containment('can you start youtube now', 'start youtube')).toBeGreaterThanOrEqual(0.8);
    expect(containment('open game', 'game')).toBeGreaterThan(0.8);
    expect(containment('the game was really fun', 'game')).toBeLessThan(0.8);
    expect(containment('restart', 'start')).toBe(0); // whole words only
  });

  it('lets the interpreter run loosely phrased commands', () => {
    const ctx = makeCtx();
    const i = interpretLocally('hey could you open my notes please', { ...ctx, commands: [...ctx.commands, { id: 'notes', name: 'Notes', triggers: ['open notes'], actions: [{ type: 'speak', text: 'notes' }], enabled: true }] });
    expect(i.kind).toBe('plan');
  });
});

describe('second-pass guessing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(answers: Partial<Record<RecognizeMode, RecognitionResult>>) {
    const settings = makeSettings();
    const commands = defaultCommands();
    const { launcher, calls } = fakeLauncher();
    const modes: RecognizeMode[] = [];
    const speech: SpeechPort = {
      ready: true,
      recognize: async (_pcm, mode) => (modes.push(mode), answers[mode] ?? rec(null, '')),
      speak: () => undefined,
      stopSpeaking: () => undefined,
      setGrammar: () => undefined,
    };
    const a = new Assistant({
      settings: () => settings,
      commands: () => commands,
      installedBrowsers: () => ['brave'],
      installedEditors: () => [],
      speech,
      launcher,
      llm: async (text) => ({ kind: 'unknown', text, reason: 'off' }),
      setMicOpen: () => undefined,
      updateSettings: () => undefined,
      hideOrb: () => undefined,
      grammar: () => buildGrammar(settings, commands, ['brave'], []),
    });
    a.start();
    a.onMicStatus({ open: true });
    return { a, calls, modes };
  }

  async function speak(a: Assistant) {
    const loud = () => new Int16Array(640).map((_, i) => Math.sin(i / 3) * 8000);
    const quiet = () => new Int16Array(640);
    for (let i = 0; i < 12; i++) a.onAudioFrame(loud());
    for (let i = 0; i < 25; i++) a.onAudioFrame(quiet());
    await vi.advanceTimersByTimeAsync(10);
  }

  it('re-hears rejected commands as dictation and runs the best guess', async () => {
    const { a, calls, modes } = setup({ command: rec(null, ''), guess: rec('could you open the git hub', 'dictation', 0.4) });
    a.pushToTalk();
    await vi.advanceTimersByTimeAsync(300);
    expect(a.state).toBe('LISTENING');
    await speak(a);
    await vi.advanceTimersByTimeAsync(500);
    expect(modes).toEqual(['command', 'guess']);
    expect(calls).toEqual(['url:https://github.com/|preferred|tab']);
  });

  it('"rog <unknown words>" goes quietly back to idle', async () => {
    const { a } = setup({});
    a.onRecognition(rec('rogue one was a great movie', 'wake_dictation', 0.9), 'wake');
    await vi.advanceTimersByTimeAsync(600);
    expect(a.state).toBe('IDLE');
  });

  it('"rog <loose phrasing>" one-shot runs', async () => {
    const { a, calls } = setup({});
    a.onRecognition(rec('rog please open the github', 'wake_dictation', 0.85), 'wake');
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toEqual(['url:https://github.com/|preferred|tab']);
  });
});
