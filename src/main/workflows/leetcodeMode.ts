// LEETCODE MODE: a built-in workflow that expands into ordinary catalog actions
// from the user's settings, so it goes through the same validation, permission
// and execution path as any other command.
import type { Action, Settings } from '../../shared/schemas';

export function buildLeetcodeActions(settings: Settings): Action[] {
  const lc = settings.leetcode;
  // LeetCode (and extras) in one browser, music possibly in another.
  const tabs = [
    { url: lc.leetcodeUrl, browser: lc.browser },
    { url: lc.playlistUrl || lc.musicUrl, browser: lc.musicBrowser },
    ...lc.extraUrls.map((url) => ({ url, browser: lc.browser })),
  ];
  const urls = tabs.map((t) => t.url);
  const actions: Action[] = [];

  tabs.forEach(({ url, browser }, i) => {
    // A different browser than the previous tab can't "reuse" the new window, so it gets its own.
    const firstInBrowser = i === 0 || tabs[i - 1]!.browser !== browser;
    const newWindow = lc.openMode === 'separate-windows' || (lc.openMode === 'new-window' && firstInBrowser);
    actions.push({ type: 'open_url', url, browser, newWindow });
    // Give a freshly created window a moment to exist so the next URL lands in it as a tab.
    if (i === 0 && lc.openMode === 'new-window' && urls.length > 1) actions.push({ type: 'wait', ms: 700 });
  });

  if (lc.openEditor && lc.editorProjectId) {
    actions.push({ type: 'open_project', projectId: lc.editorProjectId, editor: 'preferred' });
  }
  return actions;
}

/** Replaces `workflow` actions with their expansion. Workflows cannot nest. */
export function expandWorkflows(actions: Action[], settings: Settings): Action[] {
  return actions.flatMap((a) => (a.type === 'workflow' && a.workflowId === 'leetcode' ? buildLeetcodeActions(settings) : [a]));
}

export function workflowResponse(actions: Action[], settings: Settings): string | undefined {
  return actions.some((a) => a.type === 'workflow' && a.workflowId === 'leetcode') ? settings.leetcode.response : undefined;
}
