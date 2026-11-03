import type { Action, AssistantOp, BrowserRef, Settings } from '../../shared/schemas';
import type { PlanSource } from '../intent/types';

/**
 * What actually happened, as precisely as ROG can know it:
 *   requested - the OS accepted the request (e.g. ShellExecute returned), nothing more is known
 *   started   - a process was spawned and reported a PID
 *   done      - an internal action that ROG fully controls completed
 *   failed    - the step did not happen
 */
export type StepStage = 'requested' | 'started' | 'done' | 'failed' | 'skipped';

export interface StepResult {
  ok: boolean;
  stage: StepStage;
  message: string;
  pid?: number;
}

export interface Launcher {
  openUrl(url: string, browser: BrowserRef, newWindow: boolean): Promise<StepResult>;
  launchApp(appId: string): Promise<StepResult>;
  openFolder(path: string): Promise<StepResult>;
  openInEditor(path: string, editor: 'preferred' | 'vscode' | 'cursor' | 'explorer'): Promise<StepResult>;
  /** shutdown.exe /s|/r /t <delay>, or /a to abort a pending one. */
  power(op: 'shutdown' | 'restart' | 'cancel', delaySeconds: number): Promise<StepResult>;
  /** True if `appId` refers to an approved app, a detected browser or a detected editor. */
  isKnownApp(appId: string): boolean;
  appName(appId: string): string | undefined;
}

export interface AssistantControls {
  speak(text: string): void;
  setVoiceMuted(muted: boolean): void;
  stopListening(): void;
  hideOrb(): void;
  cancel(): void;
  statusText(): string;
  helpText(): string;
}

export interface ActionContext {
  settings: Settings;
  launcher: Launcher;
  assistant: AssistantControls;
  sleep(ms: number): Promise<void>;
}

export type Risk = { level: 'safe' } | { level: 'confirm'; reason: string } | { level: 'deny'; reason: string };

export interface PolicyContext {
  settings: Settings;
  source: PlanSource;
  isKnownApp(appId: string): boolean;
}

export type { Action, AssistantOp };
