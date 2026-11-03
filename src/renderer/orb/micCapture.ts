// Microphone capture in the orb renderer.
//
//   getUserMedia (selected device, echo cancellation + noise suppression)
//     -> AudioContext @ 16 kHz (Chromium resamples properly)
//        -> AnalyserNode   : level + 6 speech bands for the visualizer (stays in this process)
//        -> AudioWorklet   : 40 ms int16 frames -> IPC -> main process VAD
//
// Closing releases the device completely (Windows' mic indicator turns off).
import type { AudioFeatures } from './orbRenderer';
import { PCM_WORKLET_SOURCE } from './pcmWorklet';

export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private wave: Float32Array<ArrayBuffer> | null = null;
  private features: AudioFeatures = { level: 0, bands: new Float32Array(6) };
  private opening: Promise<void> | null = null;
  deviceLabel = '';

  constructor(private readonly onFrame: (frame: ArrayBuffer) => void) {}

  get isOpen(): boolean {
    return !!this.ctx;
  }

  async open(deviceId: string): Promise<void> {
    if (this.opening) await this.opening.catch(() => undefined);
    await this.close();
    this.opening = this.doOpen(deviceId);
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  private async doOpen(deviceId: string): Promise<void> {
    // AGC on: without it a normal speaking voice reached the recognizer nearly
    // silent (Whisper heard only "you"). Noise it pumps up is rejected downstream.
    const base: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId && deviceId !== 'default' ? { ...base, deviceId: { exact: deviceId } } : base,
      });
    } catch (err) {
      // A saved device that was unplugged: fall back to the Windows default.
      if ((err as DOMException).name === 'OverconstrainedError' || (err as DOMException).name === 'NotFoundError') {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: base });
      } else {
        throw err;
      }
    }
    this.deviceLabel = this.stream.getAudioTracks()[0]?.label ?? '';

    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    const workletUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    const src = ctx.createMediaStreamSource(this.stream);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256; // 128 bins of 62.5 Hz
    analyser.smoothingTimeConstant = 0.5;
    src.connect(analyser);

    const worklet = new AudioWorkletNode(ctx, 'rog-pcm', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.onFrame(e.data);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keeps the graph pulled without playing anything
    src.connect(worklet).connect(mute).connect(ctx.destination);

    this.ctx = ctx;
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.wave = new Float32Array(analyser.fftSize);
  }

  async close(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.analyser = null;
    if (ctx) await ctx.close().catch(() => undefined);
  }

  /** Real-time features from the actual microphone signal (called by the renderer each frame). */
  read(): AudioFeatures | null {
    const a = this.analyser;
    if (!a || !this.freq || !this.wave) return null;
    a.getFloatTimeDomainData(this.wave);
    let sum = 0;
    for (let i = 0; i < this.wave.length; i++) sum += this.wave[i]! * this.wave[i]!;
    const rms = Math.sqrt(sum / this.wave.length);
    // Map roughly -50 dBFS..-12 dBFS to 0..1.
    const db = 20 * Math.log10(rms + 1e-8);
    this.features.level = Math.max(0, Math.min(1, (db + 50) / 38));

    a.getByteFrequencyData(this.freq);
    // Six log-spaced bands across the speech range (~125 Hz - 4 kHz).
    const edges = [2, 4, 7, 12, 20, 36, 64];
    for (let b = 0; b < 6; b++) {
      let m = 0;
      for (let i = edges[b]!; i < edges[b + 1]!; i++) m = Math.max(m, this.freq[i]!);
      this.features.bands[b] = Math.max(0, (m - 60) / 170);
    }
    return this.features;
  }
}

export function describeMicError(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone blocked. Allow desktop apps in Windows Settings › Privacy › Microphone.';
  }
  if (name === 'NotFoundError') return 'No microphone found.';
  if (name === 'NotReadableError') return 'The microphone is in use by another app or unavailable.';
  return `Microphone error: ${(err as Error)?.message ?? String(err)}`.slice(0, 180);
}
