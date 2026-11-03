// One-time setup: downloads the Whisper speech model into resources/models so ROG
// can transcribe fully offline, then benchmarks it on a WAV file.
//   node scripts/setup-whisper.mjs [model] [test.wav]
// model defaults to onnx-community/whisper-base.en (~80 MB quantized).
import { env, pipeline } from '@huggingface/transformers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const model = process.argv[2] ?? 'onnx-community/whisper-base.en';
env.cacheDir = join(root, 'resources', 'models');
env.allowRemoteModels = true; // only this setup script downloads; the app runs local-only

console.log(`downloading/loading ${model} into resources/models …`);
let t = Date.now();
// Both variants: fp32 for the GPU (DirectML), q8 for the CPU fallback.
await pipeline('automatic-speech-recognition', model, { dtype: 'fp32', device: 'cpu' });
const asr = await pipeline('automatic-speech-recognition', model, { dtype: 'q8', device: 'cpu' });
console.log(`loaded in ${Date.now() - t} ms`);

const wavPath = process.argv[3];
if (wavPath) {
  const buf = readFileSync(wavPath).subarray(44);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const audio = Float32Array.from(pcm, (s) => s / 32768);
  for (let i = 0; i < 3; i++) {
    t = Date.now();
    const out = await asr(audio);
    console.log(`run ${i + 1}: "${out.text.trim()}"  ${Date.now() - t} ms for ${(audio.length / 16000).toFixed(1)} s of audio`);
  }
}
