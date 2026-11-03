// Application lifecycle: creates stores, the speech host, the assistant, the
// orb and settings windows and the tray, and wires IPC between them.
import { BrowserWindow, Menu, app, dialog, globalShortcut, ipcMain, screen, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_CATALOG } from '../shared/catalog';
import { CH, type Metrics, type OrbConfig, type SettingsState } from '../shared/ipc';
import { type BrowserId, type Settings } from '../shared/schemas';
import { buildGrammar, buildVocabularyPrompt } from './assistant/grammar';
import { Assistant } from './assistant/orchestrator';
import { HybridRecognizer } from './assistant/recognizer';
import { SpeechHost } from './assistant/speechHost';
import { createCloudStt } from './asr/cloudStt';
import { WhisperAsr, whisperModelInstalled } from './asr/whisper';
import { interpretWithLlm } from './intent/llmInterpreter';
import { ipcSchemas } from './ipcSchemas';
import { detectBrowsers, detectEditors, type Detected, type EditorId } from './platform/detect';
import { createLauncher, nodeProcessApi } from './platform/launcher';
import { SecretStore } from './storage/secrets';
import { CommandStore, SettingsStore } from './storage/stores';
import { RogTray } from './tray';
import { ORB_WINDOW, createOrbWindow, createSettingsWindow, orbBounds } from './windows';

const DEV = process.argv.includes('--dev');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('dev.rog.assistant');
  app.whenReady().then(main).catch((err) => {
    dialog.showErrorBox('ROG failed to start', String(err?.stack ?? err));
    app.exit(1);
  });
}

