import { describe, expect, it, vi } from 'vitest';
import { executePlan } from '../src/main/actions/executor';
import { assessPlan } from '../src/main/actions/policy';
import type { ActionContext } from '../src/main/actions/types';
import { createLauncher, type ProcessApi } from '../src/main/platform/launcher';
import { buildLeetcodeActions, expandWorkflows } from '../src/main/workflows/leetcodeMode';
import type { Action } from '../src/shared/schemas';
import { fakeLauncher, makeSettings } from './helpers';

function actionCtx(launcher = fakeLauncher().launcher, settings = makeSettings()): ActionContext {
  return {
    settings,
    launcher,
    assistant: {
      speak: vi.fn(),
      setVoiceMuted: vi.fn(),
      stopListening: vi.fn(),
      hideOrb: vi.fn(),
      cancel: vi.fn(),
      statusText: () => 'status',
      helpText: () => 'help',
    },
    sleep: async () => undefined,
  };
}

const policyCtx = (source: 'command' | 'rule' | 'llm' = 'command', settings = makeSettings()) => ({
  settings,
  source,
  isKnownApp: (id: string) => ['spotify', 'browser-brave'].includes(id),
});

describe('LeetCode mode workflow', () => {
  it('opens LeetCode then YouTube Music as tabs by default', () => {
    expect(buildLeetcodeActions(makeSettings())).toEqual([
      { type: 'open_url', url: 'https://leetcode.com/', browser: 'preferred', newWindow: false },
      { type: 'open_url', url: 'https://music.youtube.com/', browser: 'preferred', newWindow: false },
    ]);
  });

  it('uses the playlist when configured, and new-window mode waits between launches', () => {
    const s = makeSettings({ leetcode: { openMode: 'new-window', playlistUrl: 'https://music.youtube.com/playlist?list=abc' } });
    expect(buildLeetcodeActions(s)).toEqual([
      { type: 'open_url', url: 'https://leetcode.com/', browser: 'preferred', newWindow: true },
      { type: 'wait', ms: 700 },
      { type: 'open_url', url: 'https://music.youtube.com/playlist?list=abc', browser: 'preferred', newWindow: false },
    ]);
  });

  it('separate windows + editor project', () => {
    const s = makeSettings({ leetcode: { openMode: 'separate-windows', openEditor: true, editorProjectId: 'rocketchat' } });
    const a = buildLeetcodeActions(s);
    expect(a.filter((x) => x.type === 'open_url').every((x) => x.type === 'open_url' && x.newWindow)).toBe(true);
    expect(a.at(-1)).toEqual({ type: 'open_project', projectId: 'rocketchat', editor: 'preferred' });
  });

  it('expands workflow actions in place', () => {
    const actions = expandWorkflows([{ type: 'speak', text: 'hi' }, { type: 'workflow', workflowId: 'leetcode' }], makeSettings());
    expect(actions.map((a) => a.type)).toEqual(['speak', 'open_url', 'open_url']);
  });
});

