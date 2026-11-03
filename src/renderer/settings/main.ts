// Settings window. Plain DOM, no framework: every page is rebuilt from the
// latest SettingsState pushed by the main process, and every change is sent
// back as a small patch that main validates before saving.
import type { CatalogEntry, FieldSpec } from '../../shared/catalog';
import type { HeardEntry, SettingsApi, SettingsState } from '../../shared/ipc';
import type { ActionInput, Command, CommandInput } from '../../shared/schemas';

declare global {
  interface Window {
    rogSettings: SettingsApi;
  }
}

const api = window.rogSettings;
const content = document.getElementById('content')!;
const nav = document.getElementById('nav')!;
const pill = document.getElementById('status-pill')!;
const toastEl = document.getElementById('toast')!;

let S: SettingsState;
let page = 'commands';
let editing: CommandInput | null = null;
const heard: HeardEntry[] = [];

// ------------------------------------------------------------------ helpers

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

let toastTimer = 0;
function toast(msg: string, tone: 'ok' | 'error' = 'ok'): void {
  toastEl.textContent = msg;
  toastEl.dataset.tone = tone;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), tone === 'error' ? 5000 : 2200);
}

async function patch(p: unknown, okMsg?: string): Promise<boolean> {
  const r = await api.updateSettings(p);
  if (!r.ok) toast(`Not saved: ${r.error}`, 'error');
  else if (okMsg) toast(okMsg);
  return r.ok;
}

function row(title: string, hint: string | Child, control: Child): HTMLElement {
  return h('div', { class: 'row' }, h('div', { class: 'label' }, h('span', {}, title), hint ? h('span', { class: 'hint' }, hint) : null), control);
}

function toggle(checked: boolean, onChange: (v: boolean) => void, label: string): HTMLInputElement {
  return h('input', { type: 'checkbox', class: 'switch', checked, 'aria-label': label, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });
}

function select(value: string, options: Array<[string, string]>, onChange: (v: string) => void, label: string): HTMLSelectElement {
  const s = h('select', { 'aria-label': label, onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) });
  for (const [v, l] of options) s.append(h('option', { value: v, selected: v === value }, l));
  return s;
}

function slider(value: number, min: number, max: number, step: number, onChange: (v: number) => void, label: string): HTMLInputElement {
  return h('input', { type: 'range', min, max, step, value: String(value), 'aria-label': label, onchange: (e: Event) => onChange(Number((e.target as HTMLInputElement).value)) });
}

