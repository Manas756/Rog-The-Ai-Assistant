// The action registry: for every action type in the catalog, how to describe
// it, how risky it is, and how to run it. The executor never runs anything that
// is not in this table, and every entry goes through the Launcher abstraction
// (which is mocked in tests).
import { SEARCH_ENGINE_NAMES, SEARCH_URLS } from '../../shared/catalog';
import type { Action, ActionType } from '../../shared/schemas';
import type { ActionContext, PolicyContext, Risk, StepResult } from './types';

interface ActionImpl<A extends Action> {
  /** Short present-tense status for the bubble: "Opening LeetCode". */
  describe(action: A, ctx: Pick<ActionContext, 'settings' | 'launcher'>): string;
  risk(action: A, ctx: PolicyContext): Risk;
  run(action: A, ctx: ActionContext): Promise<StepResult>;
}

type Registry = { [T in ActionType]: ActionImpl<Extract<Action, { type: T }>> };

const done = (message: string): StepResult => ({ ok: true, stage: 'done', message });

function siteName(url: string, ctx: Pick<ActionContext, 'settings'>): string {
  const site = ctx.settings.sites.find((s) => s.url === url);
  if (site) return site.name;
  if (url === ctx.settings.leetcode.musicUrl || url === ctx.settings.leetcode.playlistUrl) return 'YouTube Music';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'website';
  }
}

function underProject(path: string, ctx: PolicyContext): boolean {
  const p = path.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
  return ctx.settings.projects.some((proj) => {
    const root = proj.path.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
    return p === root || p.startsWith(root + '\\');
  });
}

export const ACTIONS: Registry = {
  open_url: {
    describe: (a, ctx) => `Opening ${siteName(a.url, ctx)}`,
    risk: () => ({ level: 'safe' }), // the schema already restricts it to http(s)
    run: (a, ctx) => ctx.launcher.openUrl(a.url, a.browser, a.newWindow),
  },
  web_search: {
    describe: (a) => `Searching ${SEARCH_ENGINE_NAMES[a.engine] ?? a.engine}`,
    risk: () => ({ level: 'safe' }),
    run: (a, ctx) => ctx.launcher.openUrl(SEARCH_URLS[a.engine]!(a.query), a.browser, false),
  },
  open_app: {
    describe: (a, ctx) => `Opening ${ctx.launcher.appName(a.appId) ?? a.appId}`,
    risk: (a, ctx) =>
      ctx.isKnownApp(a.appId)
        ? ctx.source === 'llm'
          ? { level: 'confirm', reason: `start ${a.appId}` }
          : { level: 'safe' }
        : { level: 'deny', reason: `"${a.appId}" is not in your approved app list` },
    run: (a, ctx) => ctx.launcher.launchApp(a.appId),
  },
  open_folder: {
    describe: () => 'Opening folder',
    // Folders you put in your own commands are trusted; anything else asks first.
    risk: (a, ctx) =>
      underProject(a.path, ctx) || ctx.source === 'command' || ctx.source === 'builtin'
        ? { level: 'safe' }
        : { level: 'confirm', reason: `open ${a.path}` },
    run: (a, ctx) => ctx.launcher.openFolder(a.path),
  },
  open_project: {
    describe: (a, ctx) => `Opening ${ctx.settings.projects.find((p) => p.id === a.projectId)?.name ?? 'project'}`,
    risk: (a, ctx) =>
      ctx.settings.projects.some((p) => p.id === a.projectId)
        ? { level: 'safe' }
        : { level: 'deny', reason: `there is no project called ${a.projectId}` },
    run: async (a, ctx) => {
      const project = ctx.settings.projects.find((p) => p.id === a.projectId);
      if (!project) return { ok: false, stage: 'failed', message: `Unknown project ${a.projectId}` };
      return ctx.launcher.openInEditor(project.path, a.editor);
    },
  },
  workflow: {
    // Workflows are expanded into plain actions before policy and execution.
    describe: () => 'Starting workflow',
    risk: () => ({ level: 'safe' }),
    run: async () => ({ ok: false, stage: 'failed', message: 'Workflows must be expanded before execution' }),
  },
  power: {
    describe: (a, ctx) =>
      a.op === 'cancel' ? 'Cancelling shutdown' : `${a.op === 'shutdown' ? 'Shutting down' : 'Restarting'} in ${ctx.settings.power.delaySeconds} s`,
    // Only from your own commands. The AI interpreter can never power off the PC.
    // Exact-phrase matching and the cancellable countdown guard against mishearing.
    risk: (a, ctx) =>
      ctx.source === 'llm' && a.op !== 'cancel' ? { level: 'deny', reason: 'power actions are never taken from AI plans' } : { level: 'safe' },
    run: (a, ctx) => ctx.launcher.power(a.op, ctx.settings.power.delaySeconds),
  },
  speak: {
    describe: () => 'Speaking',
    risk: () => ({ level: 'safe' }),
    run: async (a, ctx) => {
      ctx.assistant.speak(a.text);
      return done('Spoke');
    },
  },
  wait: {
    describe: () => 'Waiting',
    risk: () => ({ level: 'safe' }),
    run: async (a, ctx) => {
      await ctx.sleep(a.ms);
      return done(`Waited ${a.ms} ms`);
    },
  },
  assistant: {
    describe: (a) =>
      ({
        mute_voice: 'Muting voice',
        unmute_voice: 'Unmuting voice',
        stop_listening: 'Turning microphone off',
        status: 'Checking status',
        hide_orb: 'Hiding',
        help: 'Help',
        cancel: 'Cancelled',
      })[a.op],
    risk: () => ({ level: 'safe' }),
    run: async (a, ctx) => {
      switch (a.op) {
        case 'mute_voice':
          ctx.assistant.setVoiceMuted(true);
          return done('Voice muted');
        case 'unmute_voice':
          ctx.assistant.setVoiceMuted(false);
          ctx.assistant.speak("I'm back.");
          return done('Voice unmuted');
        case 'stop_listening':
          ctx.assistant.stopListening();
          return done('Microphone off');
        case 'status':
          ctx.assistant.speak(ctx.assistant.statusText());
          return done('Reported status');
        case 'help':
          ctx.assistant.speak(ctx.assistant.helpText());
          return done('Explained');
        case 'hide_orb':
          ctx.assistant.hideOrb();
          return done('Hidden');
        case 'cancel':
          ctx.assistant.cancel();
          return done('Cancelled');
      }
    },
  },
};

export function describeAction(action: Action, ctx: Pick<ActionContext, 'settings' | 'launcher'>): string {
  return (ACTIONS[action.type] as ActionImpl<Action>).describe(action, ctx);
}

export function assessAction(action: Action, ctx: PolicyContext): Risk {
  return (ACTIONS[action.type] as ActionImpl<Action>).risk(action, ctx);
}

export function runAction(action: Action, ctx: ActionContext): Promise<StepResult> {
  return (ACTIONS[action.type] as ActionImpl<Action>).run(action, ctx);
}