describe('executor', () => {
  it('runs steps in order', async () => {
    const { launcher, calls } = fakeLauncher();
    const actions = expandWorkflows([{ type: 'workflow', workflowId: 'leetcode' }], makeSettings());
    const r = await executePlan(actions, actionCtx(launcher));
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['url:https://leetcode.com/|preferred|tab', 'url:https://music.youtube.com/|preferred|tab']);
  });

  it('stops at the first failure and reports it', async () => {
    const { launcher, calls } = fakeLauncher((w) => (w.includes('leetcode') ? 'Brave not found' : undefined));
    const actions: Action[] = [
      { type: 'open_url', url: 'https://leetcode.com/', browser: 'preferred', newWindow: false },
      { type: 'open_url', url: 'https://music.youtube.com/', browser: 'preferred', newWindow: false },
    ];
    const r = await executePlan(actions, actionCtx(launcher));
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(0);
    expect(r.results[0]!.message).toBe('Brave not found');
    expect(calls).toHaveLength(1);
  });

  it('reports each step to hooks and honours cancellation', async () => {
    const steps: string[] = [];
    const ac = new AbortController();
    const actions: Action[] = [
      { type: 'speak', text: 'one' },
      { type: 'speak', text: 'two' },
    ];
    const r = await executePlan(actions, actionCtx(), { onStep: (i, _n, _a, d) => (steps.push(`${i}:${d}`), i === 0 && ac.abort()) }, ac.signal);
    expect(steps).toEqual(['0:Speaking']);
    expect(r.cancelled).toBe(true);
  });

  it('converts thrown errors into failed steps', async () => {
    const { launcher } = fakeLauncher();
    launcher.openUrl = async () => {
      throw new Error('boom');
    };
    const r = await executePlan([{ type: 'open_url', url: 'https://a.com/', browser: 'preferred', newWindow: false }], actionCtx(launcher));
    expect(r).toMatchObject({ ok: false, failedAt: 0 });
  });
});

describe('permission and confirmation policy', () => {
  const url: Action = { type: 'open_url', url: 'https://github.com/', browser: 'preferred', newWindow: false };

  it('allows ordinary approved actions without confirmation', () => {
    expect(assessPlan([url], policyCtx()).decision).toBe('allow');
    expect(assessPlan([{ type: 'open_app', appId: 'spotify' }], policyCtx()).decision).toBe('allow');
    expect(assessPlan([{ type: 'open_project', projectId: 'rocketchat', editor: 'preferred' }], policyCtx()).decision).toBe('allow');
  });

  it('denies unknown apps and projects', () => {
    expect(assessPlan([{ type: 'open_app', appId: 'cmd' }], policyCtx()).decision).toBe('deny');
    expect(assessPlan([{ type: 'open_project', projectId: 'nope', editor: 'preferred' }], policyCtx()).decision).toBe('deny');
  });

  it('denies invalid plans and unexpanded workflows', () => {
    expect(assessPlan([{ type: 'shell', command: 'calc' }], policyCtx()).decision).toBe('deny');
    expect(assessPlan([], policyCtx()).decision).toBe('deny');
    expect(assessPlan([{ type: 'workflow', workflowId: 'leetcode' }], policyCtx()).decision).toBe('deny');
  });

  it('asks before opening folders outside configured projects', () => {
    expect(assessPlan([{ type: 'open_folder', path: 'C:\\code\\Rocket.Chat\\apps' }], policyCtx()).decision).toBe('allow');
    expect(assessPlan([{ type: 'open_folder', path: 'C:\\Windows\\System32' }], policyCtx('rule')).decision).toBe('confirm');
    expect(assessPlan([{ type: 'open_folder', path: 'C:\\Windows\\System32' }], policyCtx('llm')).decision).toBe('confirm');
    // A folder you put in your own saved command is trusted.
    expect(assessPlan([{ type: 'open_folder', path: 'C:\\Users\\me\\Downloads' }], policyCtx('command')).decision).toBe('allow');
  });

  it('asks before running AI-generated plans (by default)', () => {
    expect(assessPlan([url], policyCtx('llm')).decision).toBe('confirm');
    expect(assessPlan([url], policyCtx('llm', makeSettings({ llm: { confirmPlans: false } }))).decision).toBe('allow');
    // launching an executable from an AI plan always asks
    expect(assessPlan([{ type: 'open_app', appId: 'spotify' }], policyCtx('llm', makeSettings({ llm: { confirmPlans: false } }))).decision).toBe('confirm');
  });

  it('asks before long plans', () => {
    expect(assessPlan(Array(7).fill(url), policyCtx()).decision).toBe('confirm');
  });
});