function textInput(value: string, onCommit: (v: string) => void, opts: { placeholder?: string; type?: string; label: string; width?: string }): HTMLInputElement {
  const el = h('input', { type: opts.type ?? 'text', value, placeholder: opts.placeholder, 'aria-label': opts.label });
  if (opts.width) el.style.width = opts.width;
  el.addEventListener('change', () => onCommit(el.value.trim()));
  return el;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';

function uniqueId(base: string, taken: string[]): string {
  let id = slug(base);
  for (let n = 2; taken.includes(id); n++) id = `${slug(base)}-${n}`;
  return id;
}

// --------------------------------------------------------------------- nav

const PAGES: Array<[string, string, () => HTMLElement]> = [
  ['commands', 'Commands', pageCommands],
  ['general', 'General', pageGeneral],
  ['voice', 'Voice & microphone', pageVoice],
  ['browser', 'Browser & apps', pageBrowser],
  ['projects', 'Projects & sites', pageProjects],
  ['leetcode', 'LeetCode mode', pageLeetcode],
  ['ai', 'AI interpretation', pageAi],
  ['diagnostics', 'Diagnostics', pageDiagnostics],
];

function renderNav(): void {
  nav.replaceChildren(
    ...PAGES.map(([id, label]) =>
      h('button', { 'aria-current': id === page ? 'page' : undefined, onclick: () => go(id) }, label),
    ),
  );
}

function go(id: string): void {
  page = id;
  renderNav();
  render();
  content.scrollTop = 0;
}

function render(): void {
  const entry = PAGES.find(([id]) => id === page) ?? PAGES[0]!;
  const scroll = content.scrollTop;
  content.replaceChildren(entry[2]());
  content.scrollTop = scroll;
  pill.textContent = stateLabel();
  pill.dataset.state = S.snapshot.state;
}

function stateLabel(): string {
  const s = S.snapshot.state;
  if (s === 'MUTED') return S.snapshot.label ?? 'Microphone off';
  if (s === 'IDLE') return S.settings.voice.wakeWordEnabled ? 'Listening for “ROG”' : 'Push-to-talk only';
  return s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ');
}

function warningsBlock(): HTMLElement | null {
  const items = [...S.warnings];
  if (S.speechError) items.unshift(`Speech engine: ${S.speechError}`);
  if (!items.length) return null;
  return h('div', { class: 'card', style: 'padding:12px 16px;margin-bottom:16px' }, ...items.map((w) => h('div', { class: 'warn' }, w)));
}

// ---------------------------------------------------------------- commands

function pageCommands(): HTMLElement {
  const list = h('div', { class: 'card list' });
  for (const c of S.commands) {
    list.append(
      h(
        'div',
        { class: 'item' },
        h(
          'div',
          { style: 'min-width:0' },
          h('div', { class: 'name' }, c.name, c.builtin ? h('span', { class: 'tag' }, 'built-in') : null, c.imported ? h('span', { class: 'tag' }, 'imported') : null),
          h('div', { class: 'sub' }, c.triggers.map((t) => `“${t}”`).join('  ·  ')),
        ),
        h(
          'div',
          { class: 'actions' },
          toggle(c.enabled, (v) => void saveCommand({ ...c, enabled: v }, v ? `${c.name} enabled` : `${c.name} disabled`), `Enable ${c.name}`),
          h('button', { class: 'btn', onclick: () => void test(c) }, 'Test'),
          h('button', { class: 'btn', onclick: () => edit(structuredClone(c)) }, 'Edit'),
        ),
      ),
    );
  }

  const tryInput = h('input', { type: 'text', placeholder: 'open github', 'aria-label': 'Type a command', style: 'flex:1' });
  const runTyped = async () => {
    if (!tryInput.value.trim()) return;
    const r = await api.runText(tryInput.value.trim());
    if (!r.ok) toast(r.error, 'error');
  };
  tryInput.addEventListener('keydown', (e) => e.key === 'Enter' && void runTyped());

  return h(
    'div',
    { class: 'page' },
    warningsBlock(),
    h('h1', {}, 'Commands'),
    h('p', { class: 'lede' }, 'Teach ROG phrases and what they should do. Actions come from an approved catalog — nothing runs a script or shell command.'),
    h(
      'div',
      { class: 'actions', style: 'margin-bottom:12px' },
      h('button', { class: 'btn primary', onclick: () => edit(newCommand()) }, 'New command'),
      h('button', { class: 'btn', onclick: () => void doImport() }, 'Import…'),
      h('button', { class: 'btn', onclick: () => void doExport() }, 'Export…'),
    ),
    editing ? editor(editing) : null,
    h('h2', {}, 'Your commands'),
    list,
    h('h2', {}, 'Try a command by typing'),
    h('div', { class: 'card', style: 'padding:12px 16px' }, h('div', { class: 'actions' }, tryInput, h('button', { class: 'btn', onclick: () => void runTyped() }, 'Run'))),
    h('p', { class: 'hint' }, 'Typed commands go through the same interpreter, validation and confirmation steps as voice.'),
  );
}

function newCommand(): CommandInput {
  return { id: '', name: '', triggers: [''], actions: [{ type: 'open_url', url: 'https://' }], response: '', enabled: true };
}

function edit(cmd: CommandInput): void {
  editing = cmd;
  render();
  content.querySelector<HTMLInputElement>('.editor input')?.focus();
}

async function test(c: Command): Promise<void> {
  const r = await api.testCommand(c.id);
  if (!r.ok) toast(r.error, 'error');
}

async function saveCommand(cmd: CommandInput, msg = 'Saved'): Promise<boolean> {
  const r = await api.saveCommand(cmd);
  if (!r.ok) {
    toast(r.error, 'error');
    return false;
  }
  toast(r.warning ? `${msg} — note: ${r.warning}` : msg);
  return true;
}

async function doImport(): Promise<void> {
  const r = await api.importCommands();
  if (r.ok) toast(`Imported ${r.imported} command(s). They're disabled until you review and enable them.`);
  else if (r.error !== 'cancelled') toast(r.error, 'error');
}

async function doExport(): Promise<void> {
  const r = await api.exportCommands();
  if (r.ok) toast('Exported');
  else if (r.error !== 'cancelled') toast(r.error, 'error');
}

function editor(cmd: CommandInput): HTMLElement {
  const isNew = !S.commands.some((c) => c.id === cmd.id);
  const existing = S.commands.find((c) => c.id === cmd.id);
  const name = h('input', { type: 'text', value: cmd.name, placeholder: 'Start development mode', 'aria-label': 'Name' });
  name.addEventListener('input', () => (cmd.name = name.value));
  const triggers = h('textarea', { 'aria-label': 'Trigger phrases', placeholder: 'start development mode\nstart dev mode' }, cmd.triggers.join('\n'));
  triggers.addEventListener('input', () => (cmd.triggers = triggers.value.split('\n')));
  const response = h('input', { type: 'text', value: cmd.response ?? '', placeholder: 'Development mode is ready.', 'aria-label': 'Spoken response' });
  response.addEventListener('input', () => (cmd.response = response.value));

  const actionsBox = h('div', {});
  const drawActions = () => {
    actionsBox.replaceChildren(
      ...cmd.actions.map((a, i) =>
        h(
          'div',
          { class: 'action-row' },
          h('span', { class: 'num' }, String(i + 1)),
          actionFields(a, (next) => {
            cmd.actions[i] = next;
            drawActions();
          }),
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => (swap(cmd.actions, i, i - 1), drawActions()) }, '↑'),
            h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', disabled: i === cmd.actions.length - 1, onclick: () => (swap(cmd.actions, i, i + 1), drawActions()) }, '↓'),
            h('button', { class: 'icon-btn', title: 'Remove step', 'aria-label': 'Remove step', onclick: () => (cmd.actions.splice(i, 1), drawActions()) }, '✕'),
          ),
        ),
      ),
    );
  };
  drawActions();

  const add = select('', [['', 'Add a step…'], ...S.catalog.map((c): [string, string] => [c.type, c.label])], (type) => {
    if (!type) return;
    cmd.actions.push(defaultAction(type));
    drawActions();
    add.value = '';
  }, 'Add a step');

  const save = async () => {
    const triggerList = cmd.triggers.map((t) => t.trim()).filter(Boolean);
    const out: CommandInput = {
      ...cmd,
      id: cmd.id || uniqueId(cmd.name || triggerList[0] || 'command', S.commands.map((c) => c.id)),
      name: cmd.name.trim(),
      triggers: triggerList,
      response: cmd.response?.trim() || undefined,
      actions: cmd.actions.map(cleanAction),
    };
    if (await saveCommand(out)) {
      editing = null;
      render();
    }
  };

  return h(
    'div',
    { class: 'card editor' },
    h('h2', { style: 'margin-top:0' }, isNew ? 'New command' : `Edit “${existing?.name ?? cmd.name}”`),
    h('label', { class: 'field' }, h('span', {}, 'Name'), name),
    h('label', { class: 'field' }, h('span', {}, 'Trigger phrases — one per line. Say them after “ROG”.'), triggers),
    h('div', { class: 'field' }, h('span', { class: 'hint' }, 'Steps run in order and stop at the first failure.')),
    actionsBox,
    h('div', { style: 'margin:10px 0 14px' }, add),
    h('label', { class: 'field' }, h('span', {}, 'Spoken response (optional)'), response),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => void save() }, 'Save command'),
      h('button', { class: 'btn', onclick: () => ((editing = null), render()) }, 'Cancel'),
      existing && !existing.builtin
        ? h('button', {
            class: 'btn danger',
            onclick: async () => {
              if (!confirm(`Delete the command “${existing.name}”? This can't be undone.`)) return;
              const r = await api.deleteCommand(existing.id);
              if (r.ok) {
                editing = null;
                toast('Deleted');
              } else toast(r.error, 'error');
            },
          }, 'Delete command')
        : null,
      existing?.builtin
        ? h('button', {
            class: 'btn',
            onclick: async () => {
              const r = await api.resetCommand(existing.id);
              if (r.ok) {
                editing = null;
                toast('Restored default');
              } else toast(r.error, 'error');
            },
          }, 'Restore default')
        : null,
    ),
  );
}

