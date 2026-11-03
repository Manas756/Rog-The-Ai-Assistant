// Validation schemas shared by the main process, the settings UI and tests.
// Everything that crosses a trust boundary (disk, IPC, LLM output) is parsed
// through one of these before it is used.
import { z } from 'zod';

const id = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/i, 'letters, digits, - and _ only');
const shortText = z.string().trim().min(1).max(120);
const phrase = z.string().trim().min(2).max(100);

/** http(s) URLs only. file:, javascript:, data:, custom protocol handlers are refused. */
export const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'must be an http(s) URL without credentials');

/** Absolute Windows path, no device namespaces or NUL bytes. */
export const windowsPath = z
  .string()
  .trim()
  .min(3)
  .max(260)
  .refine((p) => /^[a-zA-Z]:[\\/]/.test(p) && !p.includes('\0') && !/^\\\\[?.]\\/.test(p), 'must be an absolute path like C:\\folder');

export const exePath = windowsPath.refine((p) => /\.exe$/i.test(p), 'must point to an .exe file');

/** Browser to use: "preferred" (from settings), "system" (Windows default) or a known browser id. */
export const browserRef = z.enum(['preferred', 'system', 'brave', 'chrome', 'edge', 'firefox']);
export type BrowserRef = z.infer<typeof browserRef>;
export type BrowserId = Exclude<BrowserRef, 'preferred' | 'system'>;

export const searchEngine = z.enum(['google', 'youtube', 'youtube_music', 'github', 'leetcode', 'stackoverflow', 'cppreference']);
export type SearchEngine = z.infer<typeof searchEngine>;

export const assistantOp = z.enum(['mute_voice', 'unmute_voice', 'stop_listening', 'status', 'hide_orb', 'help', 'cancel']);
export type AssistantOp = z.infer<typeof assistantOp>;

// ------------------------------------------------------------------- actions
// The complete set of things ROG can do. Nothing outside this union can run.

export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open_url'),
    url: httpUrl,
    browser: browserRef.default('preferred'),
    newWindow: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('web_search'),
    engine: searchEngine,
    query: z.string().trim().min(1).max(300),
    browser: browserRef.default('preferred'),
  }),
  z.object({ type: z.literal('open_app'), appId: id }),
  z.object({ type: z.literal('open_folder'), path: windowsPath }),
  z.object({ type: z.literal('open_project'), projectId: id, editor: z.enum(['preferred', 'vscode', 'cursor', 'explorer']).default('preferred') }),
  z.object({ type: z.literal('workflow'), workflowId: z.enum(['leetcode']) }),
  z.object({ type: z.literal('speak'), text: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(50).max(10_000) }),
  z.object({ type: z.literal('assistant'), op: assistantOp }),
  /** Windows shutdown/restart via shutdown.exe with a cancellable countdown. */
  z.object({ type: z.literal('power'), op: z.enum(['shutdown', 'restart', 'cancel']) }),
]);
export type Action = z.infer<typeof actionSchema>;
export type ActionInput = z.input<typeof actionSchema>;
export type ActionType = Action['type'];

export const MAX_ACTIONS = 12;
export const actionListSchema = z.array(actionSchema).min(1).max(MAX_ACTIONS);

// ------------------------------------------------------------------ commands

export const commandSchema = z.object({
  id,
  name: shortText,
  triggers: z.array(phrase).min(1).max(12),
  actions: actionListSchema,
  response: z.string().trim().max(200).optional(),
  enabled: z.boolean().default(true),
  /** Shipped with ROG; can be edited/disabled but is restored on "reset defaults". */
  builtin: z.boolean().optional(),
  /** Came from an imported file. Imported commands start disabled until the user enables them. */
  imported: z.boolean().optional(),
});
export type Command = z.infer<typeof commandSchema>;
export type CommandInput = z.input<typeof commandSchema>;

export const commandFileSchema = z.object({
  version: z.literal(1),
  commands: z.array(commandSchema).max(500),
});
export type CommandFile = z.infer<typeof commandFileSchema>;

// ------------------------------------------------------------------ settings

const namedEntry = {
  id,
  name: shortText,
  aliases: z.array(phrase).max(10).default([]),
};

export const siteSchema = z.object({ ...namedEntry, url: httpUrl });
/** Microsoft Store app id as listed by Get-StartApps, e.g. "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App". */
export const aumid = z.string().regex(/^[\w.-]+_[a-z0-9]+![\w.-]+$/i, 'must be a Store app id like Publisher.App_hash!App');

/** An approved app: a desktop .exe (optionally with fixed args and working folder) or a Store app. */
export const appSchema = z
  .object({
    ...namedEntry,
    path: exePath.optional(),
    aumid: aumid.optional(),
    args: z.array(z.string().max(300)).max(10).default([]),
    cwd: windowsPath.optional(),
  })
  .refine((a) => !!a.path !== !!a.aumid, 'set either an .exe path or a Store app id');
