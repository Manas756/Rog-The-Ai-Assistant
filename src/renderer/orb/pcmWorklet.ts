// AudioWorklet source: converts the 16 kHz float stream to 40 ms int16 frames
// and transfers them (zero-copy) to the orb page, which forwards them to main.
//
// Kept as a string and loaded from a Blob URL: worklet modules are fetched with
// CORS, which file:// pages (Electron's loadFile) can't satisfy.
export const PCM_WORKLET_SOURCE = `
const FRAME = 640; // 40 ms at 16 kHz
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(FRAME);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === FRAME) {
        const out = this.buf.buffer;
        this.port.postMessage(out, [out]);
        this.buf = new Int16Array(FRAME);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('rog-pcm', PcmProcessor);
`;
