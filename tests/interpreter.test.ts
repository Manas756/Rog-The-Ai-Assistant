import { describe, expect, it } from 'vitest';
import { interpretLocally } from '../src/main/intent/localInterpreter';
import type { Interpretation } from '../src/main/intent/types';
import { makeCtx } from './helpers';

const plan = (i: Interpretation) => {
  if (i.kind !== 'plan') throw new Error(`expected plan, got ${i.kind}: ${JSON.stringify(i)}`);
  return i.plan;
};

describe('local command interpretation', () => {
  const ctx = makeCtx();

  it('matches built-in commands from trigger phrases (with wake word and spoken forms)', () => {
    const p = plan(interpretLocally('rog start leet code mode', ctx));
    expect(p.commandId).toBe('leetcode-mode');
    expect(p.actions).toEqual([{ type: 'workflow', workflowId: 'leetcode' }]);
    expect(plan(interpretLocally('start my LeetCode session', ctx)).commandId).toBe('leetcode-mode');
  });

  it('opens configured websites', () => {
    const p = plan(interpretLocally('open leet code', ctx));
    expect(p.actions[0]).toMatchObject({ type: 'open_url', url: 'https://leetcode.com/' });
    expect(plan(interpretLocally('ROG, open YouTube Music.', ctx)).actions[0]).toMatchObject({ url: 'https://music.youtube.com/' });
    expect(plan(interpretLocally('go to github', ctx)).actions[0]).toMatchObject({ url: 'https://github.com/' });
  });

  it('opens projects by name or alias', () => {
    expect(plan(interpretLocally('open my rocket chat project', ctx)).actions[0]).toEqual({ type: 'open_project', projectId: 'rocketchat', editor: 'preferred' });
    expect(plan(interpretLocally('open rc', ctx)).actions[0]).toMatchObject({ projectId: 'rocketchat' });
  });

  it('opens detected browsers and approved apps', () => {
    expect(plan(interpretLocally('open brave', ctx)).actions[0]).toEqual({ type: 'open_app', appId: 'browser-brave' });
    expect(plan(interpretLocally('launch spotify', ctx)).actions[0]).toEqual({ type: 'open_app', appId: 'spotify' });
    expect(plan(interpretLocally('open vs code', ctx)).actions[0]).toEqual({ type: 'open_app', appId: 'editor-vscode' });
  });

  it('parses web searches in several phrasings', () => {
    expect(plan(interpretLocally('search youtube for c plus plus graph algorithms', ctx)).actions[0]).toEqual({
      type: 'web_search',
      engine: 'youtube',
      query: 'c++ graph algorithms',
      browser: 'preferred',
    });
    expect(plan(interpretLocally('search for dijkstra on github', ctx)).actions[0]).toMatchObject({ engine: 'github', query: 'dijkstra' });
    expect(plan(interpretLocally('google segment trees', ctx)).actions[0]).toMatchObject({ engine: 'google', query: 'segment trees' });
    expect(plan(interpretLocally('search youtube music for lofi', ctx)).actions[0]).toMatchObject({ engine: 'youtube_music', query: 'lofi' });
  });

  it('maps assistant controls', () => {
    expect(plan(interpretLocally('mute yourself', ctx)).actions[0]).toEqual({ type: 'assistant', op: 'mute_voice' });
    expect(plan(interpretLocally('stop listening', ctx)).actions[0]).toEqual({ type: 'assistant', op: 'stop_listening' });
    expect(plan(interpretLocally('what command are you executing', ctx)).actions[0]).toEqual({ type: 'assistant', op: 'status' });
  });

  it('asks for clarification on near misses', () => {
    const i = interpretLocally('start leet mode', ctx);
    expect(i.kind).toBe('clarify');
    if (i.kind === 'clarify') expect(i.prompt).toContain('LeetCode mode');
  });

  it('reports unknown requests instead of guessing', () => {
    expect(interpretLocally('order me a pizza', ctx).kind).toBe('unknown');
    expect(interpretLocally('open the pod bay doors', ctx).kind).toBe('unknown');
    expect(interpretLocally('rog', ctx).kind).toBe('unknown');
  });

  it('never turns speech into a shell command', () => {
    for (const text of ['run cmd del /s c:\\', 'open powershell -c rm -rf', 'execute format c:']) {
      const i = interpretLocally(text, ctx);
      if (i.kind === 'plan') {
        for (const a of i.plan.actions) expect(['open_url', 'web_search', 'open_app', 'open_project', 'assistant', 'workflow']).toContain(a.type);
      }
    }
  });

  it('ignores disabled commands', () => {
    const c = makeCtx();
    c.commands = c.commands.map((x) => (x.id === 'leetcode-mode' ? { ...x, enabled: false } : x));
    expect(interpretLocally('start leetcode mode', c).kind).not.toBe('plan');
  });
});
