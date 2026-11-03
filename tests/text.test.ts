import { describe, expect, it } from 'vitest';
import { canonical, normalizeCommand, similarity, spokenForm, stripWakeWord } from '../src/shared/text';

const WAKE = ['rog', 'rogue', 'hey rog', 'okay rog'];

describe('text normalization', () => {
  it('folds spoken variants', () => {
    expect(canonical('Open Leet Code!')).toBe('open leetcode');
    expect(canonical('search you tube for C plus plus')).toBe('search youtube for c++');
    expect(canonical('open my Rocket.Chat project')).toBe('open my rocket chat project'.replace('rocket chat', 'rocketchat'));
  });

  it('strips wake words, longest first', () => {
    expect(stripWakeWord('Hey ROG, open GitHub', WAKE)).toBe('open github');
    expect(stripWakeWord('rogue open github', WAKE)).toBe('open github');
    expect(stripWakeWord('rog', WAKE)).toBe('');
    expect(stripWakeWord('roguelike games', WAKE)).toBe('roguelike games');
  });

  it('removes politeness', () => {
    expect(normalizeCommand('rog could you please open github for me', WAKE)).toBe('open github');
  });

  it('produces recognizer-friendly spoken forms', () => {
    expect(spokenForm('Start LeetCode mode')).toBe('start leet code mode');
    expect(spokenForm('Open Rocket.Chat')).toBe('open rocket chat');
    expect(spokenForm('C++ docs')).toBe('c plus plus docs');
  });

  it('scores similarity', () => {
    expect(similarity('start leet code mode', 'start leetcode mode')).toBe(1);
    expect(similarity('start lead code mode', 'start leetcode mode')).toBeGreaterThan(0.8);
    expect(similarity('order a pizza', 'start leetcode mode')).toBeLessThan(0.5);
  });
});
