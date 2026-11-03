// IPC channel names and the payload types that cross the preload bridge.
// The main process validates every incoming payload (src/main/ipcSchemas.ts);
// renderers never get Node, the filesystem or process control.
import type { CatalogEntry } from './catalog';
import type { Command, Settings } from './schemas';
import type { StateSnapshot } from './stateMachine';

export const CH = {
  // orb -> main
  orbAudio: 'orb:audio',
  orbMicStatus: 'orb:mic-status',
  orbInteractive: 'orb:interactive',
  orbDrag: 'orb:drag',
  orbDragEnd: 'orb:drag-end',
  orbClick: 'orb:click',
  orbContextMenu: 'orb:context-menu',
  orbConfirm: 'orb:confirm',
  // main -> orb
  orbState: 'orb:state',
  orbConfig: 'orb:config',
  orbMic: 'orb:mic',
  // settings <-> main
  getState: 'settings:get-state',
  updateSettings: 'settings:update',
  saveCommand: 'settings:save-command',
  deleteCommand: 'settings:delete-command',
  resetCommand: 'settings:reset-command',
  testCommand: 'settings:test-command',
  runText: 'settings:run-text',
  importCommands: 'settings:import-commands',
  exportCommands: 'settings:export-commands',
  pickExecutable: 'settings:pick-executable',
  pickFolder: 'settings:pick-folder',
  setApiKey: 'settings:set-api-key',
  clearApiKey: 'settings:clear-api-key',
  setSttKey: 'settings:set-stt-key',
  clearSttKey: 'settings:clear-stt-key',
  redetect: 'settings:redetect',
  metrics: 'settings:metrics',
  setMonitoring: 'settings:set-monitoring',
  testSpeak: 'settings:test-speak',
  // main -> settings
  settingsState: 'settings:state',
  settingsHeard: 'settings:heard',
} as const;


export interface OrbConfig {
  reducedMotion: 'system' | 'on' | 'off';
  particleDensity: number;
  intensity: number;
  showTranscript: boolean;
}

export interface MicRequest {
  open: boolean;
  deviceId: string;
}

export interface DetectedApp {
  id: string;
  name: string;
  path: string;
  source: string;
}

export interface SettingsState {
  settings: Settings;
  commands: Command[];
  catalog: CatalogEntry[];
  browsers: DetectedApp[];
  editors: DetectedApp[];
  voices: string[];
  speechReady: boolean;
  speechError?: string;
  secretSource: 'env' | 'stored' | 'none';
  sttSecretSource: 'env' | 'stored' | 'none';
  whisperStatus: string;
  dataDir: string;
  warnings: string[];
  snapshot: StateSnapshot;
  wakeThreshold: number;
  version: string;
}

export interface HeardEntry {
  mode: string;
  text: string | null;
  confidence: number;
  grammar: string;
  accepted: boolean;
  ms: number;
  at: number;
}

export interface Metrics {
  processes: Array<{ type: string; pid: number; cpu: number; memoryMB: number }>;
  totalCpu: number;
  totalMemoryMB: number;
  speechHostPid?: number;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface OrbApi {
  onState(cb: (s: StateSnapshot) => void): void;
  onConfig(cb: (c: OrbConfig) => void): void;
  onMic(cb: (m: MicRequest) => void): void;
  micStatus(s: { open: boolean; error?: string; label?: string }): void;
  sendAudio(frame: ArrayBuffer): void;
  setInteractive(on: boolean): void;
  drag(dx: number, dy: number): void;
  dragEnd(): void;
  click(): void;
  contextMenu(): void;
  confirm(yes: boolean): void;
}

export interface SettingsApi {
  getState(): Promise<SettingsState>;
  updateSettings(patch: unknown): Promise<Result>;
  saveCommand(cmd: unknown): Promise<Result<{ warning?: string }>>;
  deleteCommand(id: string): Promise<Result>;
  resetCommand(id: string): Promise<Result>;
  testCommand(id: string): Promise<Result>;
  runText(text: string): Promise<Result>;
  importCommands(): Promise<Result<{ imported: number }>>;
  exportCommands(): Promise<Result<{ path?: string }>>;
  pickExecutable(opts?: { title?: string }): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  setApiKey(key: string): Promise<Result>;
  clearApiKey(): Promise<Result>;
  setSttKey(key: string): Promise<Result>;
  clearSttKey(): Promise<Result>;
  redetect(): Promise<Result>;
  metrics(): Promise<Metrics>;
  setMonitoring(on: boolean): Promise<Result>;
  testSpeak(text: string): Promise<Result>;
  onState(cb: (s: SettingsState) => void): void;
  onHeard(cb: (h: HeardEntry) => void): void;
}
