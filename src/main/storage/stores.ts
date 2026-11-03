// Local persistence: settings.json and commands.json in the app's userData
// folder. Files are validated on load (a corrupted or hand-edited file falls
// back to defaults and is backed up, never half-applied) and written
// atomically (temp file + rename) so a crash can't truncate them.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_COMMANDS, DEFAULT_SITES } from '../../shared/defaults';
import {
  commandFileSchema,
  commandSchema,
  formatZodError,
  settingsSchema,
  type Command,
  type CommandInput,
  type Settings,
} from '../../shared/schemas';

/** Built-in command ids removed in later versions. */
const RETIRED_BUILTINS = ['coding-music'];

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    // Strip a UTF-8 BOM: Notepad and Windows PowerShell add one to hand-edited files.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch {
    return Symbol.for('corrupt');
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, path);
}

function backupBroken(path: string): void {
  try {
    copyFileSync(path, `${path}.broken-${Date.now()}`);
  } catch {
    /* best effort */
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge for settings patches: objects merge, arrays and scalars replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export class SettingsStore {
  private value: Settings;
  readonly path: string;
  loadWarning?: string;

  constructor(dir: string) {
    this.path = join(dir, 'settings.json');
    const raw = readJson(this.path);
    if (raw === undefined) {
      this.value = settingsSchema.parse({ sites: DEFAULT_SITES });
      this.save();
      return;
    }
    const parsed = settingsSchema.safeParse(raw);
    if (parsed.success) {
      this.value = parsed.data;
    } else {
      this.loadWarning =
        typeof raw === 'symbol' ? 'settings.json was unreadable' : `settings.json was invalid (${formatZodError(parsed.error)})`;
      backupBroken(this.path);
      this.value = settingsSchema.parse({ sites: DEFAULT_SITES });
      this.save();
    }
  }

  get(): Settings {
    return this.value;
  }

  /** Applies a partial update. Returns an error string and changes nothing if the result is invalid. */
  update(patch: unknown): { ok: true; settings: Settings } | { ok: false; error: string } {
    const merged = deepMerge(this.value, patch);
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
    this.value = parsed.data;
    this.save();
    return { ok: true, settings: this.value };
  }

  private save(): void {
    writeJsonAtomic(this.path, this.value);
  }
}

export class CommandStore {
  private commands: Command[];
  readonly path: string;
  loadWarning?: string;

  constructor(dir: string) {
    this.path = join(dir, 'commands.json');
    const raw = readJson(this.path);
    const parsed = raw === undefined ? null : commandFileSchema.safeParse(raw);
    if (parsed?.success) {
      this.commands = parsed.data.commands;
      this.addMissingBuiltins();
    } else {
      if (parsed) {
        this.loadWarning = `commands.json was invalid (${formatZodError(parsed.error)}); defaults restored`;
        backupBroken(this.path);
      }
      this.commands = DEFAULT_COMMANDS.map((c) => commandSchema.parse(c));
      this.save();
    }
  }

  /**
   * New built-ins shipped in an update appear without overwriting the user's edits;
   * built-ins ROG no longer ships are removed.
   */
  private addMissingBuiltins(): void {
    let changed = false;
    const before = this.commands.length;
    this.commands = this.commands.filter((c) => !(c.builtin && RETIRED_BUILTINS.includes(c.id)));
    if (this.commands.length !== before) changed = true;
    for (const def of DEFAULT_COMMANDS) {
      if (!this.commands.some((c) => c.id === def.id)) {
        this.commands.push(commandSchema.parse(def));
        changed = true;
      }
    }
    if (changed) this.save();
  }

  list(): Command[] {
    return this.commands;
  }

  get(id: string): Command | undefined {
    return this.commands.find((c) => c.id === id);
  }

  upsert(input: CommandInput): { ok: true; command: Command; warning?: string } | { ok: false; error: string } {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
    const cmd = parsed.data;
    const existing = this.commands.findIndex((c) => c.id === cmd.id);
    if (existing >= 0) {
      // "builtin" is decided by ROG, not by the editor.
      cmd.builtin = this.commands[existing]!.builtin;
      this.commands[existing] = cmd;
    } else {
      delete cmd.builtin;
      this.commands.push(cmd);
    }
    const clash = this.findTriggerClash(cmd);
    this.save();
    return { ok: true, command: cmd, warning: clash ? `"${clash}" uses the same trigger phrase` : undefined };
  }

  /** Another enabled command already using one of these exact triggers. */
  findTriggerClash(cmd: Command): string | undefined {
    const mine = new Set(cmd.triggers.map((t) => t.toLowerCase()));
    return this.commands.find((c) => c.id !== cmd.id && c.enabled && c.triggers.some((t) => mine.has(t.toLowerCase())))?.name;
  }

  remove(id: string): boolean {
    const before = this.commands.length;
    this.commands = this.commands.filter((c) => c.id !== id);
    if (this.commands.length === before) return false;
    this.save();
    return true;
  }

  resetBuiltin(id: string): boolean {
    const def = DEFAULT_COMMANDS.find((c) => c.id === id);
    if (!def) return false;
    this.upsert(def);
    return true;
  }

  /**
   * Imports commands from untrusted JSON. Every command is validated, ids that
   * already exist are renamed, and imported commands start DISABLED: the user
   * must review and enable them. Nothing is executed during import.
   */
  importFrom(raw: unknown): { imported: number; errors: string[] } {
    const parsed = commandFileSchema.safeParse(raw);
    if (!parsed.success) return { imported: 0, errors: [formatZodError(parsed.error)] };
    let imported = 0;
    for (const cmd of parsed.data.commands) {
      let id = cmd.id;
      for (let n = 2; this.commands.some((c) => c.id === id); n++) id = `${cmd.id}-${n}`.slice(0, 64);
      this.commands.push({ ...cmd, id, enabled: false, imported: true, builtin: undefined });
      imported++;
    }
    this.save();
    return { imported, errors: [] };
  }

  exportAll(): { version: 1; commands: Command[] } {
    return { version: 1, commands: this.commands };
  }

  private save(): void {
    writeJsonAtomic(this.path, { version: 1, commands: this.commands });
  }
}
