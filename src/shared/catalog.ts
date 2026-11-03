// Human-facing description of the approved action catalog. The settings UI
// renders its command editor from this, and the LLM prompt lists it. The
// executable implementations live in src/main/actions/registry.ts.
import type { ActionType } from './schemas';

export type FieldKind = 'text' | 'url' | 'number' | 'boolean' | 'select' | 'path';

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  /** For selects: static options, or a dynamic source the UI fills from settings. */
  options?: Array<{ value: string; label: string }>;
  source?: 'apps' | 'projects' | 'browsers';
  optional?: boolean;
  placeholder?: string;
}

export interface CatalogEntry {
  type: ActionType;
  label: string;
  description: string;
  fields: FieldSpec[];
}

const BROWSER_OPTIONS = [
  { value: 'preferred', label: 'Preferred browser' },
  { value: 'system', label: 'Windows default' },
  { value: 'brave', label: 'Brave' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'edge', label: 'Edge' },
  { value: 'firefox', label: 'Firefox' },
];

export const ACTION_CATALOG: CatalogEntry[] = [
  {
    type: 'open_url',
    label: 'Open website',
    description: 'Opens an http(s) URL in a browser.',
    fields: [
      { key: 'url', label: 'URL', kind: 'url', placeholder: 'https://leetcode.com/' },
      { key: 'browser', label: 'Browser', kind: 'select', options: BROWSER_OPTIONS, optional: true },
      { key: 'newWindow', label: 'New window', kind: 'boolean', optional: true },
    ],
  },
  {
    type: 'web_search',
    label: 'Search the web',
    description: 'Searches a site for a query.',
    fields: [
      {
        key: 'engine',
        label: 'Site',
        kind: 'select',
        options: [
          { value: 'google', label: 'Google' },
          { value: 'youtube', label: 'YouTube' },
          { value: 'youtube_music', label: 'YouTube Music' },
          { value: 'github', label: 'GitHub' },
          { value: 'leetcode', label: 'LeetCode' },
          { value: 'stackoverflow', label: 'Stack Overflow' },
          { value: 'cppreference', label: 'cppreference' },
        ],
      },
      { key: 'query', label: 'Query', kind: 'text' },
      { key: 'browser', label: 'Browser', kind: 'select', options: BROWSER_OPTIONS, optional: true },
    ],
  },
  {
    type: 'open_app',
    label: 'Open application',
    description: 'Starts an approved application from your app list.',
    fields: [{ key: 'appId', label: 'Application', kind: 'select', source: 'apps' }],
  },
  {
    type: 'open_project',
    label: 'Open project',
    description: 'Opens a configured project folder in your editor.',
    fields: [
      { key: 'projectId', label: 'Project', kind: 'select', source: 'projects' },
      {
        key: 'editor',
        label: 'Open with',
        kind: 'select',
        optional: true,
        options: [
          { value: 'preferred', label: 'Preferred editor' },
          { value: 'vscode', label: 'VS Code' },
          { value: 'cursor', label: 'Cursor' },
          { value: 'explorer', label: 'File Explorer' },
        ],
      },
    ],
  },
  {
    type: 'open_folder',
    label: 'Open folder',
    description: 'Opens a folder in File Explorer. Folders outside your projects ask for confirmation.',
    fields: [{ key: 'path', label: 'Folder', kind: 'path' }],
  },
  {
    type: 'workflow',
    label: 'Run workflow',
    description: 'Runs a built-in workflow.',
    fields: [{ key: 'workflowId', label: 'Workflow', kind: 'select', options: [{ value: 'leetcode', label: 'LeetCode mode' }] }],
  },
  {
    type: 'power',
    label: 'Shut down / restart',
    description: 'Shuts down or restarts Windows after the countdown set in Settings. “ROG, cancel shutdown” aborts it.',
    fields: [
      {
        key: 'op',
        label: 'Action',
        kind: 'select',
        options: [
          { value: 'shutdown', label: 'Shut down' },
          { value: 'restart', label: 'Restart' },
          { value: 'cancel', label: 'Cancel a pending shutdown/restart' },
        ],
      },
    ],
  },
  {
    type: 'speak',
    label: 'Say something',
    description: 'ROG speaks a short sentence.',
    fields: [{ key: 'text', label: 'Text', kind: 'text' }],
  },
  {
    type: 'wait',
    label: 'Wait',
    description: 'Pauses between steps (50 ms - 10 s).',
    fields: [{ key: 'ms', label: 'Milliseconds', kind: 'number', placeholder: '800' }],
  },
  {
    type: 'assistant',
    label: 'Control ROG',
    description: 'Mute voice, stop listening, report status, hide the orb.',
    fields: [
      {
        key: 'op',
        label: 'Operation',
        kind: 'select',
        options: [
          { value: 'mute_voice', label: 'Mute voice responses' },
          { value: 'unmute_voice', label: 'Unmute voice responses' },
          { value: 'stop_listening', label: 'Stop listening (microphone off)' },
          { value: 'status', label: 'Report current command' },
          { value: 'hide_orb', label: 'Hide the orb' },
          { value: 'help', label: 'Say what ROG can do' },
          { value: 'cancel', label: 'Cancel' },
        ],
      },
    ],
  },
];

export const SEARCH_URLS: Record<string, (q: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  youtube_music: (q) => `https://music.youtube.com/search?q=${encodeURIComponent(q)}`,
  github: (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
  leetcode: (q) => `https://leetcode.com/problemset/?search=${encodeURIComponent(q)}`,
  stackoverflow: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
  cppreference: (q) => `https://duckduckgo.com/?q=${encodeURIComponent('site:cppreference.com ' + q)}`,
};

export const SEARCH_ENGINE_NAMES: Record<string, string> = {
  google: 'Google',
  youtube: 'YouTube',
  youtube_music: 'YouTube Music',
  github: 'GitHub',
  leetcode: 'LeetCode',
  stackoverflow: 'Stack Overflow',
  cppreference: 'cppreference',
};