function swap<T>(arr: T[], a: number, b: number): void {
  [arr[a], arr[b]] = [arr[b]!, arr[a]!];
}

function defaultAction(type: string): ActionInput {
  switch (type) {
    case 'open_url':
      return { type: 'open_url', url: 'https://' };
    case 'web_search':
      return { type: 'web_search', engine: 'google', query: '' };
    case 'open_app':
      return { type: 'open_app', appId: appOptions()[0]?.[0] ?? '' };
    case 'open_project':
      return { type: 'open_project', projectId: S.settings.projects[0]?.id ?? '' };
    case 'open_folder':
      return { type: 'open_folder', path: '' };
    case 'workflow':
      return { type: 'workflow', workflowId: 'leetcode' };
    case 'speak':
      return { type: 'speak', text: '' };
    case 'wait':
      return { type: 'wait', ms: 800 };
    default:
      return { type: 'assistant', op: 'status' };
  }
}

function cleanAction(a: ActionInput): ActionInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) if (v !== '' && v !== undefined) out[k] = v;
  return out as ActionInput;
}

function appOptions(): Array<[string, string]> {
  return [
    ...S.browsers.map((b): [string, string] => [`browser-${b.id}`, `${b.name} (browser)`]),
    ...S.editors.map((e): [string, string] => [`editor-${e.id}`, `${e.name} (editor)`]),
    ...S.settings.apps.map((a): [string, string] => [a.id, a.name]),
  ];
}

function actionFields(a: ActionInput, onChange: (a: ActionInput) => void): HTMLElement {
  const entry = S.catalog.find((c) => c.type === a.type) as CatalogEntry;
  const rec = a as Record<string, unknown>;
  const wrap = h('div', {});
  const typeSel = select(a.type, S.catalog.map((c): [string, string] => [c.type, c.label]), (t) => onChange(defaultAction(t)), 'Step type');
  const fields = h('div', { class: 'action-fields' });
  for (const f of entry.fields) fields.append(fieldControl(f, rec, () => onChange({ ...(rec as ActionInput) })));
  wrap.append(h('div', { style: 'margin-bottom:6px' }, typeSel), fields, h('div', { class: 'hint', style: 'margin-top:4px' }, entry.description));
  return wrap;
}

function fieldControl(f: FieldSpec, rec: Record<string, unknown>, changed: () => void): HTMLElement {
  const set = (v: unknown) => {
    rec[f.key] = v;
  };
  let control: HTMLElement;
  if (f.kind === 'select') {
    const opts: Array<[string, string]> =
      f.source === 'apps'
        ? appOptions()
        : f.source === 'projects'
          ? S.settings.projects.map((p): [string, string] => [p.id, p.name])
          : (f.options ?? []).map((o): [string, string] => [o.value, o.label]);
    const value = String(rec[f.key] ?? (f.optional ? opts[0]?.[0] ?? '' : ''));
    if (!opts.length) control = h('span', { class: 'hint' }, f.source === 'projects' ? 'Add a project first' : 'Add an app first');
    else control = select(value, opts, (v) => (set(v), changed()), f.label);
  } else if (f.kind === 'boolean') {
    control = toggle(rec[f.key] === true, (v) => set(v), f.label);
  } else if (f.kind === 'number') {
    const el = h('input', { type: 'number', value: String(rec[f.key] ?? ''), placeholder: f.placeholder, 'aria-label': f.label });
    el.addEventListener('input', () => set(el.value === '' ? undefined : Number(el.value)));
    control = el;
  } else if (f.kind === 'path') {
    const el = h('input', { type: 'text', value: String(rec[f.key] ?? ''), placeholder: 'C:\\path\\to\\folder', 'aria-label': f.label });
    el.addEventListener('input', () => set(el.value.trim()));
    const pick = h('button', {
      class: 'btn',
      onclick: async () => {
        const p = await api.pickFolder();
        if (p) {
          el.value = p;
          set(p);
        }
      },
    }, 'Browse…');
    control = h('div', { class: 'actions' }, el, pick);
  } else {
    const el = h('input', { type: f.kind === 'url' ? 'url' : 'text', value: String(rec[f.key] ?? ''), placeholder: f.placeholder, 'aria-label': f.label });
    el.addEventListener('input', () => set(el.value));
    control = el;
  }
  return h('label', {}, f.label + (f.optional ? ' (optional)' : ''), control);
}

