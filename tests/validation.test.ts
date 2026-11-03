import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandStore, SettingsStore, deepMerge } from '../src/main/storage/stores';
import { actionSchema, commandSchema, settingsSchema } from '../src/shared/schemas';

describe('action validation', () => {
  it('accepts only http(s) URLs without credentials', () => {
    expect(actionSchema.safeParse({ type: 'open_url', url: 'https://leetcode.com/' }).success).toBe(true);
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', 'https://user:pw@evil.com', 'not a url']) {
      expect(actionSchema.safeParse({ type: 'open_url', url }).success, url).toBe(false);
    }
  });

  it('rejects action types outside the catalog', () => {
    expect(actionSchema.safeParse({ type: 'shell', command: 'del *' }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'run_script', path: 'C:\\x.ps1' }).success).toBe(false);
  });

  it('bounds waits and requires absolute folder paths', () => {
    expect(actionSchema.safeParse({ type: 'wait', ms: 60_000 }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'open_folder', path: '..\\secret' }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'open_folder', path: '\\\\?\\C:\\x' }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'open_folder', path: 'C:\\code' }).success).toBe(true);
  });
});

describe('custom command validation', () => {
  const good = { id: 'dev-mode', name: 'Dev mode', triggers: ['start development mode'], actions: [{ type: 'open_url', url: 'https://docs.python.org/' }] };

  it('accepts a well-formed command and fills defaults', () => {
    const c = commandSchema.parse(good);
    expect(c.enabled).toBe(true);
    expect(c.actions[0]).toMatchObject({ browser: 'preferred', newWindow: false });
  });

  it('rejects empty triggers, empty or oversized action lists and bad ids', () => {
    expect(commandSchema.safeParse({ ...good, triggers: [] }).success).toBe(false);
    expect(commandSchema.safeParse({ ...good, actions: [] }).success).toBe(false);
    expect(commandSchema.safeParse({ ...good, actions: Array(13).fill(good.actions[0]) }).success).toBe(false);
    expect(commandSchema.safeParse({ ...good, id: '../../evil' }).success).toBe(false);
  });

  it('approved apps must be absolute .exe paths', () => {
    expect(settingsSchema.safeParse({ apps: [{ id: 'x', name: 'X', path: 'C:\\x\\run.bat' }] }).success).toBe(false);
    expect(settingsSchema.safeParse({ apps: [{ id: 'x', name: 'X', path: 'run.exe' }] }).success).toBe(false);
    expect(settingsSchema.safeParse({ apps: [{ id: 'x', name: 'X', path: 'C:\\x\\run.exe' }] }).success).toBe(true);
  });
});

describe('stores', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'rog-test-'));

  it('creates defaults with launch-at-login and LLM disabled', () => {
    const d = dir();
    const s = new SettingsStore(d).get();
    expect(s.startup.launchAtLogin).toBe(false);
    expect(s.llm.enabled).toBe(false);
    expect(s.sites.some((x) => x.id === 'leetcode')).toBe(true);
    const cmds = new CommandStore(d).list();
    expect(cmds.find((c) => c.id === 'leetcode-mode')?.enabled).toBe(true);
  });

  it('reads hand-edited files saved with a UTF-8 BOM', () => {
    const d = dir();
    writeFileSync(join(d, 'settings.json'), '﻿' + JSON.stringify({ voice: { wakeSensitivity: 0.7 } }));
    const store = new SettingsStore(d);
    expect(store.loadWarning).toBeUndefined();
    expect(store.get().voice.wakeSensitivity).toBe(0.7);
  });

  it('refuses invalid settings patches without changing anything', () => {
    const store = new SettingsStore(dir());
    const r = store.update({ leetcode: { leetcodeUrl: 'javascript:alert(1)' } });
    expect(r.ok).toBe(false);
    expect(store.get().leetcode.leetcodeUrl).toBe('https://leetcode.com/');
  });

  it('ignores prototype pollution keys in patches', () => {
    const merged = deepMerge({ a: 1 }, JSON.parse('{"__proto__": {"polluted": true}, "b": 2}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(merged).toEqual({ a: 1, b: 2 });
  });

  it('imports commands disabled, renames clashing ids, and runs nothing', () => {
    const d = dir();
    const store = new CommandStore(d);
    const r = store.importFrom({
      version: 1,
      commands: [{ id: 'leetcode-mode', name: 'Imported', triggers: ['do the thing'], actions: [{ type: 'open_url', url: 'https://example.com/' }], enabled: true }],
    });
    expect(r.imported).toBe(1);
    const imported = store.get('leetcode-mode-2')!;
    expect(imported.enabled).toBe(false);
    expect(imported.imported).toBe(true);
    // persisted
    expect(JSON.parse(readFileSync(join(d, 'commands.json'), 'utf8')).commands.some((c: { id: string }) => c.id === 'leetcode-mode-2')).toBe(true);
  });

  it('rejects malformed imports entirely', () => {
    const store = new CommandStore(dir());
    const r = store.importFrom({ version: 1, commands: [{ id: 'x', name: 'x', triggers: ['xx'], actions: [{ type: 'shell', cmd: 'calc' }] }] });
    expect(r.imported).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('keeps builtin flag under ROG control', () => {
    const store = new CommandStore(dir());
    const r = store.upsert({ id: 'mine', name: 'Mine', triggers: ['my thing'], actions: [{ type: 'speak', text: 'hi' }], builtin: true });
    expect(r.ok && r.command.builtin).toBeFalsy();
  });
});
