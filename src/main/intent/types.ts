import type { Action, AppEntry, BrowserId, Command, Project, Settings, Site } from '../../shared/schemas';

export type PlanSource = 'command' | 'builtin' | 'rule' | 'llm';

export interface Plan {
  /** Human label, e.g. "LeetCode mode" or "Open GitHub". */
  label: string;
  actions: Action[];
  /** Spoken on success. */
  response?: string;
  source: PlanSource;
  commandId?: string;
  /** Match confidence in [0, 1]. */
  confidence: number;
}

export type Interpretation =
  | { kind: 'plan'; plan: Plan }
  /** Probably meant `plan`, but not sure enough to run without asking. */
  | { kind: 'clarify'; prompt: string; plan: Plan }
  | { kind: 'unknown'; text: string; reason: string };

export interface InterpreterContext {
  settings: Settings;
  commands: Command[];
  /** Browsers actually found on this machine. */
  installedBrowsers: BrowserId[];
  /** Editors actually found on this machine. */
  installedEditors: Array<'vscode' | 'cursor'>;
}

export interface NamedTarget {
  kind: 'site' | 'app' | 'project' | 'browser' | 'editor';
  id: string;
  name: string;
  names: string[];
  site?: Site;
  app?: AppEntry;
  project?: Project;
}
