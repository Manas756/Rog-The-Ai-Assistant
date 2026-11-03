// Bridge for the settings window: request/response calls only. Every call is
// validated again in the main process; nothing here grants OS access.
import { contextBridge, ipcRenderer } from 'electron';
import { CH, type SettingsApi } from '../shared/ipc';

const invoke = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

const api: SettingsApi = {
  getState: () => invoke(CH.getState),
  updateSettings: (patch) => invoke(CH.updateSettings, patch),
  saveCommand: (cmd) => invoke(CH.saveCommand, cmd),
  deleteCommand: (id) => invoke(CH.deleteCommand, id),
  resetCommand: (id) => invoke(CH.resetCommand, id),
  testCommand: (id) => invoke(CH.testCommand, id),
  runText: (text) => invoke(CH.runText, text),
  importCommands: () => invoke(CH.importCommands),
  exportCommands: () => invoke(CH.exportCommands),
  pickExecutable: (opts) => invoke(CH.pickExecutable, opts),
  pickFolder: () => invoke(CH.pickFolder),
  setApiKey: (key) => invoke(CH.setApiKey, key),
  clearApiKey: () => invoke(CH.clearApiKey),
  setSttKey: (key) => invoke(CH.setSttKey, key),
  clearSttKey: () => invoke(CH.clearSttKey),
  redetect: () => invoke(CH.redetect),
  metrics: () => invoke(CH.metrics),
  setMonitoring: (on) => invoke(CH.setMonitoring, on),
  testSpeak: (text) => invoke(CH.testSpeak, text),
  onState: (cb) => void ipcRenderer.on(CH.settingsState, (_e, s) => cb(s)),
  onHeard: (cb) => void ipcRenderer.on(CH.settingsHeard, (_e, h) => cb(h)),
};

contextBridge.exposeInMainWorld('rogSettings', api);