function main(): void {
  Menu.setApplicationMenu(null);
  const distDir = join(__dirname, '..');
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
  const iconDir = join(resourcesDir, 'icons');
  const speechScript = app.isPackaged ? join(resourcesDir, 'speech', 'speech-host.ps1') : join(resourcesDir, 'speech', 'speech-host.ps1');
  const dataDir = app.getPath('userData');

  const settingsStore = new SettingsStore(dataDir);
  const commandStore = new CommandStore(dataDir);
  const secrets = new SecretStore(dataDir);
  const sttSecrets = new SecretStore(dataDir, 'stt-key.bin', ['ROG_STT_API_KEY', 'GROQ_API_KEY']);
  const modelDir = join(resourcesDir, 'models');
  const warnings: string[] = [settingsStore.loadWarning, commandStore.loadWarning].filter((w): w is string => !!w);
  const settings = () => settingsStore.get();

  let browsers: Detected<BrowserId>[] = [];
  let editors: Detected<EditorId>[] = detectEditors(settings().editor.customPaths);
  let speechError: string | undefined;
  let orbVisible = true;
  let quitting = false;

  // --------------------------------------------------------------- security
  // The only permission any page may get is audio capture, and only for our own files.
  const isOurPage = (url: string) => url.startsWith('file://') && decodeURIComponent(url).includes(distDir.replace(/\\/g, '/'));
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const audioOnly = permission === 'media' && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === 'audio');
    cb(!!audioOnly && isOurPage(wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!wc && isOurPage(wc.getURL()));
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    // Renderers load local files only; all network access happens in main.
    cb({ cancel: !/^(file|devtools|data|blob):/.test(details.url) });
  });

  // ----------------------------------------------------------------- speech
  const speech = new SpeechHost(speechScript);
  const vocabulary = () => buildVocabularyPrompt(settings(), commandStore.list());
  const whisper = new WhisperAsr(join(distDir, 'main', 'whisperWorker.js'), modelDir, () => settings().voice.whisperDevice, vocabulary);
  let whisperStatus = whisperModelInstalled(modelDir) ? 'starting…' : 'model not installed (run: npm run setup:whisper)';
  whisper.on('ready', ({ device, loadMs }) => {
    whisperStatus = `ready on ${device === 'gpu' ? 'GPU (DirectML)' : 'CPU'}, loaded in ${(loadMs / 1000).toFixed(1)} s`;
    log(`whisper ${whisperStatus}`);
    pushSettingsState();
  });
  whisper.on('fatal', (msg) => {
    whisperStatus = `failed: ${msg}`;
    log(`whisper: ${msg}`);
    pushSettingsState();
  });
  whisper.on('log', (msg) => log(msg));
  const startWhisper = () => {
    if (settings().voice.engine === 'whisper' && whisperModelInstalled(modelDir)) whisper.start();
  };
  const cloudStt = createCloudStt(() => settings().stt, () => sttSecrets.get());
  const recognizer = new HybridRecognizer(
    speech,
    whisper,
    () => ({
      engine: settings().voice.engine,
      wakeWords: settings().voice.wakeWords,
      cloud: settings().stt.cloudEnabled ? cloudStt : null,
      prompt: vocabulary(),
    }),
    (msg) => log(msg),
  );
  const launcher = createLauncher({
    settings,
    browsers: () => browsers,
    editors: () => editors,
    proc: nodeProcessApi(shell),
  });

  const assistant = new Assistant({
    settings,
    commands: () => commandStore.list(),
    installedBrowsers: () => browsers.map((b) => b.id),
    installedEditors: () => editors.map((e) => e.id),
    speech: recognizer,
    launcher,
    llm: (text, ctx) => interpretWithLlm(text, ctx, { apiKey: () => secrets.get() }),
    setMicOpen: (open) => send(orb, CH.orbMic, { open, deviceId: settings().voice.microphoneId }),
    updateSettings: (patch) => applySettings(patch),
    hideOrb: () => setOrbVisible(false),
    // Called whenever commands/settings change: refresh both recognizers' vocabularies.
    grammar: () => (
      whisper.updatePrompt(),
      buildGrammar(
        settings(),
        commandStore.list(),
        browsers.map((b) => b.id),
        editors.map((e) => e.id),
      )
    ),
  });

  speech.on('ready', () => {
    speechError = undefined;
    pushSettingsState();
  });
  speech.on('fatal', (msg) => {
    speechError = msg;
    log(`speech: ${msg}`);
    pushSettingsState();
  });
  speech.on('tts', (speaking) => assistant.onTts(speaking));
  speech.on('log', (msg) => log(msg));
  assistant.on('log', (msg) => log(msg));
  if (process.env.ROG_DEBUG_AUDIO === '1') {
    // Opt-in diagnostics only: ROG never writes audio to disk otherwise.
    const dir = join(dataDir, 'debug-audio');
    mkdirSync(dir, { recursive: true });
    let n = 0;
    assistant.on('utterance', (pcm, mode) => {
      const file = join(dir, `${Date.now()}-${mode}-${n++ % 20}.wav`);
      writeFileSync(file, wav16k(pcm));
      log(`saved ${file}`);
    });
  }
  assistant.on('heard', (h) => {
    send(settingsWin, CH.settingsHeard, h);
    log(`heard[${h.mode}] "${h.text}" ${h.grammar} ${h.confidence} ${h.accepted ? 'accepted' : 'rejected'} (${h.ms} ms)`);
  });

  // ---------------------------------------------------------------- windows
  let orb: BrowserWindow | null = createOrbWindow(distDir, settings());
  let settingsWin: BrowserWindow | null = null;

  orb.webContents.once('did-finish-load', () => {
    send(orb, CH.orbConfig, orbConfig(settings()));
    send(orb, CH.orbState, assistant.machine.snapshot);
    assistant.start();
  });
  orb.on('closed', () => (orb = null));
  if (DEV) orb.webContents.openDevTools({ mode: 'detach' });

  assistant.machine.onChange((snap, prev) => {
    send(orb, CH.orbState, snap);
    if (snap.state !== prev) {
      if (DEV) log(`state ${prev} -> ${snap.state}${snap.label ? ` (${snap.label})` : ''}`);
      tray?.refresh();
      pushSettingsState();
    }
  });

  function openSettings(): void {
    if (settingsWin) {
      settingsWin.show();
      settingsWin.focus();
      return;
    }
    settingsWin = createSettingsWindow(distDir, join(iconDir, 'icon.png'));
    // Destroyed on close so it costs no memory while you're coding.
    settingsWin.on('closed', () => (settingsWin = null));
  }

  function setOrbVisible(on: boolean): void {
    orbVisible = on;
    if (on) orb?.showInactive();
    else orb?.hide();
    tray?.refresh();
  }

  function repositionOrb(): void {
    orb?.setBounds(orbBounds(settings()));
  }
  screen.on('display-metrics-changed', repositionOrb);
  screen.on('display-added', repositionOrb);
  screen.on('display-removed', repositionOrb);

  // --------------------------------------------------------------- settings
  function applySettings(patch: unknown): { ok: true } | { ok: false; error: string } {
    const before = settings();
    const r = settingsStore.update(patch);
    if (!r.ok) return r;
    const after = r.settings;
    send(orb, CH.orbConfig, orbConfig(after));
    if (JSON.stringify(before.orb) !== JSON.stringify(after.orb)) {
      repositionOrb();
      orb?.setAlwaysOnTop(after.orb.alwaysOnTop, 'screen-saver');
    }
    if (before.voice.microphoneId !== after.voice.microphoneId && after.voice.monitoring) {
      send(orb, CH.orbMic, { open: true, deviceId: after.voice.microphoneId });
    }
    if (before.voice.pushToTalkShortcut !== after.voice.pushToTalkShortcut || before.voice.muteShortcut !== after.voice.muteShortcut) {
      registerShortcuts();
    }
    if (
      JSON.stringify([before.browser.customPaths, before.editor.customPaths]) !==
      JSON.stringify([after.browser.customPaths, after.editor.customPaths])
    ) {
      void redetect();
    }
    if (before.startup.launchAtLogin !== after.startup.launchAtLogin) setLaunchAtLogin(after.startup.launchAtLogin);
    if (before.voice.whisperDevice !== after.voice.whisperDevice && after.voice.engine === 'whisper') {
      whisperStatus = 'restarting…';
      whisper.restart();
    }
    if (before.voice.engine !== after.voice.engine) {
      if (after.voice.engine === 'whisper') startWhisper();
      else whisper.stop();
    }
    assistant.refreshGrammar();
    tray?.refresh();
    pushSettingsState();
    return { ok: true };
  }

  function setLaunchAtLogin(on: boolean): void {
    // Only ever changed by an explicit user action (tray or settings). Default: off.
    app.setLoginItemSettings({
      openAtLogin: on,
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    });
  }

  async function redetect(): Promise<void> {
    browsers = await detectBrowsers(settings().browser.customPaths);
    editors = detectEditors(settings().editor.customPaths);
    const preferred = settings().browser.preferred;
    if (preferred !== 'system' && !browsers.some((b) => b.id === preferred)) {
      const w = `${preferred} was not found. Choose its location in Settings › Browser, or pick another browser.`;
      if (!warnings.includes(w)) warnings.push(w);
    }
    assistant.refreshGrammar();
    pushSettingsState();
  }

  function settingsState(): SettingsState {
    return {
      settings: settings(),
      commands: commandStore.list(),
      catalog: ACTION_CATALOG,
      browsers: browsers.map(({ id, name, path, source }) => ({ id, name, path, source })),
      editors: editors.map(({ id, name, path, source }) => ({ id, name, path, source })),
      voices: speech.voices,
      speechReady: speech.ready,
      speechError,
      secretSource: secrets.source(),
      sttSecretSource: sttSecrets.source(),
      whisperStatus,
      dataDir,
      warnings,
      snapshot: assistant.machine.snapshot,
      wakeThreshold: assistant.wakeThreshold(),
      version: app.getVersion(),
    };
  }

  function pushSettingsState(): void {
    send(settingsWin, CH.settingsState, settingsState());
  }

  // -------------------------------------------------------------- shortcuts
  function registerShortcuts(): void {
    globalShortcut.unregisterAll();
    const v = settings().voice;
    const bind = (accel: string, fn: () => void, what: string) => {
      if (!accel) return;
      try {
        if (!globalShortcut.register(accel, fn)) warnings.push(`The ${what} shortcut ${accel} is used by another app.`);
      } catch {
        warnings.push(`The ${what} shortcut "${accel}" is not a valid key combination.`);
      }
    };
    bind(v.pushToTalkShortcut, () => assistant.pushToTalk(), 'push-to-talk');
    bind(v.muteShortcut, () => assistant.toggleMonitoring(), 'microphone');
  }
  registerShortcuts();

  // ------------------------------------------------------------------- tray
  let tray: RogTray | null = new RogTray(join(iconDir, 'tray.png'), {
    state: () => {
      const snap = assistant.machine.snapshot;
      return {
        monitoring: settings().voice.monitoring,
        voice: settings().speech.enabled,
        orbVisible,
        launchAtLogin: settings().startup.launchAtLogin,
        listening: snap.state === 'LISTENING',
        label: snap.state === 'MUTED' ? 'microphone off' : snap.state === 'IDLE' ? 'listening for "ROG"' : snap.state.toLowerCase().replace('_', ' '),
      };
    },
    pushToTalk: () => assistant.pushToTalk(),
    setMonitoring: (on) => assistant.setMonitoring(on),
    setVoice: (on) => applySettings({ speech: { enabled: on } }),
    setOrbVisible,
    resetOrbPosition: () => applySettings({ orb: { offsetX: 0, offsetY: 0 } }),
    setLaunchAtLogin: (on) => applySettings({ startup: { launchAtLogin: on } }),
    openSettings,
    quit: () => app.quit(),
  });

  // -------------------------------------------------------------------- IPC
  const fromOrb = (e: IpcMainEvent | IpcMainInvokeEvent) => !!orb && e.sender === orb.webContents;
  const fromSettings = (e: IpcMainEvent | IpcMainInvokeEvent) => !!settingsWin && e.sender === settingsWin.webContents;

  ipcMain.on(CH.orbAudio, (e, frame: unknown) => {
    if (!fromOrb(e)) return;
    const pcm = toInt16(frame);
    if (pcm) assistant.onAudioFrame(pcm);
  });
  ipcMain.on(CH.orbMicStatus, (e, raw) => {
    if (!fromOrb(e)) return;
    const s = ipcSchemas.orbMicStatus.safeParse(raw);
    if (s.success) assistant.onMicStatus(s.data);
  });
  ipcMain.on(CH.orbInteractive, (e, raw) => {
    if (!fromOrb(e)) return;
    const on = ipcSchemas.orbInteractive.safeParse(raw);
    if (on.success) orb?.setIgnoreMouseEvents(!on.data, { forward: true });
  });
  ipcMain.on(CH.orbDrag, (e, raw) => {
    if (!fromOrb(e) || !orb) return;
    const d = ipcSchemas.orbDrag.safeParse(raw);
    if (!d.success) return;
    const [x, y] = orb.getPosition() as [number, number];
    orb.setBounds({ x: Math.round(x + d.data.dx), y: Math.round(y + d.data.dy), ...ORB_WINDOW });
  });
  ipcMain.on(CH.orbDragEnd, (e) => {
    if (!fromOrb(e) || !orb) return;
    const [x, y] = orb.getPosition() as [number, number];
    const wa = screen.getPrimaryDisplay().workArea;
    const offsetX = Math.round(x - (wa.x + (wa.width - ORB_WINDOW.width) / 2));
    settingsStore.update({ orb: { offsetX, offsetY: Math.max(0, y - wa.y) } });
    pushSettingsState();
  });
  ipcMain.on(CH.orbClick, (e) => {
    if (fromOrb(e)) assistant.pushToTalk();
  });
  ipcMain.on(CH.orbConfirm, (e, raw) => {
    if (!fromOrb(e)) return;
    const yes = ipcSchemas.orbConfirm.safeParse(raw);
    if (yes.success) assistant.confirm(yes.data);
  });
  ipcMain.on(CH.orbContextMenu, (e) => {
    if (fromOrb(e) && tray) tray.menu().popup();
  });

  type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handle = (ch: string, fn: Handler) =>
    ipcMain.handle(ch, async (e, ...args) => {
      if (!fromSettings(e)) throw new Error('unauthorized sender');
      try {
        return await fn(e, ...args);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  const bad = (what: string) => ({ ok: false as const, error: `invalid ${what}` });

  handle(CH.getState, () => settingsState());
  handle(CH.updateSettings, (_e, patch) => (patch && typeof patch === 'object' ? applySettings(patch) : bad('settings')));
  handle(CH.saveCommand, (_e, cmd) => {
    const r = commandStore.upsert(cmd as never);
    if (r.ok) {
      assistant.refreshGrammar();
      pushSettingsState();
      return { ok: true, warning: r.warning };
    }
    return r;
  });
  handle(CH.deleteCommand, (_e, id) => {
    const p = ipcSchemas.id.safeParse(id);
    if (!p.success) return bad('id');
    const cmd = commandStore.get(p.data);
    if (cmd?.builtin) return { ok: false, error: 'Built-in commands can be disabled but not deleted.' };
    commandStore.remove(p.data);
    assistant.refreshGrammar();
    pushSettingsState();
    return { ok: true };
  });
  handle(CH.resetCommand, (_e, id) => {
    const p = ipcSchemas.id.safeParse(id);
    if (!p.success || !commandStore.resetBuiltin(p.data)) return bad('command');
    assistant.refreshGrammar();
    pushSettingsState();
    return { ok: true };
  });
  handle(CH.testCommand, (_e, id) => {
    const p = ipcSchemas.id.safeParse(id);
    return p.success ? assistant.runCommand(p.data) : bad('id');
  });
  handle(CH.runText, async (_e, text) => {
    const p = ipcSchemas.text.safeParse(text);
    if (!p.success) return bad('text');
    await assistant.runText(p.data);
    return { ok: true };
  });
  handle(CH.importCommands, async () => {
    const res = await dialog.showOpenDialog(settingsWin!, {
      title: 'Import ROG commands',
      filters: [{ name: 'ROG commands', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'cancelled' };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(res.filePaths[0], 'utf8'));
    } catch {
      return { ok: false, error: 'That file is not valid JSON.' };
    }
    const r = commandStore.importFrom(raw);
    if (r.errors.length) return { ok: false, error: r.errors.join('; ') };
    assistant.refreshGrammar();
    pushSettingsState();
    return { ok: true, imported: r.imported };
  });
  handle(CH.exportCommands, async () => {
    const res = await dialog.showSaveDialog(settingsWin!, { title: 'Export ROG commands', defaultPath: 'rog-commands.json' });
    if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
    writeFileSync(res.filePath, JSON.stringify(commandStore.exportAll(), null, 2));
    return { ok: true, path: res.filePath };
  });
  handle(CH.pickExecutable, async (_e, opts) => {
    const o = ipcSchemas.pickExecutable.safeParse(opts);
    const res = await dialog.showOpenDialog(settingsWin!, {
      title: (o.success && o.data?.title) || 'Choose an application',
      filters: [{ name: 'Applications', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  handle(CH.pickFolder, async () => {
    const res = await dialog.showOpenDialog(settingsWin!, { title: 'Choose a folder', properties: ['openDirectory'] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  handle(CH.setApiKey, (_e, key) => {
    const p = ipcSchemas.apiKey.safeParse(key);
    if (!p.success) return bad('key');
    const r = secrets.set(p.data);
    pushSettingsState();
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'failed' };
  });
  handle(CH.setSttKey, (_e, key) => {
    const p = ipcSchemas.apiKey.safeParse(key);
    if (!p.success) return bad('key');
    const r = sttSecrets.set(p.data);
    pushSettingsState();
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'failed' };
  });
  handle(CH.clearSttKey, () => {
    sttSecrets.clear();
    pushSettingsState();
    return { ok: true };
  });
  handle(CH.clearApiKey, () => {
    secrets.clear();
    pushSettingsState();
    return { ok: true };
  });
  handle(CH.redetect, async () => {
    await redetect();
    return { ok: true };
  });
  handle(CH.metrics, (): Metrics => {
    const processes = app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10,
      memoryMB: Math.round(m.memory.workingSetSize / 1024),
    }));
    return {
      processes,
      totalCpu: Math.round(processes.reduce((n, p) => n + p.cpu, 0) * 10) / 10,
      totalMemoryMB: processes.reduce((n, p) => n + p.memoryMB, 0),
    };
  });
  handle(CH.setMonitoring, (_e, on) => {
    const p = ipcSchemas.boolean.safeParse(on);
    if (!p.success) return bad('value');
    assistant.setMonitoring(p.data);
    return { ok: true };
  });
  handle(CH.testSpeak, (_e, text) => {
    const p = ipcSchemas.text.safeParse(text);
    if (!p.success) return bad('text');
    const s = settings().speech;
    speech.speak(p.data, { voice: s.voice || undefined, rate: s.rate, volume: s.volume });
    return { ok: true };
  });

  // -------------------------------------------------------------- lifecycle
  app.on('second-instance', openSettings);
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });
  app.on('before-quit', async (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    globalShortcut.unregisterAll();
    assistant.dispose();
    whisper.stop();
    await speech.stop();
    tray?.destroy();
    tray = null;
    app.exit(0);
  });

  speech.start();
  startWhisper();
  void redetect();
  if (DEV || settingsStore.loadWarning) openSettings();

  function log(msg: string): void {
    if (DEV) console.log(`[rog] ${msg}`);
  }
}

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function orbConfig(s: Settings): OrbConfig {
  return {
    reducedMotion: s.orb.reducedMotion,
    particleDensity: s.orb.particleDensity,
    intensity: s.orb.intensity,
    showTranscript: s.voice.showTranscript,
  };
}

function wav16k(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Accepts an ArrayBuffer or typed-array frame from IPC; returns a copy-safe Int16Array. */
function toInt16(frame: unknown): Int16Array | null {
  let bytes: Uint8Array | null = null;
  if (frame instanceof ArrayBuffer) bytes = new Uint8Array(frame);
  else if (ArrayBuffer.isView(frame)) bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 6400 || bytes.byteLength % 2) return null;
  const copy = new Uint8Array(bytes); // aligned copy
  return new Int16Array(copy.buffer);
}