export const projectSchema = z.object({ ...namedEntry, path: windowsPath });
export type Site = z.infer<typeof siteSchema>;
export type AppEntry = z.infer<typeof appSchema>;
export type Project = z.infer<typeof projectSchema>;

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  voice: z
    .object({
      /** When false ROG never opens the microphone (push-to-talk still can, on demand). */
      monitoring: z.boolean().default(true),
      wakeWordEnabled: z.boolean().default(true),
      wakeWords: z.array(z.string().trim().toLowerCase().min(2).max(40)).min(1).max(8).default(['rog', 'rogue', 'hey rog', 'okay rog']),
      /** 0 = strict (fewer false wakes), 1 = lenient. */
      wakeSensitivity: z.number().min(0).max(1).default(0.6),
      /** 0 = needs loud speech, 1 = picks up quiet speech. */
      vadSensitivity: z.number().min(0).max(1).default(0.7),
      commandTimeoutMs: z.number().int().min(2000).max(30_000).default(7000),
      microphoneId: z.string().max(300).default('default'),
      pushToTalkShortcut: z.string().max(60).default('Control+Alt+R'),
      muteShortcut: z.string().max(60).default('Control+Alt+M'),
      showTranscript: z.boolean().default(true),
      /** whisper = accurate local model (GPU/CPU); windows = the built-in engine only. */
      engine: z.enum(['whisper', 'windows']).default('whisper'),
      whisperDevice: z.enum(['gpu', 'cpu']).default('gpu'),
    })
    .default({}),
  speech: z
    .object({
      enabled: z.boolean().default(true),
      voice: z.string().max(120).default(''),
      rate: z.number().int().min(-10).max(10).default(1),
      volume: z.number().int().min(0).max(100).default(90),
    })
    .default({}),
  orb: z
    .object({
      offsetX: z.number().int().min(-4000).max(4000).default(0),
      offsetY: z.number().int().min(0).max(3000).default(0),
      alwaysOnTop: z.boolean().default(true),
      reducedMotion: z.enum(['system', 'on', 'off']).default('system'),
      /** Multiplies particle count, 0.25 - 2. */
      particleDensity: z.number().min(0.25).max(2).default(1),
      /** Multiplies glow / wave intensity, 0.25 - 1.5. */
      intensity: z.number().min(0.25).max(1.5).default(1),
    })
    .default({}),
  startup: z
    .object({
      launchAtLogin: z.boolean().default(false),
    })
    .default({}),
  browser: z
    .object({
      preferred: browserRef.exclude(['preferred']).default('brave'),
      customPaths: z.record(z.enum(['brave', 'chrome', 'edge', 'firefox']), exePath).default({}),
    })
    .default({}),
  editor: z
    .object({
      preferred: z.enum(['vscode', 'cursor', 'explorer']).default('vscode'),
      customPaths: z.record(z.enum(['vscode', 'cursor']), exePath).default({}),
    })
    .default({}),
  sites: z.array(siteSchema).max(100).default([]),
  apps: z.array(appSchema).max(100).default([]),
  projects: z.array(projectSchema).max(100).default([]),
  leetcode: z
    .object({
      browser: browserRef.default('preferred'),
      /** Browser for the music tab; can differ from the LeetCode browser. */
      musicBrowser: browserRef.default('preferred'),
      /** tabs: reuse the open browser window; new-window: both tabs in a fresh window; separate-windows: one window each. */
      openMode: z.enum(['tabs', 'new-window', 'separate-windows']).default('tabs'),
      leetcodeUrl: httpUrl.default('https://leetcode.com/'),
      musicUrl: httpUrl.default('https://music.youtube.com/'),
      /** Optional playlist; overrides musicUrl when set. */
      playlistUrl: httpUrl.or(z.literal('')).default(''),
      openEditor: z.boolean().default(false),
      editorProjectId: z.string().max(64).default(''),
      extraUrls: z.array(httpUrl).max(5).default([]),
      response: z.string().max(200).default('LeetCode mode is ready. Good luck.'),
    })
    .default({}),
  /** Optional cloud transcription (OpenAI-compatible, e.g. Groq). Off by default. */
  stt: z
    .object({
      cloudEnabled: z.boolean().default(false),
      baseUrl: z.string().trim().max(300).default('https://api.groq.com/openai/v1'),
      model: z.string().trim().min(1).max(100).default('whisper-large-v3-turbo'),
      timeoutMs: z.number().int().min(1000).max(15_000).default(4000),
    })
    .default({}),
  power: z
    .object({
      /** Countdown before shutdown/restart; "ROG, cancel shutdown" aborts it. */
      delaySeconds: z.number().int().min(0).max(120).default(10),
    })
    .default({}),
  llm: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(['anthropic', 'openai-compatible']).default('anthropic'),
      model: z.string().trim().min(1).max(100).default('claude-haiku-5-5'),
      /** For openai-compatible providers, e.g. http://localhost:11434/v1 for Ollama. */
      baseUrl: z.string().trim().max(300).default(''),
      confirmPlans: z.boolean().default(true),
      timeoutMs: z.number().int().min(2000).max(30_000).default(10_000),
    })
    .default({}),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsInput = z.input<typeof settingsSchema>;

/** A deep-partial patch from the settings UI; validated by re-parsing the merged result. */
export const settingsPatchSchema = z.record(z.string(), z.unknown());

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
    .join('; ');
}
