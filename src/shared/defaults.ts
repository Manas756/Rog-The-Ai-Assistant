// Privacy-conscious defaults. Nothing here contains personal data: projects and
// apps start empty and are added by the user in Settings.
import type { CommandInput, Site } from './schemas';

export const DEFAULT_SITES: Site[] = [
  { id: 'leetcode', name: 'LeetCode', url: 'https://leetcode.com/', aliases: ['leet code'] },
  { id: 'youtube-music', name: 'YouTube Music', url: 'https://music.youtube.com/', aliases: ['my music', 'music'] },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/', aliases: [] },
  { id: 'github', name: 'GitHub', url: 'https://github.com/', aliases: [] },
  { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/', aliases: ['my email', 'mail'] },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', aliases: [] },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/', aliases: [] },
  { id: 'cppreference', name: 'cppreference', url: 'https://en.cppreference.com/', aliases: ['c++ reference', 'cpp reference'] },
  { id: 'codeforces', name: 'Codeforces', url: 'https://codeforces.com/', aliases: ['code forces'] },
];

export const DEFAULT_COMMANDS: CommandInput[] = [
  {
    id: 'leetcode-mode',
    name: 'LeetCode mode',
    triggers: ['start leetcode mode', 'leetcode mode', 'start my leetcode session', 'start leetcode session'],
    actions: [{ type: 'workflow', workflowId: 'leetcode' }],
    enabled: true,
    builtin: true,
  },
  {
    id: 'music',
    name: 'Music',
    triggers: ['music', 'open music', 'play music', 'play some music'],
    actions: [{ type: 'open_url', url: 'https://music.youtube.com/' }],
    enabled: true,
    builtin: true,
  },
  {
    id: 'shutdown',
    name: 'Shut down PC',
    triggers: ['shut down', 'shutdown', 'shut down the computer', 'shut down my pc'],
    actions: [{ type: 'power', op: 'shutdown' }],
    response: 'Shutting down. Say cancel shutdown to stop.',
    // Off until you turn it on: it powers off the PC (after the countdown).
    enabled: false,
    builtin: true,
  },
  {
    id: 'restart',
    name: 'Restart PC',
    triggers: ['restart', 'restart the computer', 'restart my pc', 'reboot'],
    actions: [{ type: 'power', op: 'restart' }],
    response: 'Restarting. Say cancel restart to stop.',
    enabled: false,
    builtin: true,
  },
  {
    id: 'cancel-shutdown',
    name: 'Cancel shutdown',
    triggers: ['cancel shutdown', 'cancel shut down', 'cancel restart', 'abort shutdown', 'stop the shutdown'],
    actions: [{ type: 'power', op: 'cancel' }],
    response: 'Cancelled.',
    enabled: true,
    builtin: true,
  },
  {
    id: 'mute-voice',
    name: 'Mute voice',
    triggers: ['mute yourself', 'be quiet', 'stop talking', 'mute your voice'],
    actions: [{ type: 'assistant', op: 'mute_voice' }],
    enabled: true,
    builtin: true,
  },
  {
    id: 'unmute-voice',
    name: 'Unmute voice',
    triggers: ['unmute yourself', 'you can talk', 'unmute your voice'],
    actions: [{ type: 'assistant', op: 'unmute_voice' }],
    enabled: true,
    builtin: true,
  },
  {
    id: 'stop-listening',
    name: 'Stop listening',
    triggers: ['stop listening', 'turn off the microphone', 'go to sleep'],
    actions: [{ type: 'assistant', op: 'stop_listening' }],
    enabled: true,
    builtin: true,
  },
  {
    id: 'status',
    name: 'Status',
    triggers: ['what command are you executing', 'what are you doing', 'what was the last command', 'status'],
    actions: [{ type: 'assistant', op: 'status' }],
    enabled: true,
    builtin: true,
  },
  {
    id: 'hide',
    name: 'Hide orb',
    triggers: ['hide yourself', 'hide the orb', 'disappear'],
    actions: [{ type: 'assistant', op: 'hide_orb' }],
    enabled: true,
    builtin: true,
  },
  {
    id: 'help',
    name: 'Help',
    triggers: ['what can you do', 'help', 'help me'],
    actions: [{ type: 'assistant', op: 'help' }],
    enabled: true,
    builtin: true,
  },
  {
    id: 'cancel',
    name: 'Cancel',
    triggers: ['cancel', 'never mind', 'nevermind', 'forget it'],
    actions: [{ type: 'assistant', op: 'cancel' }],
    enabled: true,
    builtin: true,
  },
];

/** Templates that take free dictation after a fixed prefix. */
export const DICTATION_PREFIXES = [
  'search youtube for',
  'search youtube music for',
  'search google for',
  'search github for',
  'search leet code for',
  'search stack overflow for',
  'search for',
  'google',
  'look up',
];
