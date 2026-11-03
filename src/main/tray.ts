// System tray: the always-available control surface (mic, voice, orb, settings, quit).
import { Menu, Tray, nativeImage } from 'electron';

export interface TrayActions {
  state(): { monitoring: boolean; voice: boolean; orbVisible: boolean; launchAtLogin: boolean; listening: boolean; label: string };
  pushToTalk(): void;
  setMonitoring(on: boolean): void;
  setVoice(on: boolean): void;
  setOrbVisible(on: boolean): void;
  resetOrbPosition(): void;
  setLaunchAtLogin(on: boolean): void;
  openSettings(): void;
  quit(): void;
}

export class RogTray {
  private tray: Tray;

  constructor(
    iconPath: string,
    private readonly a: TrayActions,
  ) {
    this.tray = new Tray(nativeImage.createFromPath(iconPath));
    this.tray.on('click', () => a.openSettings());
    this.refresh();
  }

  menu(): Menu {
    const s = this.a.state();
    return Menu.buildFromTemplate([
      { label: `ROG — ${s.label}`, enabled: false },
      { type: 'separator' },
      { label: s.listening ? 'Cancel listening' : 'Push to talk', click: () => this.a.pushToTalk() },
      { label: 'Microphone on (wake word)', type: 'checkbox', checked: s.monitoring, click: (i) => this.a.setMonitoring(i.checked) },
      { label: 'Voice responses', type: 'checkbox', checked: s.voice, click: (i) => this.a.setVoice(i.checked) },
      { type: 'separator' },
      { label: 'Show orb', type: 'checkbox', checked: s.orbVisible, click: (i) => this.a.setOrbVisible(i.checked) },
      { label: 'Reset orb position', click: () => this.a.resetOrbPosition() },
      { label: 'Launch at Windows sign-in', type: 'checkbox', checked: s.launchAtLogin, click: (i) => this.a.setLaunchAtLogin(i.checked) },
      { type: 'separator' },
      { label: 'Settings and commands…', click: () => this.a.openSettings() },
      { label: 'Quit ROG', click: () => this.a.quit() },
    ]);
  }

  refresh(): void {
    const s = this.a.state();
    this.tray.setToolTip(`ROG — ${s.label}`);
    this.tray.setContextMenu(this.menu());
  }

  destroy(): void {
    this.tray.destroy();
  }
}
