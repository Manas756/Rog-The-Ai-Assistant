// Real Windows application launching.
//
// Rules this module enforces regardless of what the caller asks for:
//   * no shell: executables are spawned directly with an argument array
//   * only .exe files that exist, from the approved app list or detection results
//   * only http(s) URLs, normalized by the URL parser, passed after a "--" switch terminator
//   * folders only (never files) are handed to Explorer, so nothing gets "opened" = executed
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { BrowserId, BrowserRef, Settings } from '../../shared/schemas';
import type { Launcher, StepResult } from '../actions/types';
import type { Detected, EditorId } from './detect';

export interface ProcessApi {
  /** Spawns a detached process; resolves with the PID once Windows reports it started. */
  spawnDetached(exe: string, args: string[], cwd?: string): Promise<{ pid: number }>;
  /** Electron shell.openPath: resolves to an error message, or "" on success. */
  openPath(path: string): Promise<string>;
  /** Electron shell.openExternal (Windows default browser). */
  openExternal(url: string): Promise<void>;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
}

export const nodeProcessApi = (shell: { openPath(p: string): Promise<string>; openExternal(u: string): Promise<void> }): ProcessApi => ({
  spawnDetached: (exe, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', shell: false, windowsHide: false });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve({ pid: child.pid ?? -1 });
      });
    }),
  openPath: (p) => shell.openPath(p),
  openExternal: (u) => shell.openExternal(u),
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
});

export interface LauncherDeps {
  settings: () => Settings;
  browsers: () => Detected<BrowserId>[];
  editors: () => Detected<EditorId>[];
  proc: ProcessApi;
}

const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const SHUTDOWN = join(SYSTEM32, 'shutdown.exe');
const EXPLORER = join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe');

const fail = (message: string): StepResult => ({ ok: false, stage: 'failed', message });

export function normalizeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function validateExecutable(path: string, proc: Pick<ProcessApi, 'isFile'>): string | null {
  if (!isAbsolute(path) || !/^[a-zA-Z]:\\/.test(path)) return 'path must be absolute';
  if (!/\.exe$/i.test(path)) return 'only .exe files can be launched';
  if (path.includes('\0')) return 'invalid path';
  if (!proc.isFile(path)) return `${path} does not exist`;
  return null;
}

export function validateArgs(args: string[]): string | null {
  if (args.length > 12) return 'too many arguments';
  for (const a of args) {
    if (typeof a !== 'string' || a.length > 2048 || a.includes('\0') || /[\r\n]/.test(a)) return 'invalid argument';
  }
  return null;
}

export function createLauncher(deps: LauncherDeps): Launcher {
  const { proc } = deps;

  async function spawnChecked(exe: string, args: string[], label: string, cwd?: string): Promise<StepResult> {
    const bad = validateExecutable(exe, proc) ?? validateArgs(args) ?? (cwd && !proc.isDirectory(cwd) ? `working folder ${cwd} not found` : null);
    if (bad) return fail(`Can't start ${label}: ${bad}`);
    try {
      const { pid } = await proc.spawnDetached(exe, args, cwd);
      return { ok: true, stage: 'started', message: `${label} started`, pid };
    } catch (err) {
      return fail(`Couldn't start ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function resolveBrowser(ref: BrowserRef): Detected<BrowserId> | 'system' | { missing: BrowserId } {
    const id = ref === 'preferred' ? deps.settings().browser.preferred : ref;
    if (id === 'system') return 'system';
    return deps.browsers().find((b) => b.id === id) ?? { missing: id };
  }

  type ResolvedApp = { name: string; path: string; args: string[]; cwd?: string } | { name: string; aumid: string };

  function app(appId: string): ResolvedApp | undefined {
    if (appId.startsWith('browser-')) {
      const b = deps.browsers().find((x) => `browser-${x.id}` === appId);
      return b && { name: b.name, path: b.path, args: [] };
    }
    if (appId.startsWith('editor-')) {
      const e = deps.editors().find((x) => `editor-${x.id}` === appId);
      return e && { name: e.name, path: e.path, args: [] };
    }
    const a = deps.settings().apps.find((x) => x.id === appId);
    if (!a) return undefined;
    if (a.aumid) return { name: a.name, aumid: a.aumid };
    return a.path ? { name: a.name, path: a.path, args: a.args, cwd: a.cwd } : undefined;
  }

  return {
    async openUrl(url, browserRef, newWindow) {
      const href = normalizeHttpUrl(url);
      if (!href) return fail('Only http and https links can be opened');
      const browser = resolveBrowser(browserRef);
      if (browser === 'system') {
        try {
          await proc.openExternal(href);
          return { ok: true, stage: 'requested', message: 'Asked Windows to open the link' };
        } catch (err) {
          return fail(`Windows couldn't open the link: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if ('missing' in browser) {
        return fail(`${browser.missing} isn't installed or wasn't found. Choose its location in Settings.`);
      }
      const args = [...(newWindow ? ['--new-window'] : []), '--', href];
      return spawnChecked(browser.path, args, browser.name);
    },

    async launchApp(appId) {
      const a = app(appId);
      if (!a) return fail(`${appId} is not an approved application`);
      if ('aumid' in a) {
        // Store apps have no launchable .exe; Explorer activates them by app id.
        const r = await spawnChecked(EXPLORER, [`shell:AppsFolder\\${a.aumid}`], a.name);
        return r.ok ? { ...r, stage: 'requested', message: `Asked Windows to open ${a.name}` } : r;
      }
      return spawnChecked(a.path, a.args, a.name, a.cwd);
    },

    async power(op, delaySeconds) {
      const t = String(Math.max(0, Math.min(120, Math.round(delaySeconds))));
      const args = op === 'shutdown' ? ['/s', '/t', t] : op === 'restart' ? ['/r', '/t', t] : ['/a'];
      const label = op === 'cancel' ? 'Shutdown cancel' : op === 'shutdown' ? 'Shutdown' : 'Restart';
      const r = await spawnChecked(SHUTDOWN, args, label);
      if (!r.ok) return r;
      return { ...r, stage: 'requested', message: op === 'cancel' ? 'Cancel requested' : `${label} in ${t} seconds` };
    },

    async openFolder(path) {
      if (!isAbsolute(path) || !proc.isDirectory(path)) return fail(`Folder not found: ${path}`);
      const err = await proc.openPath(path);
      return err ? fail(err) : { ok: true, stage: 'requested', message: 'Opened in File Explorer' };
    },

    async openInEditor(path, editorRef) {
      if (!isAbsolute(path) || !proc.isDirectory(path)) return fail(`Project folder not found: ${path}`);
      const id = editorRef === 'preferred' ? deps.settings().editor.preferred : editorRef;
      if (id === 'explorer') return this.openFolder(path);
      const editor = deps.editors().find((e) => e.id === id);
      if (!editor) return fail(`${id === 'vscode' ? 'VS Code' : 'Cursor'} wasn't found. Set its location in Settings.`);
      return spawnChecked(editor.path, [path], editor.name);
    },

    isKnownApp: (appId) => !!app(appId),
    appName: (appId) => app(appId)?.name,
  };
}

