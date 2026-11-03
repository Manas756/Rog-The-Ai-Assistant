import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGrammar } from '../src/main/assistant/grammar';
import { commandFileSchema, settingsSchema } from '../src/shared/schemas';
import { defaultCommands, makeSettings } from './helpers';

const read = (f: string) => JSON.parse(readFileSync(join(__dirname, '..', 'config', 'examples', f), 'utf8'));

describe('example configuration files', () => {
  it('settings.example.json is valid', () => {
    expect(settingsSchema.safeParse(read('settings.example.json')).success).toBe(true);
  });
  it('commands.example.json is valid', () => {
    expect(commandFileSchema.safeParse(read('commands.example.json')).success).toBe(true);
  });
});

describe('recognizer grammar', () => {
  it('contains spoken forms of triggers, targets and projects', () => {
    const g = buildGrammar(makeSettings(), defaultCommands(), ['brave'], ['vscode']);
    expect(g.phrases).toContain('start leet code mode');
    expect(g.phrases).toContain('open git hub');
    expect(g.phrases).toContain('open my rocket chat project');
    expect(g.phrases).toContain('open brave');
    expect(g.wakeWords).toContain('rog');
    expect(g.dictationPrefixes).toContain('search youtube for');
  });
});
