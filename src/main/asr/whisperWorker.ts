// Runs in an Electron utility process (plain Node, isolated from the main process).
// Loads OpenAI Whisper (ONNX, via transformers.js + Microsoft-signed ONNX Runtime)
// from local files only and transcribes 16 kHz PCM utterances on request.
//
// A vocabulary prompt (ROG + your command words) is fed as Whisper's "previous
// text". Without it Whisper writes "Rog" as "Raj"/"Rach"; with it, "ROG".
//
// GPU (DirectML) first: ~0.15-0.25 s per command on an RTX 4050; CPU (int8) fallback.

interface Port {
  on(event: 'message', fn: (e: { data: unknown }) => void): void;
  postMessage(msg: unknown): void;
}
const port = (process as unknown as { parentPort: Port }).parentPort;

interface Loaded {
  processor: (audio: Float32Array) => Promise<Record<string, unknown>>;
  tokenizer: {
    encode(text: string, opts: { add_special_tokens: boolean }): number[];
    decode(ids: number[], opts: { skip_special_tokens: boolean }): string;
    convert_tokens_to_ids(tokens: string[]): number[];
  };
  model: { generate(args: Record<string, unknown>): Promise<{ tolist(): unknown[][] }> };
}

let m: Loaded | null = null;
let promptIds: number[] = [];
let queue: Promise<void> = Promise.resolve();
const MAX_PROMPT_TOKENS = 200; // Whisper allows up to 224 tokens of previous text

async function load(modelDir: string, model: string, device: 'gpu' | 'cpu', prompt: string): Promise<void> {
  const t0 = Date.now();
  const tf = await import('@huggingface/transformers');
  tf.env.allowRemoteModels = false; // never downloads at runtime
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = modelDir;
  tf.env.cacheDir = modelDir;

  const attempts: Array<{ device: 'dml' | 'cpu'; dtype: 'fp32' | 'q8' }> =
    device === 'gpu' ? [{ device: 'dml', dtype: 'fp32' }, { device: 'cpu', dtype: 'q8' }] : [{ device: 'cpu', dtype: 'q8' }];
  let lastError: unknown;
  for (const a of attempts) {
    try {
      const processor = await tf.AutoProcessor.from_pretrained(model);
      const tokenizer = await tf.AutoTokenizer.from_pretrained(model);
      const whisper = await tf.WhisperForConditionalGeneration.from_pretrained(model, { device: a.device, dtype: a.dtype });
      m = { processor, tokenizer, model: whisper } as unknown as Loaded;
      setPrompt(prompt);
      await run(new Float32Array(16000)); // warm-up: the first GPU run compiles kernels
      port.postMessage({ type: 'ready', device: a.device === 'dml' ? 'gpu' : 'cpu', loadMs: Date.now() - t0 });
      return;
    } catch (err) {
      lastError = err;
      m = null;
    }
  }
  port.postMessage({ type: 'fatal', msg: lastError instanceof Error ? lastError.message : String(lastError) });
}

function setPrompt(prompt: string): void {
  if (!m) return;
  promptIds = prompt ? m.tokenizer.encode(' ' + prompt.trim(), { add_special_tokens: false }).slice(0, MAX_PROMPT_TOKENS) : [];
}

async function run(audio: Float32Array): Promise<string> {
  const { processor, tokenizer, model } = m!;
  const id = (t: string) => tokenizer.convert_tokens_to_ids([t])[0]!;
  const init = [
    ...(promptIds.length ? [id('<|startofprev|>'), ...promptIds] : []),
    id('<|startoftranscript|>'),
    id('<|notimestamps|>'),
  ];
  const inputs = await processor(audio);
  const out = await model.generate({ ...inputs, decoder_input_ids: init, max_new_tokens: 64 });
  const ids = (out.tolist()[0] as Array<number | bigint>).map(Number).slice(init.length);
  return tokenizer.decode(ids, { skip_special_tokens: true }).trim();
}

function transcribe(id: string, pcm: ArrayBuffer): void {
  queue = queue.then(async () => {
    if (!m) return port.postMessage({ type: 'result', id, error: 'model not loaded' });
    const t0 = Date.now();
    try {
      const int16 = new Int16Array(pcm);
      const audio = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) audio[i] = int16[i]! / 32768;
      port.postMessage({ type: 'result', id, text: await run(audio), ms: Date.now() - t0 });
    } catch (err) {
      port.postMessage({ type: 'result', id, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

port.on('message', (e) => {
  const msg = e.data as { type: string; [k: string]: unknown };
  if (msg.type === 'load') void load(String(msg.modelDir), String(msg.model), msg.device === 'cpu' ? 'cpu' : 'gpu', String(msg.prompt ?? ''));
  else if (msg.type === 'prompt') setPrompt(String(msg.prompt ?? ''));
  else if (msg.type === 'transcribe' && msg.pcm instanceof ArrayBuffer) transcribe(String(msg.id), msg.pcm);
});
