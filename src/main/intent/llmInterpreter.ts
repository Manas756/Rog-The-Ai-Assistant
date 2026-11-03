// Mode B: optional AI-powered interpretation.
//
// Only used when (1) the user enabled it in Settings, (2) a key is available,
// and (3) the local interpreter could not understand the request. The model
// never executes anything: it returns a JSON plan constrained by a JSON schema,
// which is then re-validated with the same zod schemas as every other command
// and passed through the permission policy (LLM plans require confirmation by
// default).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ACTION_CATALOG } from '../../shared/catalog';
import { actionListSchema, formatZodError, type Settings } from '../../shared/schemas';
import type { Interpretation, InterpreterContext } from './types';

const BROWSER_ENUM = ['preferred', 'system', 'brave', 'chrome', 'edge', 'firefox'];

/** JSON schema for structured output. Mirrors shared/schemas.ts actionSchema. */
function actionJsonSchema(ctx: InterpreterContext) {
  const obj = (type: string, props: Record<string, unknown>) => ({
    type: 'object',
    properties: { type: { type: 'string', enum: [type] }, ...props },
    required: ['type', ...Object.keys(props)],
    additionalProperties: false,
  });
  const appIds = [
    ...ctx.settings.apps.map((a) => a.id),
    ...ctx.installedBrowsers.map((b) => `browser-${b}`),
    ...ctx.installedEditors.map((e) => `editor-${e}`),
  ];
  const variants: unknown[] = [
    obj('open_url', { url: { type: 'string' }, browser: { type: 'string', enum: BROWSER_ENUM }, newWindow: { type: 'boolean' } }),
    obj('web_search', {
      engine: { type: 'string', enum: ['google', 'youtube', 'youtube_music', 'github', 'leetcode', 'stackoverflow', 'cppreference'] },
      query: { type: 'string' },
      browser: { type: 'string', enum: BROWSER_ENUM },
    }),
    obj('workflow', { workflowId: { type: 'string', enum: ['leetcode'] } }),
    obj('speak', { text: { type: 'string' } }),
    obj('wait', { ms: { type: 'integer' } }),
    obj('assistant', { op: { type: 'string', enum: ['mute_voice', 'unmute_voice', 'stop_listening', 'status', 'hide_orb', 'help', 'cancel'] } }),
  ];
  if (appIds.length) variants.push(obj('open_app', { appId: { type: 'string', enum: appIds } }));
  if (ctx.settings.projects.length) {
    variants.push(
      obj('open_project', {
        projectId: { type: 'string', enum: ctx.settings.projects.map((p) => p.id) },
        editor: { type: 'string', enum: ['preferred', 'vscode', 'cursor', 'explorer'] },
      }),
    );
  }
  return {
    type: 'object',
    properties: {
      understood: { type: 'boolean' },
      label: { type: 'string' },
      response: { type: 'string' },
      actions: { type: 'array', items: { anyOf: variants } },
    },
    required: ['understood', 'label', 'response', 'actions'],
    additionalProperties: false,
  };
}

function systemPrompt(ctx: InterpreterContext): string {
  const sites = ctx.settings.sites.map((s) => `- ${s.name}: ${s.url}`).join('\n');
  const projects = ctx.settings.projects.map((p) => `- ${p.id}: ${p.name}`).join('\n') || '(none)';
  const apps =
    [
      ...ctx.settings.apps.map((a) => `- ${a.id}: ${a.name}`),
      ...ctx.installedBrowsers.map((b) => `- browser-${b}: ${b} browser`),
      ...ctx.installedEditors.map((e) => `- editor-${e}: ${e}`),
    ].join('\n') || '(none)';
  const catalog = ACTION_CATALOG.map((c) => `- ${c.type}: ${c.description}`).join('\n');
  return `You translate a spoken request for ROG, a Windows desktop assistant, into a plan of approved actions.
The request is transcribed speech and may contain recognition errors; infer the most likely intent.

Approved action types:
${catalog}

Known websites:
${sites}

Approved apps (open_app appId):
${apps}

Projects (open_project projectId):
${projects}

Rules:
- Use only the action types and ids listed. Never invent app or project ids.
- You cannot run shell commands, scripts, installers, or touch files. If the request needs that, or is unclear, set understood=false with no actions and a short response explaining what you can do instead.
- Prefer one to three actions. "label" is a 2-5 word name for the plan. "response" is one short sentence ROG speaks when done.
- Use browser "preferred" unless the user names a browser. newWindow false unless asked.`;
}

const llmOutputSchema = z.object({
  understood: z.boolean(),
  label: z.string().max(80),
  response: z.string().max(200),
  actions: z.array(z.unknown()).max(12),
});

export interface LlmDeps {
  apiKey(): string | null;
}

export async function interpretWithLlm(text: string, ctx: InterpreterContext, deps: LlmDeps): Promise<Interpretation> {
  const cfg = ctx.settings.llm;
  const key = deps.apiKey();
  if (!cfg.enabled) return { kind: 'unknown', text, reason: 'AI interpretation is off' };
  if (!key && cfg.provider === 'anthropic') return { kind: 'unknown', text, reason: 'no API key is configured' };

  let raw: string;
  try {
    raw = cfg.provider === 'anthropic' ? await callAnthropic(text, ctx, cfg, key!) : await callOpenAiCompatible(text, ctx, cfg, key);
  } catch (err) {
    return { kind: 'unknown', text, reason: `AI service unavailable (${err instanceof Error ? err.message : String(err)})` };
  }

  let parsed: z.infer<typeof llmOutputSchema>;
  try {
    parsed = llmOutputSchema.parse(JSON.parse(raw));
  } catch {
    return { kind: 'unknown', text, reason: 'the AI returned an unreadable plan' };
  }
  if (!parsed.understood || parsed.actions.length === 0) {
    return { kind: 'unknown', text, reason: parsed.response || 'the AI could not map that to an action' };
  }
  // Re-validate every action with the same schema as user commands.
  const actions = actionListSchema.safeParse(parsed.actions);
  if (!actions.success) return { kind: 'unknown', text, reason: `the AI plan was rejected: ${formatZodError(actions.error)}` };

  return {
    kind: 'plan',
    plan: {
      label: parsed.label || 'AI plan',
      actions: actions.data,
      response: parsed.response || undefined,
      source: 'llm',
      confidence: 0.8,
    },
  };
}

async function callAnthropic(text: string, ctx: InterpreterContext, cfg: Settings['llm'], apiKey: string): Promise<string> {
  const client = new Anthropic({ apiKey, timeout: cfg.timeoutMs, maxRetries: 1 });
  // Server-side refusal fallback ("default" routing) keeps a policy decline from
  // silently failing the command; ROG still validates whatever comes back.
  const response = await client.beta.messages.create({
    model: cfg.model,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: actionJsonSchema(ctx) },
    },
    system: systemPrompt(ctx),
    messages: [{ role: 'user', content: text }],
  } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  if (response.stop_reason === 'refusal') throw new Error('request declined');
  const block = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text');
  if (!block) throw new Error('empty response');
  return block.text;
}

/** For local models (e.g. Ollama at http://localhost:11434/v1) or other providers with that API shape. */
async function callOpenAiCompatible(text: string, ctx: InterpreterContext, cfg: Settings['llm'], apiKey: string | null): Promise<string> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('base URL is not set');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(cfg.timeoutMs),
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        {
          role: 'system',
          content: `${systemPrompt(ctx)}\n\nReply with JSON only, matching this schema:\n${JSON.stringify(actionJsonSchema(ctx))}`,
        },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('empty response');
  return content;
}
