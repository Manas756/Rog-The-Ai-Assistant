// The orb's look, in one place. Adjust colors, geometry, timing and per-state
// targets here without touching the renderer.
import type { AssistantState } from '../../shared/stateMachine';

export type RGB = readonly [number, number, number];

export const PALETTE = {
  antiqueGold: [184, 137, 58] as RGB, // #b8893a
  gold: [212, 169, 86] as RGB, // #d4a956
  champagne: [233, 211, 161] as RGB, // #e9d3a1
  highlight: [255, 241, 207] as RGB, // #fff1cf - warm white, used sparingly
  bronze: [107, 74, 28] as RGB, // #6b4a1c
  ember: [196, 92, 58] as RGB, // #c45c3a - restrained amber-red for errors
  graphite: [112, 106, 98] as RGB, // #706a62 - muted state
};

/** Geometry in CSS pixels. The compact orb is ~52 px across. */
export const GEOMETRY = {
  centerY: 36,
  coreRadius: 10.5,
  photonRing: 13,
  diskInner: 15,
  diskOuter: 25,
  diskSquash: 0.26, // vertical scale of the tilted accretion disk
  diskTilt: -0.07, // radians
  waveBase: 19,
  waveMaxAmp: 7,
  hitRadius: 27,
};

/** Smoothing rates (per second) for state parameters. Higher = snappier. */
export const RATES = { fast: 14, normal: 7, slow: 3.2 };

export interface StateTargets {
  /** Accretion ring brightness 0..1.2 */
  ring: number;
  /** Soft warm glow 0..1 */
  glow: number;
  /** Overall orb scale */
  scale: number;
  /** Angular flow speed of disk / particles (radians per second at the inner edge) */
  flow: number;
  /** Radial particle drift: + inward (absorbing), - outward (emitting) */
  inward: number;
  /** Particle visibility 0..1 */
  particles: number;
  /** Audio waveform visibility 0..1 */
  wave: number;
  /** Rotating processing arc 0..1 */
  spin: number;
  /** Error tint 0..1 */
  ember: number;
  /** Desaturation toward graphite 0..1 */
  mute: number;
  /** Slow breathing amplitude 0..1 */
  breathe: number;
}

export const STATE_TARGETS: Record<AssistantState, StateTargets> = {
  IDLE: { ring: 0.62, glow: 0.3, scale: 1, flow: 0.35, inward: 0.04, particles: 0.65, wave: 0, spin: 0, ember: 0, mute: 0, breathe: 0.5 },
  WAKE_DETECTED: { ring: 1.15, glow: 0.95, scale: 1.14, flow: 1.1, inward: 0, particles: 1, wave: 0.35, spin: 0, ember: 0, mute: 0, breathe: 0 },
  LISTENING: { ring: 0.9, glow: 0.55, scale: 1.07, flow: 0.7, inward: 0, particles: 0.8, wave: 1, spin: 0, ember: 0, mute: 0, breathe: 0 },
  PROCESSING: { ring: 0.85, glow: 0.5, scale: 0.97, flow: 1.9, inward: 1, particles: 1, wave: 0, spin: 1, ember: 0, mute: 0, breathe: 0 },
  CONFIRMING: { ring: 0.9, glow: 0.5, scale: 1.04, flow: 0.45, inward: 0, particles: 0.7, wave: 0, spin: 0, ember: 0, mute: 0, breathe: 1 },
  EXECUTING: { ring: 1.1, glow: 0.8, scale: 1.08, flow: 1.4, inward: -0.6, particles: 1, wave: 0, spin: 0.35, ember: 0, mute: 0, breathe: 0 },
  SUCCESS: { ring: 0.8, glow: 0.45, scale: 1, flow: 0.5, inward: 0.1, particles: 0.75, wave: 0, spin: 0, ember: 0, mute: 0, breathe: 0 },
  ERROR: { ring: 0.75, glow: 0.35, scale: 0.98, flow: 0.3, inward: 0, particles: 0.5, wave: 0, spin: 0, ember: 1, mute: 0, breathe: 0.3 },
  MUTED: { ring: 0.32, glow: 0.06, scale: 0.94, flow: 0.08, inward: 0, particles: 0.22, wave: 0, spin: 0, ember: 0, mute: 1, breathe: 0.2 },
};

/** Target frame rates. Idle states render slower: the motion there is slow anyway. */
export const FPS = { active: 60, idle: 15, muted: 6, reduced: 6 };

/** One-shot effects fired on state entry. Durations in ms. */
export const EFFECTS = {
  wake: { coreKickMs: 320, coreDepth: 0.2, pulses: [0, 110], pulseMs: 720, toRadius: 78 },
  executing: { pulseMs: 900, toRadius: 92, sparks: 14 },
  success: { closeMs: 620, fromRadius: 42 },
  error: { pulseMs: 800, toRadius: 48 },
};

export const BASE_PARTICLES = 26;
