// Mode A: local, rule-based command interpretation. No network, no model.
//
// Order of precedence:
//   1. User / built-in commands (trigger phrases, exact then fuzzy)
//   2. Search templates  ("search youtube for X", "google X")
//   3. Open templates    ("open github", "open my rocket.chat project", "launch brave")
// Anything else is "unknown" and may be handed to the optional LLM interpreter.
import { SEARCH_ENGINE_NAMES } from '../../shared/catalog';
import type { Action, BrowserId, SearchEngine } from '../../shared/schemas';
import { canonical, normalizeCommand, similarity } from '../../shared/text';
import type { Interpretation, InterpreterContext, NamedTarget, Plan } from './types';

/** Above this a fuzzy match runs directly; between CLARIFY and ACCEPT ROG asks first. */
export const ACCEPT_SCORE = 0.82;
export const CLARIFY_SCORE = 0.66;
/** Commands that shut down or restart Windows run directly only at (near) exact matches. */
export const POWER_EXACT_SCORE = 0.97;

const BROWSER_NAMES: Record<BrowserId, string[]> = {
  brave: ['brave', 'brave browser'],
  chrome: ['chrome', 'google chrome'],
  edge: ['edge', 'microsoft edge'],
  firefox: ['firefox', 'mozilla firefox'],
};

const ENGINE_WORDS: Array<[SearchEngine, string[]]> = [
  ['youtube_music', ['youtube music']],
  ['youtube', ['youtube']],
  ['google', ['google', 'the web', 'web']],
  ['github', ['github']],
  ['leetcode', ['leetcode']],
  ['stackoverflow', ['stackoverflow']],
  ['cppreference', ['cppreference', 'cpp reference', 'c++ reference']],
];

export function interpretLocally(rawText: string, ctx: InterpreterContext): Interpretation {
  const text = normalizeCommand(rawText, ctx.settings.voice.wakeWords);
  if (!text) return { kind: 'unknown', text, reason: 'empty' };

  const byCommand = matchCommands(text, ctx);
  if (byCommand && byCommand.plan.confidence >= ACCEPT_SCORE) {
    // Shutting down / restarting needs the phrase itself, not something close to it.
    const powers = byCommand.plan.actions.some((a) => a.type === 'power' && a.op !== 'cancel');
    if (powers && byCommand.plan.confidence < POWER_EXACT_SCORE) {
      return { kind: 'clarify', prompt: `Did you mean ${byCommand.name}?`, plan: byCommand.plan };
    }
    return { kind: 'plan', plan: byCommand.plan };
  }

  const search = matchSearch(text);
  if (search) return { kind: 'plan', plan: search };

  const open = matchOpen(text, ctx);
  if (open?.kind === 'plan' || open?.kind === 'clarify') {
    // A weak command match vs. a clear "open X" - prefer the clearer one.
    if (!byCommand || open.plan.confidence >= byCommand.plan.confidence) return open;
  }

  if (byCommand && byCommand.plan.confidence >= CLARIFY_SCORE) {
    return { kind: 'clarify', prompt: `Did you mean ${byCommand.name}?`, plan: byCommand.plan };
  }
  return { kind: 'unknown', text, reason: 'no matching command' };
}

// ------------------------------------------------------------------ commands

function matchCommands(text: string, ctx: InterpreterContext): { plan: Plan; name: string } | null {
  let best: { score: number; plan: Plan; name: string } | null = null;
  for (const cmd of ctx.commands) {
    if (!cmd.enabled) continue;
    for (const trigger of cmd.triggers) {
      const score = Math.max(similarity(text, trigger), containment(text, trigger));
      if (!best || score > best.score) {
        best = {
          score,
          name: cmd.name,
          plan: {
            label: cmd.name,
            actions: cmd.actions,
            response: cmd.response,
            source: cmd.builtin ? 'builtin' : 'command',
            commandId: cmd.id,
            confidence: score,
          },
        };
      }
    }
  }
  return best;
}

/**
 * "can you start youtube now" contains every word of "start youtube", in order:
 * a good guess even though the whole sentences differ. Longer triggers that are
 * fully contained score higher.
 */
export function containment(text: string, trigger: string): number {
  const said = canonical(text).split(' ');
  const want = canonical(trigger).split(' ');
  if (!want.length || want.length > said.length) return 0;
  let i = 0;
  for (const w of said) if (w === want[i]) i++;
  if (i < want.length) return 0;
  // "open game" -> 0.83 (runs); "the game was fun" -> 0.76 (asks first).
  return Math.min(0.95, Math.round((0.7 + 0.25 * (want.length / said.length)) * 1000) / 1000);
}

// -------------------------------------------------------------------- search