// ----------------------------------------------------------------- general

function pageGeneral(): HTMLElement {
  const s = S.settings;
  return h(
    'div',
    { class: 'page' },
    warningsBlock(),
    h('h1', {}, 'General'),
    h('p', { class: 'lede' }, 'How ROG listens, speaks and appears.'),
    h(
      'div',
      { class: 'card' },
      row('Microphone', 'When off, ROG never opens the mic. Push-to-talk opens it for one command.', toggle(s.voice.monitoring, (v) => void api.setMonitoring(v), 'Microphone')),
      row('Wake word “ROG”', 'Listen for “ROG” while the microphone is on. Off = push-to-talk only.', toggle(s.voice.wakeWordEnabled, (v) => void patch({ voice: { wakeWordEnabled: v } }), 'Wake word')),
      row('Voice responses', 'ROG speaks short confirmations. Independent of listening.', toggle(s.speech.enabled, (v) => void patch({ speech: { enabled: v } }), 'Voice responses')),
      row('Show what ROG heard', 'Briefly shows the transcript under the orb.', toggle(s.voice.showTranscript, (v) => void patch({ voice: { showTranscript: v } }), 'Show transcript')),
    ),
    h('h2', {}, 'Orb'),
    h(
      'div',
      { class: 'card' },
      row('Always on top', null, toggle(s.orb.alwaysOnTop, (v) => void patch({ orb: { alwaysOnTop: v } }), 'Always on top')),
      row('Reduce motion', 'System follows Windows’ animation setting.', select(s.orb.reducedMotion, [['system', 'System'], ['on', 'On'], ['off', 'Off']], (v) => void patch({ orb: { reducedMotion: v } }), 'Reduce motion')),
      row('Particle density', null, slider(s.orb.particleDensity, 0.25, 2, 0.25, (v) => void patch({ orb: { particleDensity: v } }), 'Particle density')),
      row('Glow intensity', null, slider(s.orb.intensity, 0.25, 1.5, 0.05, (v) => void patch({ orb: { intensity: v } }), 'Glow intensity')),
      row('Position', 'Drag the orb to move it.', h('button', { class: 'btn', onclick: () => void patch({ orb: { offsetX: 0, offsetY: 0 } }, 'Orb centered') }, 'Reset to top center')),
    ),
    h('h2', {}, 'Startup'),
    h(
      'div',
      { class: 'card' },
      row('Launch at Windows sign-in', 'Off by default.', toggle(s.startup.launchAtLogin, (v) => void patch({ startup: { launchAtLogin: v } }), 'Launch at sign-in')),
      row(
        'Shutdown / restart countdown',
        'Time to say “ROG, cancel shutdown” before Windows powers off. The Shut down and Restart commands are off until you enable them under Commands.',
        select(String(s.power.delaySeconds), [['0', 'None'], ['5', '5 seconds'], ['10', '10 seconds'], ['20', '20 seconds'], ['30', '30 seconds'], ['60', '1 minute']], (v) => void patch({ power: { delaySeconds: Number(v) } }), 'Countdown'),
      ),
    ),
  );
}

// ------------------------------------------------------------------- voice

let meterStop: (() => void) | null = null;

