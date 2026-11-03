import { vi } from 'vitest';
import type { Launcher, StepResult } from '../src/main/actions/types';
import type { InterpreterContext } from '../src/main/intent/types';
import { DEFAULT_COMMANDS, DEFAULT_SITES } from '../src/shared/defaults';
import { commandSchema, settingsSchema, type Settings, type SettingsInput } from '../src/shared/schemas';

export function makeSettings(overrides: SettingsInput = {}): Settings {
  return settingsSchema.parse({
    sites: DEFAULT_SITES,
    projects: [{ id: 'rocketchat', name: 'Rocket.Chat', path: 'C:\\code\\Rocket.Chat', aliases: ['rc'] }],
    apps: [{ id: 'spotify', name: 'Spotify', path: 'C:\\Apps\\Spotify.exe' }],
    ...overrides,
  });
}

export const defaultCommands = () => DEFAULT_COMMANDS.map((c) => commandSchema.parse(c));

export function makeCtx(settings = makeSettings()): InterpreterContext {
  return { settings, commands: defaultCommands(), installedBrowsers: ['brave', 'chrome', 'edge'], installedEditors: ['vscode'] };
}

/** A launcher that records calls instead of starting anything. */
export function fakeLauncher(fail?: (what: string) => string | undefined) {
  const calls: string[] = [];
  const result = (what: string): StepResult => {
    calls.push(what);
    const err = fail?.(what);
    return err ? { ok: false, stage: 'failed', message: err } : { ok: true, stage: 'started', message: 'started', pid: 1234 };
  };
  const launcher: Launcher = {
    openUrl: vi.fn(async (url, browser, newWindow) => result(`url:${url}|${browser}|${newWindow ? 'new' : 'tab'}`)),
    launchApp: vi.fn(async (id) => result(`app:${id}`)),
    openFolder: vi.fn(async (p) => result(`folder:${p}`)),
    openInEditor: vi.fn(async (p, e) => result(`editor:${p}|${e}`)),
    power: vi.fn(async (op, delay) => result(`power:${op}|${delay}`)),
    isKnownApp: (id) => ['spotify', 'browser-brave', 'browser-chrome', 'editor-vscode'].includes(id),
    appName: (id) => id,
  };
  return { launcher, calls };
}
