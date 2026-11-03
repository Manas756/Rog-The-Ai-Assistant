// End-to-end pipeline tests with a fake speech engine and a fake launcher.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGrammar } from '../src/main/assistant/grammar';
import { Assistant, type SpeechPort } from '../src/main/assistant/orchestrator';
import type { RecognitionResult } from '../src/main/assistant/speechHost';
import type { Interpretation } from '../src/main/intent/types';
import type { Settings } from '../src/shared/schemas';
import { deepMerge } from '../src/main/storage/stores';
import { defaultCommands, fakeLauncher, makeSettings } from './helpers';

const rec = (text: string | null, grammar: string, confidence = 0.9): RecognitionResult => ({ text, grammar, confidence, alternates: [], ms: 20 });

function setup(opts: { llm?: Interpretation; settings?: Settings } = {}) {
  let settings = opts.settings ?? makeSettings();
  const { launcher, calls } = fakeLauncher();
  const spoken: string[] = [];
  const micOpen: boolean[] = [];
  const speech: SpeechPort = {
    ready: true,
    recognize: vi.fn(),
    speak: (t) => void spoken.push(t),
    stopSpeaking: vi.fn(),
    setGrammar: vi.fn(),
  };
  const commands = defaultCommands();
  const llm = vi.fn(async (): Promise<Interpretation> => opts.llm ?? { kind: 'unknown', text: '', reason: 'off' });
  const assistant = new Assistant({
    settings: () => settings,
    commands: () => commands,
    installedBrowsers: () => ['brave'],
    installedEditors: () => ['vscode'],
    speech,
    launcher,
    llm,
    setMicOpen: (o) => void micOpen.push(o),
    updateSettings: (p) => (settings = deepMerge(settings, p)),
    hideOrb: vi.fn(),
    grammar: () => buildGrammar(settings, commands, ['brave'], ['vscode']),
  });
  const states: string[] = [];
  assistant.machine.onChange((s, prev) => s.state !== prev && states.push(s.state));
  assistant.start();
  assistant.onMicStatus({ open: true });
  return { assistant, calls, spoken, states, micOpen, llm, settings: () => settings };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('assistant pipeline', () => {
  it('wake word -> listening -> LeetCode mode -> success -> idle', async () => {
    const { assistant, calls, spoken, states } = setup();
    assistant.onRecognition(rec('rog', 'wake', 0.95), 'wake');
    expect(assistant.state).toBe('WAKE_DETECTED');
    await vi.advanceTimersByTimeAsync(400);
    expect(assistant.state).toBe('LISTENING');

    assistant.onRecognition(rec('start leet code mode', 'command'), 'command');
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual(['url:https://leetcode.com/|preferred|tab', 'url:https://music.youtube.com/|preferred|tab']);
    expect(assistant.state).toBe('SUCCESS');
    expect(spoken).toContain('LeetCode mode is ready. Good luck.');

    await vi.advanceTimersByTimeAsync(2000);
    expect(assistant.state).toBe('IDLE');
    expect(states).toEqual(['WAKE_DETECTED', 'LISTENING', 'PROCESSING', 'EXECUTING', 'SUCCESS', 'IDLE']);
  });

  it('handles one-shot "rog open github"', async () => {
    const { assistant, calls } = setup();
    assistant.onRecognition(rec('rog open git hub', 'wake_command', 0.9), 'wake');
    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toEqual(['url:https://github.com/|preferred|tab']);
  });

  it('ignores low-confidence and filler wake results', async () => {
    const { assistant } = setup();
    assistant.onRecognition(rec('rog', 'wake', 0.3), 'wake');
    assistant.onRecognition(rec('the weather is nice', 'filler', 0.99), 'wake');
    expect(assistant.state).toBe('IDLE');
  });

  it('wake sensitivity changes the threshold', () => {
    const strict = setup({ settings: makeSettings({ voice: { wakeSensitivity: 0 } }) });
    const lenient = setup({ settings: makeSettings({ voice: { wakeSensitivity: 1 } }) });
    expect(strict.assistant.wakeThreshold()).toBeGreaterThan(lenient.assistant.wakeThreshold());
  });

  it('times out back to idle when nothing is said', async () => {
    const { assistant } = setup();
    assistant.pushToTalk();
    await vi.advanceTimersByTimeAsync(400);
    expect(assistant.state).toBe('LISTENING');
    await vi.advanceTimersByTimeAsync(7100);
    expect(assistant.state).toBe('IDLE');
  });

  it('push-to-talk toggles: second press cancels', async () => {
    const { assistant } = setup();
    assistant.pushToTalk();
    await vi.advanceTimersByTimeAsync(400);
    assistant.pushToTalk();
    expect(assistant.state).toBe('IDLE');
  });

  it('gives one retry, then a spoken error, on unrecognized speech', async () => {
    const { assistant, spoken } = setup();
    assistant.pushToTalk();
    await vi.advanceTimersByTimeAsync(400);
    assistant.onRecognition(rec(null, ''), 'command');
    expect(assistant.state).toBe('LISTENING');
    assistant.onRecognition(rec(null, ''), 'command');
    expect(assistant.state).toBe('ERROR');
    expect(spoken.at(-1)).toMatch(/didn't catch/);
    await vi.advanceTimersByTimeAsync(3000);
    expect(assistant.state).toBe('IDLE');
  });

  it('unknown commands end in a helpful error without executing anything', async () => {
    const { assistant, calls, spoken } = setup();
    void assistant.runText('order a pizza');
    await vi.advanceTimersByTimeAsync(400);
    expect(assistant.state).toBe('ERROR');
    expect(calls).toEqual([]);
    expect(spoken.at(-1)).toMatch(/don't know/);
  });

  it('asks "did you mean" and runs after a spoken yes', async () => {
    const { assistant, calls } = setup();
    void assistant.runText('start leet mode');
    await vi.advanceTimersByTimeAsync(400);
    expect(assistant.state).toBe('CONFIRMING');
    assistant.onRecognition(rec('yes', 'confirm'), 'confirm');
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(2);
  });

  it('cancels on "no" and on confirmation timeout', async () => {
    const a = setup();
    void a.assistant.runText('start leet mode');
    await vi.advanceTimersByTimeAsync(400);
    a.assistant.onRecognition(rec('no', 'confirm'), 'confirm');
    expect(a.assistant.state).toBe('IDLE');
    expect(a.calls).toEqual([]);

    const b = setup();
    void b.assistant.runText('start leet mode');
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(9000);
    expect(b.assistant.state).toBe('IDLE');
    expect(b.calls).toEqual([]);
  });

  it('uses the LLM only for unknown requests, and confirms its plans', async () => {
    const llmPlan: Interpretation = {
      kind: 'plan',
      plan: { label: 'Open docs', actions: [{ type: 'open_url', url: 'https://docs.python.org/', browser: 'preferred', newWindow: false }], source: 'llm', confidence: 0.8 },
    };
    const { assistant, calls, llm } = setup({ llm: llmPlan, settings: makeSettings({ llm: { enabled: true } }) });
    void assistant.runText('open github');
    await vi.advanceTimersByTimeAsync(2500);
    expect(llm).not.toHaveBeenCalled();

    void assistant.runText('show me the python documentation');
    await vi.advanceTimersByTimeAsync(400);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(assistant.state).toBe('CONFIRMING');
    expect(calls).toEqual(['url:https://github.com/|preferred|tab']);
    assistant.confirm(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.at(-1)).toBe('url:https://docs.python.org/|preferred|tab');
  });

  it('"stop listening" mutes the microphone after the success ring', async () => {
    const { assistant, micOpen, settings } = setup();
    void assistant.runText('stop listening');
    await vi.advanceTimersByTimeAsync(400);
    expect(settings().voice.monitoring).toBe(false);
    expect(micOpen.at(-1)).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(assistant.state).toBe('MUTED');
  });

  it('ignores wake words while the microphone is off', async () => {
    const { assistant } = setup();
    assistant.setMonitoring(false);
    expect(assistant.state).toBe('MUTED');
    const frame = new Int16Array(640).fill(8000);
    for (let i = 0; i < 50; i++) assistant.onAudioFrame(frame);
    expect(assistant.state).toBe('MUTED');
  });

  it('reports the current/last command', async () => {
    const { assistant, spoken } = setup();
    void assistant.runText('open github');
    await vi.advanceTimersByTimeAsync(2500);
    void assistant.runText('what command are you executing');
    await vi.advanceTimersByTimeAsync(400);
    expect(spoken.at(-1)).toBe('The last command was Open GitHub. It finished.');
  });

  it('moves to MUTED with a message when the microphone fails', () => {
    const { assistant } = setup();
    assistant.onMicStatus({ open: false, error: 'No microphone found.' });
    expect(assistant.state).toBe('MUTED');
    expect(assistant.machine.snapshot.label).toBe('No microphone found.');
  });
});