function matchSearch(text: string): Plan | null {
  const engineAlt = ENGINE_WORDS.flatMap(([, words]) => words)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
  const patterns: Array<{ re: RegExp; engine: number; query: number }> = [
    // "search youtube for graph algorithms", "search on github for rocket chat"
    { re: new RegExp(`^(?:search|look up|find|look for)\\s+(?:on\\s+)?(${engineAlt})\\s+for\\s+(.+)$`), engine: 1, query: 2 },
    // "search for graph algorithms on youtube"
    { re: new RegExp(`^(?:search|look up|find|look for)\\s+(?:for\\s+)?(.+?)\\s+on\\s+(${engineAlt})$`), engine: 2, query: 1 },
    // "youtube graph algorithms", "google dijkstra"
    { re: new RegExp(`^(google|youtube)\\s+(.+)$`), engine: 1, query: 2 },
  ];
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (!m) continue;
    const engine = engineFromWord(m[p.engine]!);
    const query = m[p.query]!.trim();
    if (engine && query) return searchPlan(engine, query);
  }
  const generic = /^(?:search for|search|look up)\s+(.+)$/.exec(text);
  if (generic) return searchPlan('google', generic[1]!.trim());
  return null;
}

function engineFromWord(word: string): SearchEngine | null {
  for (const [engine, words] of ENGINE_WORDS) if (words.includes(word)) return engine;
  return null;
}

function searchPlan(engine: SearchEngine, query: string): Plan {
  const name = SEARCH_ENGINE_NAMES[engine] ?? engine;
  return {
    label: `Search ${name}`,
    actions: [{ type: 'web_search', engine, query, browser: 'preferred' }],
    response: `Searching ${name} for ${query}.`,
    source: 'rule',
    confidence: 0.95,
  };
}

// ---------------------------------------------------------------------- open

const OPEN_RE = /^(?:open|launch|start|run|go to|show|bring up|show me|take me to|navigate to)\s+(.+)$/;

function matchOpen(text: string, ctx: InterpreterContext): Interpretation | null {
  const m = OPEN_RE.exec(text);
  if (!m) return null;
  let target = m[1]!.replace(/^(?:my|the|up)\s+/, '').trim();
  const wantsProject = /\s+(?:project|repo|repository|code ?base)$/.test(target);
  target = target.replace(/\s+(?:project|repo|repository|code ?base|website|site|app|application|browser)$/, '').trim();
  if (!target) return null;

  const targets = collectTargets(ctx).filter((t) => !wantsProject || t.kind === 'project');
  const scored = targets
    .map((t) => ({ t, score: Math.max(...t.names.map((n) => similarity(target, n))) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < CLARIFY_SCORE) {
    return { kind: 'unknown', text, reason: `I don't know anything called ${target}` };
  }
  const plan = planForTarget(best.t, best.score);
  const runnerUp = scored[1];
  const ambiguous = runnerUp && runnerUp.score >= CLARIFY_SCORE && best.score - runnerUp.score < 0.05 && runnerUp.t.name !== best.t.name;
  if (best.score >= ACCEPT_SCORE && !ambiguous) return { kind: 'plan', plan };
  return { kind: 'clarify', prompt: `Did you mean ${best.t.name}?`, plan };
}

export function collectTargets(ctx: InterpreterContext): NamedTarget[] {
  const out: NamedTarget[] = [];
  const names = (name: string, aliases: string[]) => [name, ...aliases].map(canonical).filter(Boolean);
  for (const p of ctx.settings.projects) out.push({ kind: 'project', id: p.id, name: p.name, names: names(p.name, p.aliases), project: p });
  for (const s of ctx.settings.sites) out.push({ kind: 'site', id: s.id, name: s.name, names: names(s.name, s.aliases), site: s });
  for (const a of ctx.settings.apps) out.push({ kind: 'app', id: a.id, name: a.name, names: names(a.name, a.aliases), app: a });
  for (const b of ctx.installedBrowsers) out.push({ kind: 'browser', id: b, name: BROWSER_NAMES[b][0]!, names: BROWSER_NAMES[b] });
  for (const e of ctx.installedEditors) {
    out.push({
      kind: 'editor',
      id: e,
      name: e === 'vscode' ? 'VS Code' : 'Cursor',
      names: e === 'vscode' ? ['vscode', 'code editor', 'editor', 'visual studio'] : ['cursor', 'cursor editor'],
    });
  }
  return out;
}

function planForTarget(t: NamedTarget, confidence: number): Plan {
  let actions: Action[];
  switch (t.kind) {
    case 'site':
      actions = [{ type: 'open_url', url: t.site!.url, browser: 'preferred', newWindow: false }];
      break;
    case 'project':
      actions = [{ type: 'open_project', projectId: t.id, editor: 'preferred' }];
      break;
    case 'app':
      actions = [{ type: 'open_app', appId: t.id }];
      break;
    case 'browser':
      actions = [{ type: 'open_app', appId: `browser-${t.id}` }];
      break;
    case 'editor':
      actions = [{ type: 'open_app', appId: `editor-${t.id}` }];
      break;
  }
  return {
    label: `Open ${t.name}`,
    actions,
    response: t.kind === 'project' ? `${t.name} is open.` : undefined,
    source: 'rule',
    confidence,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
