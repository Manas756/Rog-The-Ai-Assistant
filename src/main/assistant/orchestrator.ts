// The assistant pipeline:
//
//   mic frames ─► VAD ─► utterance ─► speech host (wake | command | confirm grammar)
//        ─► interpretation (local rules ─► optional LLM) ─► workflow expansion
//        ─► permission policy ─► (confirmation) ─► executor ─► result ─► TTS + state
//
// Every visual state the orb shows is a transition of the StateMachine owned
// here. The orchestrator has no Electron imports; all side effects arrive
// through `AssistantDeps`, which keeps the whole flow unit-testable.
import { EventEmitter } from 'node:events';
import type { BrowserId, Command, Settings } from '../../shared/schemas';
import { StateMachine, type AssistantState } from '../../shared/stateMachine';
import { canonical, stripWakeWord } from '../../shared/text';
import { executePlan } from '../actions/executor';
import { assessPlan } from '../actions/policy';
import type { ActionContext, Launcher, StepResult } from '../actions/types';
import { interpretLocally } from '../intent/localInterpreter';
import type { Interpretation, InterpreterContext, Plan } from '../intent/types';
import type { EditorId } from '../platform/detect';
import { expandWorkflows, workflowResponse } from '../workflows/leetcodeMode';
import type { GrammarSpec, RecognitionResult, RecognizeMode } from './speechHost';
import { Vad } from './vad';

export interface SpeechPort {
  readonly ready: boolean;
  recognize(pcm: Int16Array, mode: RecognizeMode): Promise<RecognitionResult>;
  speak(text: string, opts: { voice?: string; rate?: number; volume?: number }): void;
  stopSpeaking(): void;
  setGrammar(spec: GrammarSpec): void;
}

export interface AssistantDeps {
  settings(): Settings;
  commands(): Command[];
  installedBrowsers(): BrowserId[];
  installedEditors(): EditorId[];
  speech: SpeechPort;
  launcher: Launcher;
  llm(text: string, ctx: InterpreterContext): Promise<Interpretation>;
  /** Ask the renderer to open (true) or close (false) the microphone. */
  setMicOpen(open: boolean): void;
  updateSettings(patch: unknown): void;
  hideOrb(): void;
  grammar(): GrammarSpec;
}

export interface HeardEvent {
  mode: RecognizeMode;
  text: string | null;
  confidence: number;
  grammar: string;
  accepted: boolean;
  ms: number;
  at: number;
}

const TIMING = {
  wakeToListenMs: 250,
  minProcessingMs: 120,
  successHoldMs: 1700,
  errorHoldMs: 2600,
  confirmTimeoutMs: 8000,
  echoGuardMs: 450,
};

const YES = new Set(['yes', 'yeah', 'yep', 'sure', 'do it', 'go ahead', 'confirm', 'okay']);

interface Task {
  label: string;
  startedAt: number;
  ok?: boolean;
}

export class Assistant extends EventEmitter<{ heard: [HeardEvent]; log: [string]; utterance: [Int16Array, RecognizeMode] }> {
  readonly machine = new StateMachine();
  private readonly vad: Vad;
  private micOpen = false;
  private micError: string | null = null;
  /** Mic opened on demand by push-to-talk while monitoring is off. */
  private tempMic = false;
  private speaking = false;
  private ignoreAudioUntil = 0;
  private epoch = 0; // bumps on every interaction; stale async results are dropped
  private timers = new Set<NodeJS.Timeout>();
  private listenTimer: NodeJS.Timeout | null = null;
  /** Waiting for yes/no. "clarify" = did-you-mean (policy still to run); "policy" = already assessed. */
  private pending: { kind: 'clarify' | 'policy'; plan: Plan; actions: Plan['actions']; response?: string; reprompted: boolean } | null = null;
  private retryLeft = 1;
  private current: Task | null = null;
  private last: Task | null = null;
  private abort: AbortController | null = null;

