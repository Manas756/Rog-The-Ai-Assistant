// Canvas 2D renderer for the golden singularity.
//
// Layers, back to front:
//   glow  ->  gravitational shadow  ->  far half of the accretion disk + particles
//   ->  black core  ->  photon ring + lensed arc  ->  near half of the disk + particles
//   ->  audio waveform  ->  processing arcs  ->  pulses / sparks  ->  mic dot
//
// Each assistant state has a target profile (theme.ts). Every frame the current
// parameters ease toward the target with exponential smoothing, so any state
// can follow any other without a hand-written transition. State *entries* also
// fire short one-shot effects (wake pulse, execution wave, success ring).
import type { AssistantState } from '../../shared/stateMachine';
import { BASE_PARTICLES, EFFECTS, FPS, GEOMETRY as G, PALETTE as P, RATES, STATE_TARGETS, type RGB, type StateTargets } from './theme';

export interface AudioFeatures {
  /** Smoothed loudness 0..1 */
  level: number;
  /** Six log-spaced speech bands, each 0..1 */
  bands: Float32Array;
}

interface Particle {
  theta: number;
  r: number;
  jitter: number;
  size: number;
  fade: number;
}

interface Pulse {
  start: number;
  dur: number;
  from: number;
  to: number;
  width: number;
  alpha: number;
  color: RGB;
  /** Contracting rings fade in then out; expanding ones fade out. */
  contract?: boolean;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
}

