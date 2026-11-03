// API keys. Read order: environment variable, then the encrypted local store.
// The store is encrypted with Electron safeStorage, which uses Windows DPAPI
// (only this Windows user account can decrypt it). Keys are never sent to a
// renderer: the settings UI can only ask "is a key set?" and replace/clear it.
import { safeStorage } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class SecretStore {
  private readonly path: string;

  /** Defaults to the AI-interpreter key; also used for the cloud transcription key. */
  constructor(
    dir: string,
    file = 'llm-key.bin',
    private readonly envVars: string[] = ['ROG_LLM_API_KEY', 'ANTHROPIC_API_KEY'],
  ) {
    this.path = join(dir, file);
  }

  source(): 'env' | 'stored' | 'none' {
    if (this.envVars.some((v) => process.env[v])) return 'env';
    return existsSync(this.path) ? 'stored' : 'none';
  }

  get(): string | null {
    for (const v of this.envVars) {
      const value = process.env[v];
      if (value) return value;
    }
    if (!existsSync(this.path) || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(readFileSync(this.path));
    } catch {
      return null;
    }
  }

  set(key: string): { ok: boolean; error?: string } {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Windows encryption (DPAPI) is unavailable' };
    writeFileSync(this.path, safeStorage.encryptString(key.trim()));
    return { ok: true };
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}