  constructor(private readonly deps: AssistantDeps) {
    super();
    this.vad = new Vad({ sensitivity: deps.settings().voice.vadSensitivity, endSilenceMs: 450 });
    this.machine.onChange((snap, prev) => {
      if (snap.state !== prev) this.onStateEntered(snap.state);
    });
  }

  // ----------------------------------------------------------- lifecycle

  start(): void {
    this.refreshGrammar();
    const monitoring = this.deps.settings().voice.monitoring;
    this.deps.setMicOpen(monitoring);
    if (!monitoring) this.machine.transition('MUTED', { label: undefined });
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.clearListenTimer();
    this.abort?.abort();
    this.deps.setMicOpen(false);
  }

  refreshGrammar(): void {
    this.deps.speech.setGrammar(this.deps.grammar());
    this.vad.configure({ sensitivity: this.deps.settings().voice.vadSensitivity });
  }

  get state(): AssistantState {
    return this.machine.state;
  }

  /** Where ROG rests between interactions. */
  private baseline(): AssistantState {
    return this.deps.settings().voice.monitoring && !this.micError ? 'IDLE' : 'MUTED';
  }

  private returnToBaseline(): void {
    this.clearListenTimer();
    this.pending = null;
    this.vad.reset();
    if (this.tempMic) {
      this.tempMic = false;
      if (!this.deps.settings().voice.monitoring) this.deps.setMicOpen(false);
    }
    const target = this.baseline();
    this.machine.transition(target, { label: target === 'MUTED' && this.micError ? this.micError : undefined });
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** Runs `fn` after `ms` only if nothing else happened in between. */
  private laterIfUnchanged(ms: number, fn: () => void): void {
    const epoch = this.epoch;
    this.later(ms, () => {
      if (epoch === this.epoch) fn();
    });
  }

  private onStateEntered(state: AssistantState): void {
    // Wake utterances are short ("rog", "rog open github"); a short cap keeps room
    // noise from building long garbage segments. Commands may be longer.
    const endSilence: Record<string, number> = { LISTENING: 600, CONFIRMING: 450 };
    const maxLength: Record<string, number> = { LISTENING: 10_000, CONFIRMING: 4000 };
    this.vad.configure({ endSilenceMs: endSilence[state] ?? 380, maxUtteranceMs: maxLength[state] ?? 4000 });
    // Keep collecting across "rog" -> WAKE_DETECTED -> LISTENING: people start the
    // command right after the wake word, and that audio must not be thrown away.
    if (state !== 'WAKE_DETECTED' && state !== 'LISTENING') this.vad.reset();
  }

  // ---------------------------------------------------------- microphone

  onMicStatus(status: { open: boolean; error?: string }): void {
    this.micOpen = status.open;
    this.micError = status.error ?? null;
    this.machine.patch({ micActive: status.open });
    if (status.error) {
      this.emit('log', `microphone: ${status.error}`);
      if (this.state === 'IDLE' || this.state === 'LISTENING' || this.state === 'WAKE_DETECTED') {
        this.epoch++;
        this.machine.transition('MUTED', { label: status.error });
      }
    } else if (status.open && this.state === 'MUTED' && this.deps.settings().voice.monitoring) {
      this.machine.transition('IDLE', { label: undefined });
    }
  }

  onTts(speaking: boolean): void {
    this.speaking = speaking;
    if (!speaking) this.ignoreAudioUntil = Date.now() + TIMING.echoGuardMs;
    this.vad.reset();
    this.machine.patch({ speaking });
  }

  onAudioFrame(frame: Int16Array): void {
    // Frames keep flowing into the VAD while a previous utterance is being recognized.
    if (!this.micOpen || this.speaking || Date.now() < this.ignoreAudioUntil) return;
    const mode = this.recognizeModeFor(this.state);
    if (!mode) return;
    for (const ev of this.vad.push(frame)) {
      if (ev.type === 'speech_start' && (this.state === 'LISTENING' || this.state === 'WAKE_DETECTED')) {
        this.clearListenTimer();
        this.machine.patch({ label: undefined });
      } else if (ev.type === 'speech_end') {
        let peak = 0;
        for (let i = 0; i < ev.pcm.length; i++) peak = Math.max(peak, Math.abs(ev.pcm[i]!));
        this.emit('log', `utterance (${mode}) ${Math.round(ev.durationMs)} ms, peak ${peak}`);
        this.emit('utterance', ev.pcm, mode);
        void this.handleUtterance(ev.pcm, mode);
      }
    }
  }

  private recognizeModeFor(state: AssistantState): RecognizeMode | null {
    switch (state) {
      case 'WAKE_DETECTED':
      case 'LISTENING':
        return 'command';
      case 'CONFIRMING':
        return 'confirm';
      case 'IDLE':
      case 'SUCCESS':
      case 'ERROR':
        return this.deps.settings().voice.wakeWordEnabled && this.deps.settings().voice.monitoring ? 'wake' : null;
      default:
        return null;
    }
  }

  // --------------------------------------------------------- recognition

  /** Confidence needed to accept the wake word, from the sensitivity slider. */
  wakeThreshold(): number {
    return 0.85 - 0.4 * this.deps.settings().voice.wakeSensitivity;
  }

  private async handleUtterance(pcm: Int16Array, mode: RecognizeMode): Promise<void> {
    if (!this.deps.speech.ready) {
      if (mode !== 'wake') this.fail("The speech engine isn't ready yet.");
      return;
    }
    const epoch = this.epoch;
    let result: RecognitionResult;
    try {
      result = await this.deps.speech.recognize(pcm, mode);
      if (mode === 'command' && !this.commandAccepted(result) && epoch === this.epoch) {
        // The strict grammars rejected it. Re-hear the same audio as free dictation
        // and let the fuzzy matcher guess, instead of giving up.
        const guess = await this.deps.speech.recognize(pcm, 'guess');
        if (guess.text) {
          this.emit('log', `guess pass: "${guess.text}" (${guess.confidence})`);
          result = { ...guess, grammar: 'guess' };
        }
      }
    } catch (err) {
      if (mode !== 'wake' && epoch === this.epoch) this.fail('Speech recognition failed.');
      this.emit('log', `recognize: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (epoch !== this.epoch) return; // the user moved on (cancel, mute, PTT)
    this.onRecognition(result, mode);
  }

  private commandAccepted(r: RecognitionResult): boolean {
    if (!r.text) return false;
    const min = r.grammar === 'command' || r.grammar === 'template' ? 0.25 : 0.1;
    return r.confidence >= min;
  }

  /** Public for tests: feeds a recognition result as if the speech host produced it. */
  onRecognition(r: RecognitionResult, mode: RecognizeMode): void {
    const heard = (accepted: boolean) =>
      this.emit('heard', { mode, text: r.text, confidence: r.confidence, grammar: r.grammar, accepted, ms: r.ms, at: Date.now() });

    if (mode === 'wake') {
      const isWake = r.grammar.startsWith('wake');
      // "rog <free speech>" is a guess, so it must be at least as confident as a plain wake.
      const accepted = isWake && !!r.text && r.confidence >= this.wakeThreshold();
      heard(accepted);
      if (!accepted) return;
      const rest = stripWakeWord(r.text!, this.deps.settings().voice.wakeWords);
      const alternates = r.alternates.map((a) => stripWakeWord(a.text, this.deps.settings().voice.wakeWords)).filter(Boolean);
      if (r.grammar === 'wake' || !rest) this.onWake(null);
      // A free-speech one-shot that turns out to mean nothing is ignored silently:
      // it was probably someone saying "rogue…" in conversation.
      else this.onWake([rest, ...alternates], r.grammar === 'wake_dictation');
      return;
    }

    if (mode === 'command' || mode === 'guess') {
      const accepted = this.commandAccepted(r);
      heard(accepted);
      if (!accepted) {
        if (this.retryLeft-- > 0) {
          this.machine.patch({ label: 'Say that again?' });
          this.startListenTimer();
        } else {
          this.fail("Sorry, I didn't catch that.");
        }
        return;
      }
      const texts = [r.text!, ...r.alternates.map((a) => a.text)];
      void this.process(texts);
      return;
    }

    // confirm
    const word = r.text ? canonical(r.text) : '';
    const accepted = r.grammar === 'confirm' && !!word;
    heard(accepted);
    if (!accepted) {
      if (this.pending && !this.pending.reprompted) {
        this.pending.reprompted = true;
        this.say('Please say yes or no.');
        return;
      }
      this.cancel('Okay, cancelled.');
      return;
    }
    this.confirm(YES.has(word));
  }

  // ------------------------------------------------------------- entries

  private onWake(oneShot: string[] | null, quietIfUnknown = false): void {
    this.epoch++;
    this.retryLeft = 1;
    this.deps.speech.stopSpeaking();
    this.machine.transition('WAKE_DETECTED', { label: undefined, transcript: undefined });
    if (oneShot) {
      this.laterIfUnchanged(TIMING.wakeToListenMs / 2, () => void this.process(oneShot, quietIfUnknown));
    } else {
      this.laterIfUnchanged(TIMING.wakeToListenMs, () => this.listen());
    }
  }

  private listen(): void {
    if (this.machine.transition('LISTENING', { label: undefined, transcript: undefined })) this.startListenTimer();
  }

  private startListenTimer(): void {
    this.clearListenTimer();
    const epoch = this.epoch;
    this.listenTimer = setTimeout(() => {
      this.listenTimer = null;
      if (epoch === this.epoch && this.state === 'LISTENING' && !this.vad.isSpeaking) {
        this.epoch++;
        this.returnToBaseline();
      }
    }, this.deps.settings().voice.commandTimeoutMs);
  }

  private clearListenTimer(): void {
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.listenTimer = null;
  }

  /** Push-to-talk (global shortcut or orb click): skip the wake word. Pressing again cancels. */
  pushToTalk(): void {
    const s = this.state;
    if (s === 'LISTENING' || s === 'WAKE_DETECTED' || s === 'CONFIRMING') {
      this.cancel();
      return;
    }
    if (s === 'PROCESSING' || s === 'EXECUTING') return;
    if (!this.micOpen) {
      // Monitoring is off: open the mic for this one command only.
      this.tempMic = true;
      this.micError = null;
      this.deps.setMicOpen(true);
    }
    this.onWake(null);
  }

  /** Typed command (Settings "Try a command") - same pipeline minus speech. */
  async runText(text: string): Promise<void> {
    if (this.state === 'EXECUTING' || this.state === 'PROCESSING') return;
    this.epoch++;
    await this.process([text]);
  }

  /** Settings "Test" button: run a saved command directly. */
  async runCommand(id: string): Promise<{ ok: boolean; error?: string }> {
    const cmd = this.deps.commands().find((c) => c.id === id);
    if (!cmd) return { ok: false, error: 'Command not found' };
    if (this.state === 'EXECUTING' || this.state === 'PROCESSING') return { ok: false, error: 'ROG is busy' };
    this.epoch++;
    this.machine.transition('PROCESSING', { label: cmd.name, transcript: undefined });
    await this.preparePlan({ label: cmd.name, actions: cmd.actions, response: cmd.response, source: 'command', commandId: cmd.id, confidence: 1 });
    return { ok: true };
  }

  setMonitoring(enabled: boolean): void {
    this.deps.updateSettings({ voice: { monitoring: enabled } });
    this.epoch++;
    this.abort?.abort();
    this.pending = null;
    this.clearListenTimer();
    this.micError = null;
    this.tempMic = false;
    this.deps.setMicOpen(enabled);
    if (!enabled) this.machine.transition('MUTED', { label: undefined });
    else if (this.state === 'MUTED') this.machine.transition('IDLE', { label: undefined });
  }

  toggleMonitoring(): void {
    this.setMonitoring(!this.deps.settings().voice.monitoring);
  }

  /** UI click on the confirmation chips, or a spoken yes/no. */
  confirm(yes: boolean): void {
    if (this.state !== 'CONFIRMING' || !this.pending) return;
    const p = this.pending;
    this.pending = null;
    this.epoch++;
    if (!yes) {
      this.cancel('Okay, cancelled.');
      return;
    }
    if (p.kind === 'clarify') {
      // The user confirmed what they meant; the plan itself still needs policy review.
      this.machine.transition('PROCESSING', { label: p.plan.label, confirm: undefined });
      void this.preparePlan(p.plan);
      return;
    }
    void this.execute(p.plan, p.actions, p.response);
  }

  cancel(spoken?: string): void {
    this.epoch++;
    this.abort?.abort();
    this.pending = null;
    if (spoken) this.say(spoken);
    if (this.state !== 'EXECUTING') this.returnToBaseline();
  }

  // ---------------------------------------------------------- processing

  private interpreterContext(): InterpreterContext {
    return {
      settings: this.deps.settings(),
      commands: this.deps.commands(),
      installedBrowsers: this.deps.installedBrowsers(),
      installedEditors: this.deps.installedEditors().filter((e): e is 'vscode' | 'cursor' => e === 'vscode' || e === 'cursor'),
    };
  }

  private async process(texts: string[], quietIfUnknown = false): Promise<void> {
    const epoch = this.epoch;
    const started = Date.now();
    this.clearListenTimer();
    const shown = texts[0]!;
    if (!this.machine.transition('PROCESSING', { transcript: shown, label: undefined })) return;

    const ctx = this.interpreterContext();
    let interp: Interpretation = { kind: 'unknown', text: shown, reason: 'no matching command' };
    for (const t of texts) {
      const i = interpretLocally(t, ctx);
      if (i.kind === 'plan') {
        interp = i;
        break;
      }
      if (i.kind === 'clarify' && interp.kind === 'unknown') interp = i;
      else if (interp.kind === 'unknown' && i.kind === 'unknown' && t === shown) interp = i;
    }
    if (interp.kind === 'unknown' && ctx.settings.llm.enabled) {
      this.machine.patch({ label: 'Thinking…' });
      interp = await this.deps.llm(shown, ctx);
      if (epoch !== this.epoch) return;
    }

    const wait = TIMING.minProcessingMs - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (epoch !== this.epoch) return;

    switch (interp.kind) {
      case 'unknown': {
        if (quietIfUnknown) {
          this.returnToBaseline();
          return;
        }
        const reason = interp.reason === 'no matching command' ? `I don't know how to "${shown}" yet.` : capitalize(interp.reason) + '.';
        this.fail(reason, "I don't know how to do that yet.");
        return;
      }
      case 'clarify':
        this.askToConfirm('clarify', interp.plan, interp.plan.actions, interp.plan.response, interp.prompt);
        return;
      case 'plan':
        await this.preparePlan(interp.plan);
    }
  }

  private async preparePlan(plan: Plan): Promise<void> {
    const settings = this.deps.settings();
    const actions = expandWorkflows(plan.actions, settings);
    const response = plan.response ?? workflowResponse(plan.actions, settings);
    const decision = assessPlan(actions, { settings, source: plan.source, isKnownApp: (id) => this.deps.launcher.isKnownApp(id) });
    if (decision.decision === 'deny') {
      this.fail(`Can't run ${plan.label}: ${decision.reasons[0]}.`, "I can't do that.");
      return;
    }
    if (decision.decision === 'confirm') {
      this.askToConfirm('policy', plan, decision.actions, response, `${plan.label}? I need your OK because ${decision.reasons[0]}.`);
      return;
    }
    await this.execute(plan, decision.actions, response);
  }

  private askToConfirm(kind: 'clarify' | 'policy', plan: Plan, actions: Plan['actions'], response: string | undefined, prompt: string): void {
    this.pending = { kind, plan, actions, response, reprompted: false };
    this.machine.transition('CONFIRMING', { confirm: { prompt }, label: prompt });
    this.say(prompt);
    const epoch = this.epoch;
    this.later(TIMING.confirmTimeoutMs + (this.speaking ? 2000 : 0), () => {
      if (epoch === this.epoch && this.state === 'CONFIRMING') this.cancel();
    });
  }

  private async execute(plan: Plan, actions: Plan['actions'], response?: string): Promise<void> {
    this.epoch++;
    this.abort = new AbortController();
    // Meta-commands (status, mute, help) are not "the command ROG is running".
    const tracked = !actions.every((a) => a.type === 'assistant');
    if (tracked) this.current = { label: plan.label, startedAt: Date.now() };
    if (!this.machine.transition('EXECUTING', { label: `${plan.label}…`, transcript: undefined })) return;

    const ctx: ActionContext = {
      settings: this.deps.settings(),
      launcher: this.deps.launcher,
      assistant: {
        speak: (t) => this.say(t),
        setVoiceMuted: (muted) => this.deps.updateSettings({ speech: { enabled: !muted } }),
        stopListening: () => {
          // Applied when the plan finishes so the SUCCESS ring can play first.
          this.deps.updateSettings({ voice: { monitoring: false } });
        },
        hideOrb: () => this.deps.hideOrb(),
        cancel: () => undefined,
        statusText: () => this.statusText(),
        helpText: () =>
          'Try: open LeetCode, start LeetCode mode, search YouTube for graph algorithms, open GitHub, or stop listening.',
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };

    const result = await executePlan(
      actions,
      ctx,
      { onStep: (_i, _n, _a, description) => this.machine.patch({ label: `${description}…` }) },
      this.abort.signal,
    );
    this.abort = null;
    if (tracked && this.current) {
      this.last = { ...this.current, ok: result.ok };
      this.current = null;
    }

    if (!this.deps.settings().voice.monitoring) this.deps.setMicOpen(false);

    if (result.ok) {
      const internalOnly = actions.every((a) => a.type === 'assistant' || a.type === 'speak' || a.type === 'wait');
      // Assistant-only plans (status, help, mute) already spoke for themselves.
      const spoken = response ?? (internalOnly ? undefined : successText(result.results));
      this.machine.transition('SUCCESS', { label: spoken ?? successText(result.results) });
      if (spoken) this.say(spoken);
      this.laterIfUnchanged(TIMING.successHoldMs, () => {
        if (this.state === 'SUCCESS') this.returnToBaseline();
      });
    } else if (result.cancelled) {
      this.machine.transition('ERROR', { label: 'Cancelled' });
      this.laterIfUnchanged(1200, () => this.returnToBaseline());
    } else {
      const failed = result.results[result.failedAt ?? result.results.length - 1];
      this.machine.transition('ERROR', { label: failed?.message ?? 'Something went wrong' });
      this.say(shortSpoken(failed?.message));
      this.laterIfUnchanged(TIMING.errorHoldMs, () => this.returnToBaseline());
    }
  }

  private fail(label: string, spoken?: string): void {
    this.clearListenTimer();
    this.pending = null;
    if (!this.machine.transition('ERROR', { label })) return;
    this.say(spoken ?? label);
    this.laterIfUnchanged(TIMING.errorHoldMs, () => this.returnToBaseline());
  }

  private say(text: string): void {
    const s = this.deps.settings().speech;
    if (!s.enabled || !text) return;
    this.deps.speech.speak(text, { voice: s.voice || undefined, rate: s.rate, volume: s.volume });
  }

  statusText(): string {
    if (this.current) return `I'm running ${this.current.label}.`;
    if (this.last) return `The last command was ${this.last.label}. It ${this.last.ok ? 'finished' : 'failed'}.`;
    return "I'm not running anything right now.";
  }
}

function successText(results: StepResult[]): string {
  // Be honest about what is known: a started process is not a loaded page.
  if (results.some((r) => r.stage === 'started' || r.stage === 'requested')) return 'Done. Launch started.';
  return 'Done.';
}

function shortSpoken(message?: string): string {
  if (!message) return 'That failed.';
  return message.length > 120 ? 'That failed. Details are on screen.' : message;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
