import { describe, expect, it } from 'vitest';
import { Vad } from '../src/main/assistant/vad';
import { STATES, StateMachine, canTransition } from '../src/shared/stateMachine';

describe('state machine', () => {
  it('follows the voice flow', () => {
    const m = new StateMachine();
    for (const s of ['WAKE_DETECTED', 'LISTENING', 'PROCESSING', 'EXECUTING', 'SUCCESS', 'IDLE'] as const) {
      expect(m.transition(s)).toBe(true);
    }
  });

  it('rejects impossible transitions and leaves state unchanged', () => {
    const m = new StateMachine();
    expect(m.transition('SUCCESS')).toBe(false);
    expect(m.transition('CONFIRMING')).toBe(false);
    expect(m.state).toBe('IDLE');
    expect(canTransition('EXECUTING', 'LISTENING')).toBe(false);
    expect(canTransition('MUTED', 'SUCCESS')).toBe(false);
  });

  it('can always mute', () => {
    for (const s of STATES) expect(canTransition(s, 'MUTED'), s).toBe(true);
  });

  it('notifies listeners with snapshots and increments seq', () => {
    const m = new StateMachine();
    const seen: string[] = [];
    m.onChange((snap, prev) => seen.push(`${prev}->${snap.state}:${snap.label ?? ''}`));
    m.transition('WAKE_DETECTED');
    m.transition('LISTENING', { label: 'hi' });
    m.patch({ micActive: true });
    expect(seen).toEqual(['IDLE->WAKE_DETECTED:', 'WAKE_DETECTED->LISTENING:hi', 'LISTENING->LISTENING:hi']);
    expect(m.snapshot.seq).toBe(3);
    expect(m.snapshot.micActive).toBe(true);
  });
});

describe('voice activity detection', () => {
  const FRAME = 640; // 40 ms
  const silence = () => new Int16Array(FRAME).map(() => (Math.random() - 0.5) * 60);
  const speech = (amp = 6000) => new Int16Array(FRAME).map((_, i) => Math.sin(i / 3) * amp + (Math.random() - 0.5) * 400);

  function run(vad: Vad, frames: Int16Array[]) {
    return frames.flatMap((f) => vad.push(f));
  }

  it('stays quiet on silence', () => {
    const vad = new Vad({ sensitivity: 0.5, endSilenceMs: 450 });
    expect(run(vad, Array.from({ length: 50 }, silence))).toEqual([]);
  });

  it('emits one utterance with pre-roll for speech followed by silence', () => {
    const vad = new Vad({ sensitivity: 0.5, endSilenceMs: 400 });
    const events = run(vad, [...Array.from({ length: 20 }, silence), ...Array.from({ length: 15 }, () => speech()), ...Array.from({ length: 15 }, silence)]);
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_end']);
    const end = events[1]!;
    if (end.type !== 'speech_end') throw new Error();
    // 15 speech frames + pre-roll (~300 ms) + trailing silence
    expect(end.durationMs).toBeGreaterThan(15 * 40 + 200);
    expect(end.pcm.length).toBeGreaterThan(15 * FRAME);
  });

  it('discards clicks that are too short to be words', () => {
    const vad = new Vad({ sensitivity: 0.5, endSilenceMs: 200, minSpeechMs: 200 });
    const events = run(vad, [...Array.from({ length: 10 }, silence), speech(), speech(), ...Array.from({ length: 10 }, silence)]);
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_discarded']);
  });

  it('caps utterance length, then learns continuous sound (music) as background', () => {
    const vad = new Vad({ sensitivity: 0.5, endSilenceMs: 400, maxUtteranceMs: 2000 });
    const music = () => speech(1500);
    const events = run(vad, Array.from({ length: 150 }, music));
    // One capped segment, then the constant sound no longer counts as speech.
    expect(events.filter((e) => e.type === 'speech_end')).toHaveLength(1);
    // Speech clearly louder than the learned background still triggers.
    const louder = run(vad, [...Array.from({ length: 15 }, () => speech(12000)), ...Array.from({ length: 30 }, () => silence())]);
    expect(louder.map((e) => e.type)).toContain('speech_start');
  });

  it('adapts to steady background noise', () => {
    const vad = new Vad({ sensitivity: 0.5, endSilenceMs: 400 });
    const hum = () => new Int16Array(FRAME).map((_, i) => Math.sin(i / 5) * 300);
    const before = vad.threshold;
    run(vad, Array.from({ length: 200 }, hum));
    expect(vad.threshold).toBeGreaterThan(before);
  });
});
