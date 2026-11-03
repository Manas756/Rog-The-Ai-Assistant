// Narrow bridge for the orb window. The renderer is sandboxed with context
// isolation and no Node: these functions are all it can reach.
import { contextBridge, ipcRenderer } from 'electron';
import { CH, type OrbApi } from '../shared/ipc';

const MAX_FRAME_BYTES = 6400; // 200 ms of 16 kHz int16 audio

const api: OrbApi = {
  onState: (cb) => void ipcRenderer.on(CH.orbState, (_e, s) => cb(s)),
  onConfig: (cb) => void ipcRenderer.on(CH.orbConfig, (_e, c) => cb(c)),
  onMic: (cb) => void ipcRenderer.on(CH.orbMic, (_e, m) => cb(m)),
  micStatus: (s) => ipcRenderer.send(CH.orbMicStatus, s),
  sendAudio: (frame) => {
    if (frame instanceof ArrayBuffer && frame.byteLength > 0 && frame.byteLength <= MAX_FRAME_BYTES) {
      ipcRenderer.send(CH.orbAudio, frame);
    }
  },
  setInteractive: (on) => ipcRenderer.send(CH.orbInteractive, on === true),
  drag: (dx, dy) => ipcRenderer.send(CH.orbDrag, { dx, dy }),
  dragEnd: () => ipcRenderer.send(CH.orbDragEnd),
  click: () => ipcRenderer.send(CH.orbClick),
  contextMenu: () => ipcRenderer.send(CH.orbContextMenu),
  confirm: (yes) => ipcRenderer.send(CH.orbConfirm, yes === true),
};

contextBridge.exposeInMainWorld('rog', api);
