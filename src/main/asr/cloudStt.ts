// Optional cloud transcription through any OpenAI-compatible
// `/audio/transcriptions` endpoint - e.g. Groq (whisper-large-v3-turbo, very fast).
// Off by default. When on, only command utterances (after the wake word) are sent;
// wake-word listening always stays on this PC.
import type { Transcriber } from './whisper';

export interface CloudSttConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export function pcmToWav(pcm: Int16Array): Uint8Array {
  const data = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data.length, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

export function createCloudStt(config: () => CloudSttConfig, apiKey: () => string | null): Transcriber {
  return {
    get ready() {
      const c = config();
      return !!apiKey() && /^https:\/\//.test(c.baseUrl) && !!c.model;
    },
    async transcribe(pcm) {
      const c = config();
      const key = apiKey();
      if (!key) throw new Error('no API key');
      const form = new FormData();
      form.append('file', new Blob([pcmToWav(pcm) as BlobPart], { type: 'audio/wav' }), 'speech.wav');
      form.append('model', c.model);
      form.append('language', 'en');
      form.append('response_format', 'json');
      const t0 = Date.now();
      const res = await fetch(`${c.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(c.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { text?: string };
      return { text: String(body.text ?? ''), ms: Date.now() - t0 };
    },
  };
}
