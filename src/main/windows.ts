// Window management: the floating orb and the on-demand settings window.
import { BrowserWindow, screen, type Rectangle } from 'electron';
import { join } from 'node:path';
import type { Settings } from '../shared/schemas';

/** The orb window is larger than the orb so waves and the status bubble have room; it is click-through except over the orb. */
export const ORB_WINDOW = { width: 400, height: 172 };

function lockDown(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

const securePrefs = (preload: string): Electron.WebPreferences => ({
  preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
  devTools: !process.env.ROG_NO_DEVTOOLS,
});

export function orbBounds(settings: Settings, size = ORB_WINDOW): Rectangle {
  const wa = screen.getPrimaryDisplay().workArea;
  const x = Math.round(wa.x + (wa.width - size.width) / 2 + settings.orb.offsetX);
  const y = Math.round(wa.y + settings.orb.offsetY);
  // Keep it on screen even if the display layout changed since the offset was saved.
  return {
    x: Math.min(Math.max(x, wa.x - size.width / 2), wa.x + wa.width - size.width / 2),
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - size.height),
    width: size.width,
    height: size.height,
  };
}

export function createOrbWindow(distDir: string, settings: Settings): BrowserWindow {
  const win = new BrowserWindow({
    ...orbBounds(settings),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Never takes keyboard focus: clicking the orb or animating doesn't steal it from your editor.
    focusable: false,
    show: false,
    title: 'ROG',
    webPreferences: {
      ...securePrefs(join(distDir, 'preload', 'orb.js')),
      // Keep microphone frames flowing while the orb is hidden.
      backgroundThrottling: false,
    },
  });
  lockDown(win);
  win.setAlwaysOnTop(settings.orb.alwaysOnTop, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  void win.loadFile(join(distDir, 'renderer', 'orb', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

export function createSettingsWindow(distDir: string, iconPath: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'ROG Settings',
    icon: iconPath,
    backgroundColor: '#0b0a09',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0a09', symbolColor: '#c8b48a', height: 38 },
    autoHideMenuBar: true,
    webPreferences: securePrefs(join(distDir, 'preload', 'settings.js')),
  });
  lockDown(win);
  win.setMenu(null);
  void win.loadFile(join(distDir, 'renderer', 'settings', 'index.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}
