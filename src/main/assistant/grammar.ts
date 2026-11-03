// Builds the recognizer vocabulary from the current commands and settings, so
// adding a command or a project in Settings immediately makes it hearable.
import { DICTATION_PREFIXES } from '../../shared/defaults';
import type { Command, Settings } from '../../shared/schemas';
import { spokenForm } from '../../shared/text';
import type { GrammarSpec } from './speechHost';

const OPEN_VERBS = ['open', 'launch', 'start', 'go to', 'open my', 'open the'];
const BROWSER_SPOKEN: Record<string, string[]> = {
  brave: ['brave', 'brave browser'],
  chrome: ['chrome', 'google chrome'],
  edge: ['edge', 'microsoft edge'],
  firefox: ['firefox'],
};

/**
 * Text fed to Whisper as "previous context" so it spells ROG and your app and
 * command words correctly. Kept short: Whisper reads at most ~224 tokens.
 */
export function buildVocabularyPrompt(settings: Settings, commands: Command[]): string {
  const names = new Set<string>();
  for (const a of settings.apps) names.add(a.name);
  for (const s of settings.sites) names.add(s.name);
  for (const p of settings.projects) names.add(p.name);
  const triggers = commands.filter((c) => c.enabled && !c.builtin).map((c) => c.triggers[0]!);
  const examples = ['ROG, open notes.', 'Rog, start LeetCode mode.', ...triggers.slice(0, 12).map((t) => `Rog, ${t}.`)];
  return `${examples.join(' ')} ${[...names].slice(0, 40).join(', ')}.`.slice(0, 700);
}

export function buildGrammar(settings: Settings, commands: Command[], installedBrowsers: string[], installedEditors: string[]): GrammarSpec {
  const phrases = new Set<string>();
  const add = (p: string) => {
    const s = spokenForm(p);
    if (s.length >= 2) phrases.add(s);
  };

  for (const cmd of commands) if (cmd.enabled) cmd.triggers.forEach(add);

  const targets: string[] = [];
  for (const s of settings.sites) targets.push(s.name, ...s.aliases);
  for (const a of settings.apps) targets.push(a.name, ...a.aliases);
  for (const b of installedBrowsers) targets.push(...(BROWSER_SPOKEN[b] ?? []));
  if (installedEditors.includes('vscode')) targets.push('vs code', 'visual studio code');
  if (installedEditors.includes('cursor')) targets.push('cursor');
  for (const t of targets) for (const v of OPEN_VERBS) add(`${v} ${t}`);

  for (const p of settings.projects) {
    for (const name of [p.name, ...p.aliases]) {
      add(`open my ${name} project`);
      add(`open ${name} project`);
      add(`open ${name}`);
      add(`open the ${name} project`);
    }
  }

  return {
    wakeWords: settings.voice.wakeWords.map(spokenForm),
    phrases: [...phrases].slice(0, 2000),
    dictationPrefixes: DICTATION_PREFIXES,
  };
}