describe('Windows launcher (process API mocked)', () => {
  function setup(opts: { files?: string[]; dirs?: string[]; preferred?: 'brave' | 'system' } = {}) {
    const spawned: Array<{ exe: string; args: string[] }> = [];
    const opened: string[] = [];
    const proc: ProcessApi = {
      spawnDetached: async (exe, args) => (spawned.push({ exe, args }), { pid: 42 }),
      openPath: async (p) => (opened.push(p), ''),
      openExternal: async (u) => void opened.push(u),
      isFile: (p) => (opts.files ?? []).includes(p),
      isDirectory: (p) => (opts.dirs ?? []).includes(p),
    };
    const brave = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
    const settings = makeSettings({ browser: { preferred: opts.preferred ?? 'brave' } });
    const launcher = createLauncher({
      settings: () => settings,
      browsers: () => [{ id: 'brave', name: 'Brave', path: brave, source: 'known-location' }],
      editors: () => [{ id: 'vscode', name: 'VS Code', path: 'C:\\VSCode\\Code.exe', source: 'known-location' }],
      proc,
    });
    return { launcher, spawned, opened, brave };
  }

  it('launches Brave with the URL after a switch terminator, and --new-window when asked', async () => {
    const { launcher, spawned, brave } = setup({ files: ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'] });
    const r = await launcher.openUrl('https://leetcode.com/', 'preferred', true);
    expect(r).toMatchObject({ ok: true, stage: 'started', pid: 42 });
    expect(spawned).toEqual([{ exe: brave, args: ['--new-window', '--', 'https://leetcode.com/'] }]);
  });

  it('normalizes URLs so they cannot smuggle extra arguments', async () => {
    const { launcher, spawned } = setup({ files: ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'] });
    await launcher.openUrl('https://a.com/ --disable-web-security', 'brave', false);
    expect(spawned[0]!.args).toEqual(['--', 'https://a.com/%20--disable-web-security']);
  });

  it('refuses non-http URLs and missing browsers with clear errors', async () => {
    const { launcher, spawned } = setup();
    expect((await launcher.openUrl('file:///C:/x.exe', 'brave', false)).ok).toBe(false);
    const missing = await launcher.openUrl('https://a.com/', 'chrome', false);
    expect(missing).toMatchObject({ ok: false });
    expect(missing.message).toMatch(/chrome/);
    // brave.exe not present on "disk" in this test
    expect((await launcher.openUrl('https://a.com/', 'brave', false)).ok).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it('uses the Windows default browser when selected', async () => {
    const { launcher, opened } = setup({ preferred: 'system' });
    expect(await launcher.openUrl('https://github.com/', 'preferred', false)).toMatchObject({ ok: true, stage: 'requested' });
    expect(opened).toEqual(['https://github.com/']);
  });

  it('only launches approved .exe apps that exist', async () => {
    const { launcher, spawned } = setup({ files: ['C:\\Apps\\Spotify.exe'] });
    expect(await launcher.launchApp('spotify')).toMatchObject({ ok: true, stage: 'started' });
    expect((await launcher.launchApp('cmd')).ok).toBe(false);
    expect(spawned.map((s) => s.exe)).toEqual(['C:\\Apps\\Spotify.exe']);
  });

  it('opens only directories in Explorer, never files', async () => {
    const { launcher, opened } = setup({ dirs: ['C:\\code'], files: ['C:\\code\\evil.exe'] });
    expect((await launcher.openFolder('C:\\code')).ok).toBe(true);
    expect((await launcher.openFolder('C:\\code\\evil.exe')).ok).toBe(false);
    expect(opened).toEqual(['C:\\code']);
  });

  it('opens projects in the preferred editor', async () => {
    const { launcher, spawned } = setup({ dirs: ['C:\\code\\Rocket.Chat'], files: ['C:\\VSCode\\Code.exe'] });
    expect((await launcher.openInEditor('C:\\code\\Rocket.Chat', 'preferred')).ok).toBe(true);
    expect(spawned).toEqual([{ exe: 'C:\\VSCode\\Code.exe', args: ['C:\\code\\Rocket.Chat'] }]);
  });
});