const KEYS = Object.keys(STATE_TARGETS.IDLE) as Array<keyof StateTargets>;
const TAU = Math.PI * 2;

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class OrbRenderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private state: AssistantState = 'IDLE';
  private target: StateTargets = { ...STATE_TARGETS.IDLE };
  private cur: StateTargets = { ...STATE_TARGETS.IDLE };
  private particles: Particle[] = [];
  private pulses: Pulse[] = [];
  private sparks: Spark[] = [];
  private coreKick: { start: number; dur: number; depth: number } | null = null;
  private time = 0;
  private last = 0;
  private running = false;
  private handle = 0;
  private timeout = 0;
  private phases = new Float32Array(6).map(() => Math.random() * TAU);
  private audio: AudioFeatures = { level: 0, bands: new Float32Array(6) };
  private density = 1;
  private intensity = 1;
  private reduced = false;
  micOpen = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly readAudio: () => AudioFeatures | null,
  ) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
    this.resize();
    this.seedParticles();
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
    window.addEventListener('resize', () => this.resize());
  }

  configure(opts: { density: number; intensity: number; reducedMotion: boolean }): void {
    this.density = opts.density;
    this.intensity = opts.intensity;
    this.reduced = opts.reducedMotion;
    this.seedParticles();
  }

  setState(state: AssistantState): void {
    if (state === this.state) return;
    const prev = this.state;
    this.state = state;
    this.target = { ...STATE_TARGETS[state] };
    this.onEnter(state, prev);
    this.start();
  }

  start(): void {
    if (this.running || document.hidden) return;
    this.running = true;
    this.last = performance.now();
    this.handle = requestAnimationFrame((t) => this.frame(t));
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
    clearTimeout(this.timeout);
  }

  // ------------------------------------------------------------- setup

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  private seedParticles(): void {
    const n = Math.round(BASE_PARTICLES * this.density);
    this.particles = Array.from({ length: n }, () => this.spawn(true));
  }

  private spawn(anywhere: boolean): Particle {
    const r = anywhere ? G.diskInner + Math.random() * (G.diskOuter * 1.25 - G.diskInner) : G.diskOuter * (1 + Math.random() * 0.3);
    return { theta: Math.random() * TAU, r, jitter: 0.75 + Math.random() * 0.5, size: 0.45 + Math.random() * 0.75, fade: anywhere ? 1 : 0 };
  }

  // ------------------------------------------------------------ effects

  private onEnter(state: AssistantState, prev: AssistantState): void {
    const now = this.time;
    if (this.reduced) return; // brightness/scale easing still conveys the change
    switch (state) {
      case 'WAKE_DETECTED': {
        const e = EFFECTS.wake;
        this.coreKick = { start: now, dur: e.coreKickMs / 1000, depth: e.coreDepth };
        e.pulses.forEach((delay, i) =>
          this.pulses.push({
            start: now + delay / 1000,
            dur: e.pulseMs / 1000,
            from: G.photonRing,
            to: e.toRadius - i * 14,
            width: 1.4 - i * 0.5,
            alpha: 0.75 - i * 0.25,
            color: i === 0 ? P.champagne : P.gold,
          }),
        );
        break;
      }
      case 'EXECUTING': {
        const e = EFFECTS.executing;
        this.pulses.push({ start: now, dur: e.pulseMs / 1000, from: G.photonRing + 2, to: e.toRadius, width: 0.9, alpha: 0.7, color: P.gold });
        for (let i = 0; i < e.sparks; i++) {
          // Mostly downward, toward the status line: the action "leaves" the orb.
          const a = Math.PI / 2 + (Math.random() - 0.5) * 2.4;
          const speed = 45 + Math.random() * 55;
          this.sparks.push({
            x: Math.cos(a) * G.photonRing,
            y: Math.sin(a) * G.photonRing,
            vx: Math.cos(a) * speed,
            vy: Math.sin(a) * speed,
            age: 0,
            life: 0.6 + Math.random() * 0.5,
          });
        }
        break;
      }
      case 'SUCCESS': {
        const e = EFFECTS.success;
        this.pulses.push({ start: now, dur: e.closeMs / 1000, from: e.fromRadius, to: G.photonRing, width: 1.1, alpha: 0.85, color: P.champagne, contract: true });
        break;
      }
      case 'ERROR': {
        const e = EFFECTS.error;
        this.pulses.push({ start: now, dur: e.pulseMs / 1000, from: G.photonRing, to: e.toRadius, width: 1, alpha: 0.6, color: P.ember });
        break;
      }
      case 'PROCESSING':
        if (prev === 'LISTENING') {
          // The heard audio "falls in": a faint ring collapsing onto the core.
          this.pulses.push({ start: now, dur: 0.45, from: G.waveBase + 6, to: G.coreRadius, width: 0.8, alpha: 0.5, color: P.champagne, contract: true });
        }
        break;
    }
  }

  // --------------------------------------------------------------- loop

  private targetFps(): number {
    if (this.reduced) return FPS.reduced;
    const busy = this.pulses.length > 0 || this.sparks.length > 0 || this.coreKick !== null || !this.settled();
    if (busy) return FPS.active;
    if (this.state === 'MUTED') return FPS.muted;
    if (this.state === 'IDLE') return FPS.idle;
    return FPS.active;
  }

  private settled(): boolean {
    return KEYS.every((k) => Math.abs(this.cur[k] - this.target[k]) < 0.01);
  }

  private frame(now: number): void {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.update(dt);
    this.draw();

    // Lower frame rates use a timer so the GPU/compositor isn't woken 60x a second.
    const fps = this.targetFps();
    if (fps >= 60) {
      this.handle = requestAnimationFrame((t) => this.frame(t));
    } else {
      const spent = performance.now() - now;
      this.timeout = window.setTimeout(() => {
        this.handle = requestAnimationFrame((t) => this.frame(t));
      }, Math.max(0, 1000 / fps - spent - 4));
    }
  }

  private update(dt: number): void {
    // Ease every parameter toward the state's target.
    for (const k of KEYS) {
      const rate = k === 'wave' || k === 'inward' ? RATES.normal : k === 'mute' || k === 'ember' ? RATES.slow : RATES.fast * 0.6;
      this.cur[k] += (this.target[k] - this.cur[k]) * (1 - Math.exp(-rate * dt));
    }

    // Real microphone features, sampled only while the waveform is visible.
    if (this.cur.wave > 0.01 || this.target.wave > 0) {
      const a = this.readAudio();
      if (a) {
        // fast attack, slow release
        const k = a.level > this.audio.level ? 0.55 : 0.12;
        this.audio.level += (a.level - this.audio.level) * k;
        for (let i = 0; i < 6; i++) this.audio.bands[i]! += (a.bands[i]! - this.audio.bands[i]!) * (a.bands[i]! > this.audio.bands[i]! ? 0.5 : 0.1);
      }
    } else if (this.audio.level > 0.001) {
      this.audio.level *= 0.9;
    }
    for (let i = 0; i < 6; i++) this.phases[i]! += dt * (0.8 + i * 0.37) * (1 + this.audio.level * 2);

    if (!this.reduced) this.updateParticles(dt);

    for (const s of this.sparks) {
      s.age += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 1 - 1.6 * dt;
      s.vy *= 1 - 1.6 * dt;
    }
    this.sparks = this.sparks.filter((s) => s.age < s.life);
    this.pulses = this.pulses.filter((p) => this.time < p.start + p.dur);
    if (this.coreKick && this.time > this.coreKick.start + this.coreKick.dur) this.coreKick = null;
  }

  private updateParticles(dt: number): void {
    const { flow, inward } = this.cur;
    const core = G.coreRadius * this.cur.scale;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]!;
      // Keplerian-ish: inner particles orbit faster.
      p.theta += flow * Math.pow(G.diskInner / p.r, 1.5) * p.jitter * dt;
      // Inward drift accelerates as particles approach the core (spiral when absorbing).
      p.r -= inward * (4 + 26 * (G.diskOuter / p.r - 0.6)) * p.jitter * dt;
      p.fade = Math.min(1, p.fade + dt * 1.5);
      if (p.r < core + 0.8 || p.r > G.diskOuter * 2.1) {
        const fresh = this.spawn(false);
        if (inward < 0) fresh.r = G.diskInner + Math.random() * 3;
        this.particles[i] = fresh;
      }
    }
  }

  // --------------------------------------------------------------- draw

  private draw(): void {
    const { ctx, cur } = this;
    const cx = this.w / 2;
    const cy = G.centerY;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const breathe = 1 + cur.breathe * 0.025 * Math.sin(this.time * 1.4);
    const kick = this.coreKickAmount();
    const scale = cur.scale * breathe;
    const tone = mix(mix(P.gold, P.ember, cur.ember), P.graphite, cur.mute);
    const light = mix(mix(P.champagne, P.ember, cur.ember * 0.7), P.graphite, cur.mute);
    const shade = mix(P.bronze, P.graphite, cur.mute);
    const I = this.intensity;

    // 1. Warm glow, very restrained.
    const glowR = 44 * scale;
    const glow = ctx.createRadialGradient(cx, cy, G.coreRadius * scale, cx, cy, glowR);
    glow.addColorStop(0, rgba(tone, 0.16 * cur.glow * I));
    glow.addColorStop(0.45, rgba(shade, 0.06 * cur.glow * I));
    glow.addColorStop(1, rgba(shade, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);

    // 2. Gravitational shadow just outside the core.
    const shadowR = (G.photonRing + 7) * scale;
    const shadow = ctx.createRadialGradient(cx, cy, G.coreRadius * scale * 0.9, cx, cy, shadowR);
    shadow.addColorStop(0, 'rgba(0,0,0,0.55)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.arc(cx, cy, shadowR, 0, TAU);
    ctx.fill();

    // Disk gradient: Doppler-like beaming, slowly rotating so the gold "flows".
    const disk = ctx.createConicGradient(this.time * 0.25 * (0.4 + cur.flow) + 2.6, cx, cy);
    disk.addColorStop(0, rgba(light, 1));
    disk.addColorStop(0.2, rgba(tone, 0.85));
    disk.addColorStop(0.5, rgba(shade, 0.6));
    disk.addColorStop(0.8, rgba(tone, 0.8));
    disk.addColorStop(1, rgba(light, 1));

    // 3. Far half of the disk (behind the core).
    this.drawDisk(cx, cy, scale, disk, Math.PI, TAU);
    this.drawParticles(cx, cy, scale, tone, light, false);

    // 4. Core: nearly pure black, slightly contracted on wake.
    const coreR = G.coreRadius * scale * (1 - kick);
    const core = ctx.createRadialGradient(cx - coreR * 0.25, cy - coreR * 0.3, 0, cx, cy, coreR);
    core.addColorStop(0, '#000000');
    core.addColorStop(0.85, '#020201');
    core.addColorStop(1, '#0b0906');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.fill();

    // 5. Photon ring + lensed arc (the far disk bent over the top of the core).
    const ringA = Math.min(1, cur.ring * I);
    const pr = G.photonRing * scale * (1 - kick * 0.5);
    const pg = ctx.createLinearGradient(cx, cy - pr, cx, cy + pr);
    pg.addColorStop(0, rgba(light, 0.95 * ringA));
    pg.addColorStop(0.55, rgba(tone, 0.55 * ringA));
    pg.addColorStop(1, rgba(shade, 0.35 * ringA));
    ctx.strokeStyle = pg;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, pr, 0, TAU);
    ctx.stroke();
    // Gravitational lensing: light from the far side of the disk bends over the
    // top of the core (bright) and, more faintly, under it.
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = rgba(light, 0.5 * ringA);
    ctx.beginPath();
    ctx.arc(cx, cy, pr + 2.4 * scale, Math.PI + 0.22, TAU - 0.22);
    ctx.stroke();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = rgba(tone, 0.2 * ringA);
    ctx.beginPath();
    ctx.arc(cx, cy, pr + 1.8 * scale, 0.5, Math.PI - 0.5);
    ctx.stroke();

    // 6. Near half of the disk (in front of the core).
    this.drawDisk(cx, cy, scale, disk, 0, Math.PI);
    this.drawParticles(cx, cy, scale, tone, light, true);

    // 7. Audio-reactive waveform (LISTENING).
    if (cur.wave > 0.01) this.drawWave(cx, cy, scale, light, tone);

    // 8. Processing arcs.
    if (cur.spin > 0.01) {
      const r = (G.photonRing + 5.5) * scale;
      const a0 = this.time * 4.2;
      for (let k = 0; k < 2; k++) {
        const start = a0 + k * Math.PI;
        const g = ctx.createConicGradient(start, cx, cy);
        g.addColorStop(0, rgba(light, 0));
        g.addColorStop(0.14, rgba(light, 0.75 * cur.spin));
        g.addColorStop(0.15, rgba(light, 0));
        ctx.strokeStyle = g;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(cx, cy, r, start, start + 0.95);
        ctx.stroke();
      }
    }

    // 9. One-shot pulses and sparks.
    for (const p of this.pulses) {
      const t = (this.time - p.start) / p.dur;
      if (t < 0) continue;
      const e = p.contract ? easeInOut(t) : easeOut(t);
      const r = (p.from + (p.to - p.from) * e) * scale;
      const a = p.contract ? p.alpha * Math.sin(Math.PI * t) : p.alpha * Math.pow(1 - t, 1.6);
      ctx.strokeStyle = rgba(mix(p.color, P.graphite, cur.mute), a * I);
      ctx.lineWidth = Math.max(0.35, p.width * (p.contract ? 1 : 1 - t * 0.6));
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
    }
    ctx.lineCap = 'round';
    for (const s of this.sparks) {
      const a = (1 - s.age / s.life) * 0.95 * I;
      ctx.strokeStyle = rgba(light, a);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(cx + s.x, cy + s.y);
      ctx.lineTo(cx + s.x - s.vx * 0.1, cy + s.y - s.vy * 0.1);
      ctx.stroke();
    }

    // 10. Microphone indicator: present only while the mic stream is open.
    if (this.micOpen) {
      const listening = this.state === 'LISTENING' || this.state === 'WAKE_DETECTED';
      const a = listening ? 0.65 + 0.3 * Math.sin(this.time * 6) : 0.38;
      ctx.fillStyle = rgba(light, a);
      ctx.beginPath();
      ctx.arc(cx, cy + 21 * scale, listening ? 1.5 : 1.1, 0, TAU);
      ctx.fill();
    }
  }

  private coreKickAmount(): number {
    if (!this.coreKick) return 0;
    const t = (this.time - this.coreKick.start) / this.coreKick.dur;
    if (t < 0 || t > 1) return 0;
    // quick contraction, softer release
    const shape = t < 0.25 ? t / 0.25 : Math.pow(1 - (t - 0.25) / 0.75, 2);
    return this.coreKick.depth * shape;
  }

  private drawDisk(cx: number, cy: number, scale: number, grad: CanvasGradient, a0: number, a1: number): void {
    const { ctx, cur } = this;
    const bands = 4;
    ctx.strokeStyle = grad;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const r = (G.diskInner + (G.diskOuter - G.diskInner) * Math.pow(t, 0.9)) * scale;
      // Realistic falloff: the inner edge is hottest.
      ctx.globalAlpha = Math.min(1, cur.ring * this.intensity * (0.85 - t * 0.62));
      ctx.lineWidth = 1.05 - t * 0.5;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * G.diskSquash, G.diskTilt, a0, a1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawParticles(cx: number, cy: number, scale: number, tone: RGB, light: RGB, front: boolean): void {
    const { ctx, cur } = this;
    if (cur.particles < 0.02) return;
    const cos = Math.cos(G.diskTilt);
    const sin = Math.sin(G.diskTilt);
    const core = G.coreRadius * scale;
    for (const p of this.particles) {
      const isFront = Math.sin(p.theta) > 0;
      if (isFront !== front) continue;
      const r = p.r * scale;
      const lx = Math.cos(p.theta) * r;
      const ly = Math.sin(p.theta) * r * G.diskSquash;
      const x = cx + lx * cos - ly * sin;
      const y = cy + lx * sin + ly * cos;
      // Hidden behind the core when on the far side.
      if (!front && Math.hypot(x - cx, y - cy) < core) continue;
      const nearCore = Math.min(1, (p.r - G.coreRadius) / 5);
      const outer = Math.max(0, 1 - Math.max(0, p.r - G.diskOuter) / (G.diskOuter * 0.9));
      const a = cur.particles * p.fade * nearCore * outer * (0.35 + 0.5 * (1 - (p.r - G.diskInner) / (G.diskOuter * 1.3)));
      if (a <= 0.01) continue;
      ctx.fillStyle = rgba(p.size > 0.95 ? light : tone, a * this.intensity);
      ctx.beginPath();
      ctx.arc(x, y, p.size * 0.6, 0, TAU);
      ctx.fill();
    }
  }

  private drawWave(cx: number, cy: number, scale: number, light: RGB, tone: RGB): void {
    const { ctx, cur, audio } = this;
    const N = 128;
    const collapse = 0.55 + 0.45 * cur.wave; // collapses toward the core as it fades
    const amp = G.waveMaxAmp * (this.reduced ? 0 : 1);
    for (let layer = 0; layer < 2; layer++) {
      ctx.beginPath();
      for (let k = 0; k <= N; k++) {
        const th = (k / N) * TAU;
        // Each speech band drives one ripple order; normalized so d stays in [-1, 1].
        let d = 0;
        for (let h = 0; h < 6; h++) d += (audio.bands[h]! * Math.sin((h + 3) * th + this.phases[h]! + layer * 1.3)) / (1 + h * 0.35);
        d /= 3.9;
        const r = (G.waveBase + layer * 3 + audio.level * 3 + d * amp * (0.25 + 0.45 * audio.level)) * scale * collapse;
        const x = cx + Math.cos(th) * r;
        const y = cy + Math.sin(th) * r;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = rgba(layer === 0 ? light : tone, (0.5 - layer * 0.22) * cur.wave * (0.55 + audio.level * 0.8) * this.intensity);
      ctx.lineWidth = 0.85 - layer * 0.25;
      ctx.stroke();
    }
  }
}