function pageVoice(): HTMLElement {
  const s = S.settings;
  const micSel = h('select', { 'aria-label': 'Microphone' }, h('option', { value: 'default' }, 'Windows default'));
  void navigator.mediaDevices.enumerateDevices().then((devs) => {
    for (const d of devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')) {
      micSel.append(h('option', { value: d.deviceId, selected: d.deviceId === s.voice.microphoneId }, d.label || 'Microphone'));
    }
  });
  micSel.addEventListener('change', () => void patch({ voice: { microphoneId: micSel.value } }, 'Microphone changed'));

  const bar = h('i', {});
  const meter = h('div', { class: 'meter', 'aria-label': 'Input level' }, bar);
  const testBtn = h('button', { class: 'btn' }, 'Test microphone');
  testBtn.addEventListener('click', async () => {
    if (meterStop) {
      meterStop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: s.voice.microphoneId !== 'default' ? { deviceId: { exact: s.voice.microphoneId } } : true,
      });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      let raf = 0;
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-8);
        bar.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 50) * 100))}%`;
        raf = requestAnimationFrame(tick);
      };
      tick();
      testBtn.textContent = 'Stop test';
      meterStop = () => {
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        bar.style.width = '0';
        testBtn.textContent = 'Test microphone';
        meterStop = null;
      };
    } catch (err) {
      toast(`Microphone unavailable: ${(err as Error).message}`, 'error');
    }
  });

  const log = h('div', { class: 'log', id: 'heard-log' });
  drawHeard(log);

  const voices: Array<[string, string]> = [['', 'System default'], ...S.voices.map((v): [string, string] => [v, v])];
  const speakText = 'Done. Your workspace is ready.';

  return h(
    'div',
    { class: 'page' },
    warningsBlock(),
    h('h1', {}, 'Voice & microphone'),
    h('p', { class: 'lede' }, 'Speech recognition runs on this PC (Whisper, or the Windows engine). Audio never leaves it unless you turn on cloud transcription below.'),
    h(
      'div',
      { class: 'card' },
      row('Microphone', null, micSel),
      row('Level', 'Speak — the bar should move. The meter is local to this window.', h('div', { class: 'actions' }, meter, testBtn)),
    ),
    h('h2', {}, 'What ROG heard'),
    h('div', { class: 'card' }, h('div', { class: 'hint', style: 'padding:10px 16px 0' }, `Say “ROG”. Wake words are accepted at confidence ≥ ${S.wakeThreshold.toFixed(2)}. Use this to tune sensitivity.`), log),
    h('h2', {}, 'Speech engine'),
    h(
      'div',
      { class: 'card' },
      row(
        'Engine',
        'Whisper understands natural speech and accents far better. Windows is the lightweight built-in engine.',
        select(s.voice.engine, [['whisper', 'Whisper (accurate, local)'], ['windows', 'Windows speech (basic)']], (v) => void patch({ voice: { engine: v } }, 'Saved'), 'Engine'),
      ),
      row('Run Whisper on', 'GPU is ~0.5 s per command; CPU ~1.2 s.', select(s.voice.whisperDevice, [['gpu', 'GPU (DirectML)'], ['cpu', 'CPU']], (v) => void patch({ voice: { whisperDevice: v } }, 'Restarting Whisper…'), 'Whisper device')),
      row('Status', null, h('span', { class: S.whisperStatus.startsWith('ready') ? 'hint ok' : 'hint' }, S.whisperStatus)),
    ),
    h('h2', {}, 'Cloud transcription (optional)'),
    h(
      'div',
      { class: 'card' },
      row(
        'Use a cloud transcriber for commands',
        'Off by default. Only what you say after “ROG” is sent; wake-word listening stays on this PC. Works with any OpenAI-compatible /audio/transcriptions API, e.g. Groq.',
        toggle(s.stt.cloudEnabled, (v) => void patch({ stt: { cloudEnabled: v } }), 'Cloud transcription'),
      ),
      row('API base URL', null, textInput(s.stt.baseUrl, (v) => void patch({ stt: { baseUrl: v } }, 'Saved'), { label: 'Transcription base URL', width: '280px' })),
      row('Model', null, textInput(s.stt.model, (v) => void patch({ stt: { model: v } }, 'Saved'), { label: 'Transcription model', width: '220px' })),
      row('API key', S.sttSecretSource === 'env' ? 'Using ROG_STT_API_KEY / GROQ_API_KEY.' : 'Stored encrypted with Windows DPAPI.', sttKeyControl()),
    ),
    h('h2', {}, 'Recognition'),
    h(
      'div',
      { class: 'card' },
      row('Wake word sensitivity', 'Higher = wakes more easily, but more false wakes.', slider(s.voice.wakeSensitivity, 0, 1, 0.05, (v) => void patch({ voice: { wakeSensitivity: v } }), 'Wake sensitivity')),
      row('Speech detection sensitivity', 'Higher = picks up quieter speech, and more background noise.', slider(s.voice.vadSensitivity, 0, 1, 0.05, (v) => void patch({ voice: { vadSensitivity: v } }), 'Speech detection sensitivity')),
      row('Command timeout', 'How long ROG waits for a command after waking.', select(String(s.voice.commandTimeoutMs), [['4000', '4 seconds'], ['7000', '7 seconds'], ['10000', '10 seconds'], ['15000', '15 seconds']], (v) => void patch({ voice: { commandTimeoutMs: Number(v) } }), 'Command timeout')),
      row('Wake words', 'Comma separated. “rogue” helps the recognizer, which doesn’t know “rog”.', textInput(s.voice.wakeWords.join(', '), (v) => void patch({ voice: { wakeWords: v.split(',').map((w) => w.trim()).filter(Boolean) } }, 'Saved'), { label: 'Wake words', width: '240px' })),
      row('Push-to-talk shortcut', 'Press once, then speak. Clicking the orb does the same.', textInput(s.voice.pushToTalkShortcut, (v) => void patch({ voice: { pushToTalkShortcut: v } }, 'Saved'), { label: 'Push-to-talk shortcut', width: '160px' })),
      row('Microphone on/off shortcut', null, textInput(s.voice.muteShortcut, (v) => void patch({ voice: { muteShortcut: v } }, 'Saved'), { label: 'Mute shortcut', width: '160px' })),
    ),
    h('h2', {}, 'Speech output'),
    h(
      'div',
      { class: 'card' },
      row('Voice', null, select(s.speech.voice, voices, (v) => void patch({ speech: { voice: v } }), 'Voice')),
      row('Rate', null, slider(s.speech.rate, -5, 5, 1, (v) => void patch({ speech: { rate: v } }), 'Rate')),
      row('Volume', null, slider(s.speech.volume, 10, 100, 5, (v) => void patch({ speech: { volume: v } }), 'Volume')),
      row('Test', null, h('button', { class: 'btn', onclick: () => void api.testSpeak(speakText) }, 'Speak a sample')),
    ),
  );
}

function sttKeyControl(): HTMLElement {
  const key = h('input', { type: 'password', placeholder: S.sttSecretSource === 'none' ? 'Paste an API key' : '••••••••  (saved)', 'aria-label': 'Transcription API key', style: 'width:200px' });
  return h(
    'div',
    { class: 'actions' },
    key,
    h('button', {
      class: 'btn',
      onclick: async () => {
        const r = await api.setSttKey(key.value);
        key.value = '';
        r.ok ? toast('Key saved') : toast(r.error, 'error');
      },
    }, 'Save'),
    S.sttSecretSource === 'stored' ? h('button', { class: 'btn danger', onclick: async () => (await api.clearSttKey(), toast('Key removed')) }, 'Remove') : null,
  );
}

function drawHeard(log: HTMLElement): void {
  if (!heard.length) {
    log.replaceChildren(h('div', {}, 'Nothing yet.'));
    return;
  }
  log.replaceChildren(
    ...heard
      .slice(-30)
      .reverse()
      .map((e) =>
        h(
          'div',
          { class: e.accepted ? 'accepted' : '' },
          `${new Date(e.at).toLocaleTimeString()}  ${e.mode.padEnd(7)}  ${e.accepted ? '✓' : '·'} ${e.text ?? '(nothing recognized)'}  [${e.grammar || '-'} ${e.confidence.toFixed(2)}, ${e.ms} ms]`,
        ),
      ),
  );
}

// ---------------------------------------------------------- browser & apps

function pageBrowser(): HTMLElement {
  const s = S.settings;
  const browserOpts: Array<[string, string]> = [
    ['system', 'Windows default browser'],
    ...(['brave', 'chrome', 'edge', 'firefox'] as const).map((id): [string, string] => {
      const found = S.browsers.find((b) => b.id === id);
      return [id, `${id.charAt(0).toUpperCase() + id.slice(1)}${found ? '' : ' (not found)'}`];
    }),
  ];
  const detected = h('div', { class: 'card list' });
  for (const id of ['brave', 'chrome', 'edge', 'firefox'] as const) {
    const b = S.browsers.find((x) => x.id === id);
    detected.append(
      h(
        'div',
        { class: 'item' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'name' }, id.charAt(0).toUpperCase() + id.slice(1)), h('div', { class: 'sub' }, b ? `${b.path} (${b.source})` : 'Not found')),
        h('button', {
          class: 'btn',
          onclick: async () => {
            const p = await api.pickExecutable({ title: `Locate ${id}.exe` });
            if (p) await patch({ browser: { customPaths: { ...s.browser.customPaths, [id]: p } } }, 'Saved');
          },
        }, b ? 'Change…' : 'Locate…'),
      ),
    );
  }

  const editors = h('div', { class: 'card list' });
  for (const id of ['vscode', 'cursor'] as const) {
    const e = S.editors.find((x) => x.id === id);
    editors.append(
      h(
        'div',
        { class: 'item' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'name' }, id === 'vscode' ? 'VS Code' : 'Cursor'), h('div', { class: 'sub' }, e ? e.path : 'Not found')),
        h('button', {
          class: 'btn',
          onclick: async () => {
            const p = await api.pickExecutable({ title: id === 'vscode' ? 'Locate Code.exe' : 'Locate Cursor.exe' });
            if (p) await patch({ editor: { customPaths: { ...s.editor.customPaths, [id]: p } } }, 'Saved');
          },
        }, e ? 'Change…' : 'Locate…'),
      ),
    );
  }

  const appName = h('input', { type: 'text', placeholder: 'Name, e.g. Spotify', 'aria-label': 'Application name' });
  const apps = h('div', { class: 'card list' });
  if (!s.apps.length) apps.append(h('div', { class: 'item' }, h('span', { class: 'hint' }, 'No extra apps yet. Browsers and editors above are already available.')));
  s.apps.forEach((a, i) =>
    apps.append(
      h(
        'div',
        { class: 'item' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'name' }, a.name), h('div', { class: 'sub' }, a.path ?? `Store app: ${a.aumid}`)),
        h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!confirm(`Remove ${a.name} from approved apps? Commands that open it will stop working.`)) return;
            await patch({ apps: s.apps.filter((_, j) => j !== i) }, 'Removed');
          },
        }, 'Remove'),
      ),
    ),
  );

  return h(
    'div',
    { class: 'page' },
    warningsBlock(),
    h('h1', {}, 'Browser & apps'),
    h('p', { class: 'lede' }, 'ROG only launches executables you approve here. It never installs or downloads software.'),
    h(
      'div',
      { class: 'card' },
      row('Preferred browser', 'Used by “open …” and search commands.', select(s.browser.preferred, browserOpts, (v) => void patch({ browser: { preferred: v } }, 'Saved'), 'Preferred browser')),
      row('Preferred editor', 'Used to open projects.', select(s.editor.preferred, [['vscode', 'VS Code'], ['cursor', 'Cursor'], ['explorer', 'File Explorer']], (v) => void patch({ editor: { preferred: v } }, 'Saved'), 'Preferred editor')),
      row('Detection', 'Re-scan install locations and the registry.', h('button', { class: 'btn', onclick: async () => (await api.redetect(), toast('Re-scanned')) }, 'Re-scan')),
    ),
    h('h2', {}, 'Browsers'),
    detected,
    h('h2', {}, 'Editors'),
    editors,
    h('h2', {}, 'Approved applications'),
    apps,
    h(
      'div',
      { class: 'card', style: 'padding:12px 16px;margin-top:10px' },
      h(
        'div',
        { class: 'actions' },
        appName,
        h('button', {
          class: 'btn',
          onclick: async () => {
            const p = await api.pickExecutable({ title: 'Choose an application to approve' });
            if (!p) return;
            const name = appName.value.trim() || p.split('\\').pop()!.replace(/\.exe$/i, '');
            await patch({ apps: [...s.apps, { id: uniqueId(name, s.apps.map((a) => a.id)), name, path: p, args: [], aliases: [] }] }, `${name} approved`);
          },
        }, 'Choose .exe and approve…'),
      ),
      h('div', { class: 'hint', style: 'margin-top:6px' }, 'The name is what you say: “ROG, open Spotify”.'),
    ),
  );
}

// -------------------------------------------------------- projects & sites

function pageProjects(): HTMLElement {
  const s = S.settings;
  const projName = h('input', { type: 'text', placeholder: 'Name, e.g. Rocket.Chat', 'aria-label': 'Project name' });
  const projects = h('div', { class: 'card list' });
  if (!s.projects.length) projects.append(h('div', { class: 'item' }, h('span', { class: 'hint' }, 'No projects yet. Add one, then say “ROG, open my <name> project”.')));
  s.projects.forEach((p, i) =>
    projects.append(
      h(
        'div',
        { class: 'item' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'name' }, p.name), h('div', { class: 'sub' }, p.path)),
        h(
          'div',
          { class: 'actions' },
          textInput(
            p.aliases.join(', '),
            (v) => {
              const next = [...s.projects];
              next[i] = { ...p, aliases: v.split(',').map((x) => x.trim()).filter((x) => x.length >= 2) };
              void patch({ projects: next }, 'Aliases saved');
            },
            { label: `Other names for ${p.name}`, placeholder: 'other names, comma separated', width: '200px' },
          ),
          h('button', {
            class: 'btn danger',
            onclick: async () => {
              if (!confirm(`Remove the project “${p.name}”? The folder itself is not touched.`)) return;
              await patch({ projects: s.projects.filter((_, j) => j !== i) }, 'Removed');
            },
          }, 'Remove'),
        ),
      ),
    ),
  );

  const sites = h('div', { class: 'card list' });
  s.sites.forEach((site, i) =>
    sites.append(
      h(
        'div',
        { class: 'item' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'name' }, site.name), h('div', { class: 'sub' }, site.url)),
        h('button', { class: 'btn danger', onclick: () => void patch({ sites: s.sites.filter((_, j) => j !== i) }, 'Removed') }, 'Remove'),
      ),
    ),
  );
  const siteName = h('input', { type: 'text', placeholder: 'Codeforces', 'aria-label': 'Site name' });
  const siteUrl = h('input', { type: 'url', placeholder: 'https://codeforces.com/', 'aria-label': 'Site URL', style: 'flex:1' });

  return h(
    'div',
    { class: 'page' },
    warningsBlock(),
    h('h1', {}, 'Projects & sites'),
    h('p', { class: 'lede' }, 'Names here become things you can say: “open my Rocket.Chat project”, “open Codeforces”.'),
    h('h2', {}, 'Projects'),
    projects,
    h(
      'div',
      { class: 'card', style: 'padding:12px 16px;margin-top:10px' },
      h(
        'div',
        { class: 'actions' },
        projName,
        h('button', {
          class: 'btn',
          onclick: async () => {
            const path = await api.pickFolder();
            if (!path) return;
            const name = projName.value.trim() || (path.split('\\').pop() ?? 'project');
            await patch({ projects: [...s.projects, { id: uniqueId(name, s.projects.map((p) => p.id)), name, path, aliases: [] }] }, `${name} added`);
          },
        }, 'Choose folder and add…'),
      ),
    ),
    h('h2', {}, 'Websites'),
    sites,
    h(
      'div',
      { class: 'card', style: 'padding:12px 16px;margin-top:10px' },
      h(
        'div',
        { class: 'actions' },
        siteName,
        siteUrl,
        h('button', {
          class: 'btn',
          onclick: async () => {
            const name = siteName.value.trim();
            const url = siteUrl.value.trim();
            if (!name || !url) return toast('Enter a name and a URL', 'error');
            await patch({ sites: [...s.sites, { id: uniqueId(name, s.sites.map((x) => x.id)), name, url, aliases: [] }] }, `${name} added`);
          },
        }, 'Add site'),
      ),
    ),
  );
}

// ---------------------------------------------------------------- leetcode

const BROWSERS: Array<[string, string]> = [['preferred', 'Preferred browser'], ['brave', 'Brave'], ['chrome', 'Chrome'], ['edge', 'Edge'], ['firefox', 'Firefox'], ['system', 'Windows default']];

function pageLeetcode(): HTMLElement {
  const l = S.settings.leetcode;
  const projectOpts: Array<[string, string]> = [['', 'None'], ...S.settings.projects.map((p): [string, string] => [p.id, p.name])];
  const cmd = S.commands.find((c) => c.id === 'leetcode-mode');
  return h(
    'div',
    { class: 'page' },
    warningsBlock(),
    h('h1', {}, 'LeetCode mode'),
    h('p', { class: 'lede' }, 'Say “ROG, start LeetCode mode”. ROG opens LeetCode and YouTube Music in your browser. Playback may still need a click — browsers block autoplay.'),
    h(
      'div',
      { class: 'card' },
      row('LeetCode browser', null, select(l.browser, BROWSERS, (v) => void patch({ leetcode: { browser: v } }), 'LeetCode browser')),
      row('Music browser', 'YouTube Music can open in a different browser.', select(l.musicBrowser, BROWSERS, (v) => void patch({ leetcode: { musicBrowser: v } }), 'Music browser')),
      row('Open as', null, select(l.openMode, [['tabs', 'Tabs in the current window'], ['new-window', 'Tabs in a new window'], ['separate-windows', 'Separate windows']], (v) => void patch({ leetcode: { openMode: v } }), 'Open as')),
      row('LeetCode URL', null, textInput(l.leetcodeUrl, (v) => void patch({ leetcode: { leetcodeUrl: v } }, 'Saved'), { label: 'LeetCode URL', type: 'url', width: '300px' })),
      row('YouTube Music URL', null, textInput(l.musicUrl, (v) => void patch({ leetcode: { musicUrl: v } }, 'Saved'), { label: 'YouTube Music URL', type: 'url', width: '300px' })),
      row('Coding playlist (optional)', 'Paste a playlist link to open it instead of the home page.', textInput(l.playlistUrl, (v) => void patch({ leetcode: { playlistUrl: v } }, 'Saved'), { label: 'Playlist URL', type: 'url', width: '300px', placeholder: 'https://music.youtube.com/playlist?list=…' })),
      row('Also open a project', 'Opens it in your preferred editor.', h('div', { class: 'actions' }, toggle(l.openEditor, (v) => void patch({ leetcode: { openEditor: v } }), 'Open a project'), select(l.editorProjectId, projectOpts, (v) => void patch({ leetcode: { editorProjectId: v } }), 'Project'))),
      row('Spoken response', null, textInput(l.response, (v) => void patch({ leetcode: { response: v } }, 'Saved'), { label: 'Spoken response', width: '300px' })),
    ),
    h('div', { class: 'actions', style: 'margin-top:14px' }, cmd ? h('button', { class: 'btn primary', onclick: () => void test(cmd) }, 'Run LeetCode mode now') : null, cmd ? h('button', { class: 'btn', onclick: () => (go('commands'), edit(structuredClone(cmd))) }, 'Edit trigger phrases') : null),
  );
}

// ---------------------------------------------------------------------- ai

function pageAi(): HTMLElement {
  const l = S.settings.llm;
  const key = h('input', { type: 'password', placeholder: S.secretSource === 'none' ? 'Paste an API key' : '••••••••  (saved)', 'aria-label': 'API key', style: 'width:260px' });
  return h(
    'div',
    { class: 'page' },
    warningsBlock(),
    h('h1', {}, 'AI interpretation'),
    h('p', { class: 'lede' }, 'Optional. Only requests the local rules don’t understand are sent — as text, never audio. The AI returns a plan of catalog actions, which ROG validates and asks you to confirm.'),
    h(
      'div',
      { class: 'card' },
      row('Enable', null, toggle(l.enabled, (v) => void patch({ llm: { enabled: v } }), 'Enable AI interpretation')),
      row('Provider', null, select(l.provider, [['anthropic', 'Anthropic (Claude)'], ['openai-compatible', 'OpenAI-compatible / local (e.g. Ollama)']], (v) => void patch({ llm: { provider: v } }), 'Provider')),
      row('Model', l.provider === 'anthropic' ? 'Default: claude-opus-5-5. Any Claude model id works.' : 'e.g. llama3.1 for Ollama', textInput(l.model, (v) => void patch({ llm: { model: v } }, 'Saved'), { label: 'Model', width: '220px' })),
      l.provider === 'openai-compatible' ? row('Base URL', null, textInput(l.baseUrl, (v) => void patch({ llm: { baseUrl: v } }, 'Saved'), { label: 'Base URL', width: '260px', placeholder: 'http://localhost:11434/v1' })) : null,
      row('Confirm AI plans', 'Recommended. ROG asks before running anything the AI proposed.', toggle(l.confirmPlans, (v) => void patch({ llm: { confirmPlans: v } }), 'Confirm AI plans')),
      row(
        'API key',
        S.secretSource === 'env' ? 'Using an environment variable (ROG_LLM_API_KEY or ANTHROPIC_API_KEY).' : 'Stored encrypted with Windows DPAPI. Never shown again.',
        h(
          'div',
          { class: 'actions' },
          key,
          h('button', {
            class: 'btn',
            onclick: async () => {
              const r = await api.setApiKey(key.value);
              key.value = '';
              r.ok ? toast('Key saved') : toast(r.error, 'error');
            },
          }, 'Save'),
          S.secretSource === 'stored' ? h('button', { class: 'btn danger', onclick: async () => (await api.clearApiKey(), toast('Key removed')) }, 'Remove') : null,
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------- diagnostics

function pageDiagnostics(): HTMLElement {
  const table = h('table', { class: 'metrics' });
  const total = h('div', { class: 'hint', style: 'padding:10px 16px' });
  const refresh = async () => {
    const m = await api.metrics();
    table.replaceChildren(
      h('tr', {}, h('th', {}, 'Process'), h('th', {}, 'PID'), h('th', {}, 'CPU %'), h('th', {}, 'Memory')),
      ...m.processes.map((p) => h('tr', {}, h('td', {}, p.type), h('td', {}, String(p.pid)), h('td', {}, p.cpu.toFixed(1)), h('td', {}, `${p.memoryMB} MB`))),
    );
    total.textContent = `Electron total: ${m.totalCpu.toFixed(1)}% CPU, ${m.totalMemoryMB} MB. The speech engine runs as a separate powershell.exe process.`;
  };
  void refresh();
  return h(
    'div',
    { class: 'page' },
    warningsBlock(),
    h('h1', {}, 'Diagnostics'),
    h('p', { class: 'lede' }, `ROG ${S.version}. Speech engine: ${S.speechReady ? 'ready' : S.speechError ? 'failed' : 'starting…'}.`),
    h('div', { class: 'card' }, table, total),
    h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: () => void refresh() }, 'Refresh')),
    h('h2', {}, 'Data'),
    h('div', { class: 'card', style: 'padding:12px 16px' }, h('div', {}, 'Settings and commands are stored in ', h('code', {}, S.dataDir)), h('div', { class: 'hint' }, 'settings.json, commands.json, and llm-key.bin (encrypted, only if you saved a key).')),
  );
}

// -------------------------------------------------------------------- boot

api.onState((state) => {
  S = state;
  // Re-render, but don't wipe a command that's being edited.
  if (!editing || page !== 'commands') render();
  else {
    pill.textContent = stateLabel();
    pill.dataset.state = S.snapshot.state;
  }
});
api.onHeard((e) => {
  heard.push(e);
  if (heard.length > 100) heard.shift();
  const log = document.getElementById('heard-log');
  if (log) drawHeard(log);
});

void api.getState().then((state) => {
  S = state;
  renderNav();
  render();
});
