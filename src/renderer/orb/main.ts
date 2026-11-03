// Orb page: connects state snapshots from main to the renderer and the status
// bubble, owns the microphone, and handles the orb's tiny pointer surface
// (click = push-to-talk, drag = move, right-click = menu).
import type { OrbApi } from '../../shared/ipc';
import type { StateSnapshot } from '../../shared/stateMachine';
import { MicCapture, describeMicError } from './micCapture';
import { OrbRenderer } from './orbRenderer';
import { GEOMETRY } from './theme';

declare global {
  interface Window {
    rog: OrbApi;
  }
}

const rog = window.rog;
const canvas = document.getElementById('orb') as HTMLCanvasElement;
const bubble = document.getElementById('bubble') as HTMLDivElement;
const bubbleText = document.getElementById('bubble-text') as HTMLSpanElement;
const chips = document.getElementById('chips') as HTMLDivElement;

const mic = new MicCapture((frame) => rog.sendAudio(frame));
const renderer = new OrbRenderer(canvas, () => mic.read());
const systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedSetting: 'system' | 'on' | 'off' = 'system';
let showTranscript = true;
let lastSnap: StateSnapshot | null = null;

let visual = { density: 1, intensity: 1 };

function applyMotion(): void {
  const reduced = reducedSetting === 'on' || (reducedSetting === 'system' && systemReduced.matches);
  document.documentElement.classList.toggle('reduced', reduced);
  renderer.configure({ ...visual, reducedMotion: reduced });
}

rog.onConfig((c) => {
  reducedSetting = c.reducedMotion;
  showTranscript = c.showTranscript;
  visual = { density: c.particleDensity, intensity: c.intensity };
  applyMotion();
});
systemReduced.addEventListener('change', applyMotion);

// ----------------------------------------------------------------- bubble

let hideTimer = 0;
function bubbleFor(s: StateSnapshot): { text: string; tone: string; sticky: boolean } | null {
  switch (s.state) {
    case 'PROCESSING':
      if (s.label) return { text: s.label, tone: 'quiet', sticky: true };
      return showTranscript && s.transcript ? { text: `“${s.transcript}”`, tone: 'quote', sticky: true } : null;
    case 'LISTENING':
      return s.label ? { text: s.label, tone: 'quiet', sticky: true } : null;
    case 'CONFIRMING':
      return { text: s.confirm?.prompt ?? s.label ?? 'Confirm?', tone: 'confirm', sticky: true };
    case 'EXECUTING':
      return { text: s.label ?? 'Working…', tone: 'active', sticky: true };
    case 'SUCCESS':
      return { text: s.label ?? 'Done.', tone: 'success', sticky: false };
    case 'ERROR':
      return { text: s.label ?? 'Something went wrong.', tone: 'error', sticky: false };
    case 'MUTED':
      return s.label ? { text: s.label, tone: 'error', sticky: false } : null;
    default:
      return null;
  }
}

function renderBubble(s: StateSnapshot): void {
  const b = bubbleFor(s);
  clearTimeout(hideTimer);
  if (!b) {
    bubble.classList.remove('show');
    return;
  }
  bubbleText.textContent = b.text;
  bubble.dataset.tone = b.tone;
  chips.hidden = s.state !== 'CONFIRMING';
  bubble.classList.add('show');
  if (!b.sticky) hideTimer = window.setTimeout(() => bubble.classList.remove('show'), s.state === 'MUTED' ? 5000 : 2600);
}

rog.onState((s) => {
  const prev = lastSnap;
  lastSnap = s;
  renderer.setState(s.state);
  renderer.micOpen = s.micActive;
  if (!prev || prev.state !== s.state || prev.label !== s.label || prev.transcript !== s.transcript) renderBubble(s);
  document.body.dataset.state = s.state;
});

// -------------------------------------------------------------- microphone

let micWanted = false;
rog.onMic(async ({ open, deviceId }) => {
  micWanted = open;
  if (!open) {
    await mic.close();
    rog.micStatus({ open: false });
    return;
  }
  try {
    await mic.open(deviceId);
    if (!micWanted) {
      await mic.close(); // closed again while opening
      return;
    }
    rog.micStatus({ open: true, label: mic.deviceLabel });
  } catch (err) {
    await mic.close();
    rog.micStatus({ open: false, error: describeMicError(err) });
  }
});
navigator.mediaDevices.addEventListener('devicechange', () => {
  // If the active device vanished, the track ends; reopen on the default device.
  if (micWanted && !mic.isOpen) rog.micStatus({ open: false, error: 'Microphone disconnected.' });
});

// --------------------------------------------------------- pointer surface
// The window ignores the mouse except over the orb and the confirmation chips.

let interactive = false;
function setInteractive(on: boolean): void {
  if (on === interactive) return;
  interactive = on;
  rog.setInteractive(on);
  document.body.classList.toggle('hover', on);
}

function overOrb(x: number, y: number): boolean {
  return Math.hypot(x - window.innerWidth / 2, y - GEOMETRY.centerY) <= GEOMETRY.hitRadius;
}

function overChips(e: MouseEvent): boolean {
  return !chips.hidden && bubble.classList.contains('show') && (e.target as Element)?.closest?.('#chips') != null;
}

let press: { x: number; y: number; sx: number; sy: number; dragging: boolean } | null = null;

window.addEventListener('mousemove', (e) => {
  if (press && e.buttons & 1) {
    const dx = e.screenX - press.sx;
    const dy = e.screenY - press.sy;
    if (!press.dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) press.dragging = true;
    if (press.dragging && (dx || dy)) {
      rog.drag(dx, dy);
      press.sx = e.screenX;
      press.sy = e.screenY;
    }
    return;
  }
  setInteractive(overOrb(e.clientX, e.clientY) || overChips(e));
});
window.addEventListener('mouseleave', () => {
  if (!press) setInteractive(false);
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !overOrb(e.clientX, e.clientY)) return;
  press = { x: e.screenX, y: e.screenY, sx: e.screenX, sy: e.screenY, dragging: false };
});
window.addEventListener('mouseup', (e) => {
  if (!press || e.button !== 0) return;
  const wasDrag = press.dragging;
  press = null;
  if (wasDrag) rog.dragEnd();
  else if (overOrb(e.clientX, e.clientY)) rog.click();
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (overOrb(e.clientX, e.clientY)) rog.contextMenu();
});
document.getElementById('yes')!.addEventListener('click', () => rog.confirm(true));
document.getElementById('no')!.addEventListener('click', () => rog.confirm(false));

renderer.start();
