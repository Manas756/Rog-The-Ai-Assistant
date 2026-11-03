// Finds installed browsers and editors. Checks the per-machine and per-user
// install locations and the Windows "App Paths" registry key; never guesses a
// path without verifying the file exists.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserId } from '../../shared/schemas';

export interface Detected<T extends string> {
  id: T;
  name: string;
  path: string;
  source: 'custom' | 'known-location' | 'registry';
}

export type EditorId = 'vscode' | 'cursor';

const env = (k: string) => process.env[k] ?? '';

const BROWSER_INFO: Record<BrowserId, { name: string; exe: string; rel: string[] }> = {
  brave: { name: 'Brave', exe: 'brave.exe', rel: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'] },
  chrome: { name: 'Chrome', exe: 'chrome.exe', rel: ['Google\\Chrome\\Application\\chrome.exe'] },
  edge: { name: 'Edge', exe: 'msedge.exe', rel: ['Microsoft\\Edge\\Application\\msedge.exe'] },
  firefox: { name: 'Firefox', exe: 'firefox.exe', rel: ['Mozilla Firefox\\firefox.exe'] },
};

const EDITOR_INFO: Record<EditorId, { name: string; candidates: () => string[] }> = {
  vscode: {
    name: 'VS Code',
    candidates: () => [
      join(env('LOCALAPPDATA'), 'Programs', 'Microsoft VS Code', 'Code.exe'),
      join(env('ProgramFiles'), 'Microsoft VS Code', 'Code.exe'),
    ],
  },
  cursor: {
    name: 'Cursor',
    candidates: () => [join(env('LOCALAPPDATA'), 'Programs', 'cursor', 'Cursor.exe')],
  },
};

function roots(): string[] {
  return [env('ProgramFiles'), env('ProgramFiles(x86)'), env('LOCALAPPDATA')].filter(Boolean);
}

/** Reads HKLM/HKCU "App Paths\<exe>" default value. Resolves to undefined on any failure. */
function appPathFromRegistry(exe: string): Promise<string | undefined> {
  const keys = [
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ];
  const regExe = join(env('SystemRoot') || 'C:\\Windows', 'System32', 'reg.exe');
  const query = (key: string) =>
    new Promise<string | undefined>((resolve) => {
      execFile(regExe, ['query', key, '/ve'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(undefined);
        const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(stdout);
        const value = m?.[1]?.trim().replace(/^"|"$/g, '');
        resolve(value && existsSync(value) ? value : undefined);
      });
    });
  return keys.reduce<Promise<string | undefined>>(async (acc, key) => (await acc) ?? query(key), Promise.resolve(undefined));
}

export async function detectBrowsers(custom: Partial<Record<BrowserId, string>> = {}): Promise<Detected<BrowserId>[]> {
  const found: Detected<BrowserId>[] = [];
  for (const id of Object.keys(BROWSER_INFO) as BrowserId[]) {
    const info = BROWSER_INFO[id];
    const customPath = custom[id];
    if (customPath && existsSync(customPath)) {
      found.push({ id, name: info.name, path: customPath, source: 'custom' });
      continue;
    }
    const known = roots()
      .flatMap((r) => info.rel.map((rel) => join(r, rel)))
      .find((p) => existsSync(p));
    if (known) {
      found.push({ id, name: info.name, path: known, source: 'known-location' });
      continue;
    }
    const reg = await appPathFromRegistry(info.exe);
    if (reg) found.push({ id, name: info.name, path: reg, source: 'registry' });
  }
  return found;
}

export function detectEditors(custom: Partial<Record<EditorId, string>> = {}): Detected<EditorId>[] {
  const found: Detected<EditorId>[] = [];
  for (const id of Object.keys(EDITOR_INFO) as EditorId[]) {
    const customPath = custom[id];
    if (customPath && existsSync(customPath)) {
      found.push({ id, name: EDITOR_INFO[id].name, path: customPath, source: 'custom' });
      continue;
    }
    const p = EDITOR_INFO[id].candidates().find((c) => existsSync(c));
    if (p) found.push({ id, name: EDITOR_INFO[id].name, path: p, source: 'known-location' });
  }
  return found;
}
