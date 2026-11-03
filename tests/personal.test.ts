// Store apps, working folders, power commands, split-browser LeetCode mode.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessPlan } from '../src/main/actions/policy';
import { interpretLocally } from '../src/main/intent/localInterpreter';
import { createLauncher, type ProcessApi } from '../src/main/platform/launcher';
import { CommandStore } from '../src/main/storage/stores';
import { buildLeetcodeActions } from '../src/main/workflows/leetcodeMode';
import { settingsSchema } from '../src/shared/schemas';
import { makeCtx, makeSettings } from './helpers';

function launcherWith(settings = makeSettings(), files: string[] = [], dirs: string[] = []) {
  const spawned: Array<{ exe: string; args: string[]; cwd?: string }> = [];
  const proc: ProcessApi = {
    spawnDetached: async (exe, args, cwd) => (spawned.push({ exe, args, cwd }), { pid: 7 }),
    openPath: async () => '',
    openExternal: async () => undefined,
    isFile: (p) => files.includes(p) || /\\(shutdown|explorer)\.exe$/i.test(p),
    isDirectory: (p) => dirs.includes(p),
  };
  return { launcher: createLauncher({ settings: () => settings, browsers: () => [], editors: () => [], proc }), spawned };
}

describe('approved apps', () => {
  it('requires exactly one of an .exe path or a Store app id', () => {
    expect(settingsSchema.safeParse({ apps: [{ id: 'x', name: 'X' }] }).success).toBe(false);
    expect(settingsSchema.safeParse({ apps: [{ id: 'x', name: 'X', path: 'C:\\a.exe', aumid: 'A.B_abc!App' }] }).success).toBe(false);
    expect(settingsSchema.safeParse({ apps: [{ id: 'x', name: 'X', aumid: 'not an id; calc' }] }).success).toBe(false);
    expect(settingsSchema.safeParse({ apps: [{ id: 'x', name: 'X', aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App' }] }).success).toBe(true);
  });

  it('launches Store apps through Explorer by app id', async () => {
    const s = makeSettings({ apps: [{ id: 'chatgpt', name: 'ChatGPT', aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App' }] });
    const { launcher, spawned } = launcherWith(s);
    expect(await launcher.launchApp('chatgpt')).toMatchObject({ ok: true, stage: 'requested' });
    expect(spawned[0]!.exe).toMatch(/explorer\.exe$/i);
    expect(spawned[0]!.args).toEqual(['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App']);
  });

  it('passes fixed args and the working folder (SKLauncher-style apps)', async () => {
    const java = 'C:\\Users\\me\\AppData\\Roaming\\sklauncher\\jre\\bin\\javaw.exe';
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\sklauncher';
    const s = makeSettings({ apps: [{ id: 'sk', name: 'SKlauncher', path: java, args: ['-jar', `${dir}\\SKlauncher.jar`], cwd: dir }] });
    const { launcher, spawned } = launcherWith(s, [java], [dir]);
    expect((await launcher.launchApp('sk')).ok).toBe(true);
    expect(spawned[0]).toEqual({ exe: java, args: ['-jar', `${dir}\\SKlauncher.jar`], cwd: dir });
  });
});

describe('power commands', () => {
  it('runs shutdown.exe with the configured countdown, and /a to cancel', async () => {
    const { launcher, spawned } = launcherWith();
    expect(await launcher.power('shutdown', 10)).toMatchObject({ ok: true, message: 'Shutdown in 10 seconds' });
    await launcher.power('restart', 5);
    await launcher.power('cancel', 10);
    expect(spawned.map((s) => s.args)).toEqual([['/s', '/t', '10'], ['/r', '/t', '5'], ['/a']]);
    expect(spawned.every((s) => /System32\\shutdown\.exe$/i.test(s.exe))).toBe(true);
  });

  it('are never accepted from the AI interpreter', () => {
    const ctx = (source: 'llm' | 'command') => ({ settings: makeSettings(), source, isKnownApp: () => true });
    expect(assessPlan([{ type: 'power', op: 'shutdown' }], ctx('llm')).decision).toBe('deny');
    expect(assessPlan([{ type: 'power', op: 'shutdown' }], ctx('command')).decision).toBe('allow');
  });

  it('need the exact phrase; near misses ask first; disabled by default', () => {
    const ctx = makeCtx();
    expect(interpretLocally('shut down', ctx).kind).not.toBe('plan'); // disabled by default
    ctx.commands = ctx.commands.map((c) => (c.id === 'shutdown' || c.id === 'restart' ? { ...c, enabled: true } : c));
    const exact = interpretLocally('rog shut down', ctx);
    expect(exact.kind === 'plan' && exact.plan.actions[0]).toEqual({ type: 'power', op: 'shutdown' });
    expect(interpretLocally('shut down the computers', ctx).kind).toBe('clarify');
    expect(interpretLocally('start', ctx).kind).not.toBe('plan');
  });
});

describe('LeetCode mode across two browsers', () => {
  it('opens LeetCode in Chrome and music in Brave', () => {
    const s = makeSettings({ leetcode: { browser: 'chrome', musicBrowser: 'brave' } });
    expect(buildLeetcodeActions(s)).toEqual([
      { type: 'open_url', url: 'https://leetcode.com/', browser: 'chrome', newWindow: false },
      { type: 'open_url', url: 'https://music.youtube.com/', browser: 'brave', newWindow: false },
    ]);
  });
});

describe('retired built-ins', () => {
  it('removes the old coding-music built-in on load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rog-retire-'));
    writeFileSync(
      join(dir, 'commands.json'),
      JSON.stringify({ version: 1, commands: [{ id: 'coding-music', name: 'Coding music', triggers: ['play my coding music'], actions: [{ type: 'open_url', url: 'https://music.youtube.com/' }], builtin: true }] }),
    );
    const store = new CommandStore(dir);
    expect(store.get('coding-music')).toBeUndefined();
    expect(store.get('music')?.enabled).toBe(true);
  });
});
