// The assistant's explicit state machine. The main process owns the single
// authoritative instance; renderers only receive snapshots and animate them.

export const STATES = [
  'IDLE',
  'WAKE_DETECTED',
  'LISTENING',
  'PROCESSING',
  'CONFIRMING',
  'EXECUTING',
  'SUCCESS',
  'ERROR',
  'MUTED',
] as const;
export type AssistantState = (typeof STATES)[number];

/**
 * Allowed transitions. MUTED is reachable from everywhere (the user can always
 * turn the microphone off). EXECUTING is reachable from MUTED so tray / settings
 * "test" actions work while the microphone is off.
 */
const TRANSITIONS: Record<AssistantState, readonly AssistantState[]> = {
  IDLE: ['WAKE_DETECTED', 'LISTENING', 'PROCESSING', 'EXECUTING', 'MUTED'],
  WAKE_DETECTED: ['LISTENING', 'PROCESSING', 'IDLE', 'MUTED'],
  LISTENING: ['PROCESSING', 'IDLE', 'ERROR', 'MUTED'],
  PROCESSING: ['EXECUTING', 'CONFIRMING', 'SUCCESS', 'ERROR', 'IDLE', 'MUTED'],
  CONFIRMING: ['EXECUTING', 'PROCESSING', 'IDLE', 'ERROR', 'MUTED'],
  EXECUTING: ['SUCCESS', 'ERROR', 'MUTED'],
  SUCCESS: ['IDLE', 'MUTED', 'WAKE_DETECTED', 'LISTENING', 'PROCESSING', 'EXECUTING'],
  ERROR: ['IDLE', 'MUTED', 'WAKE_DETECTED', 'LISTENING', 'PROCESSING', 'EXECUTING'],
  MUTED: ['IDLE', 'EXECUTING', 'PROCESSING', 'LISTENING'],
};

export function canTransition(from: AssistantState, to: AssistantState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export interface StateSnapshot {
  state: AssistantState;
  /** Short status text for the bubble, e.g. "Opening LeetCode…". */
  label?: string;
  /** What ROG heard, shown briefly while processing. */
  transcript?: string;
  /** Present while CONFIRMING. */
  confirm?: { prompt: string };
  /** True while the microphone stream is open. */
  micActive: boolean;
  /** True while ROG is speaking. */
  speaking: boolean;
  /** Monotonic counter, lets renderers detect re-entry into the same state. */
  seq: number;
}

type Listener = (snap: StateSnapshot, prev: AssistantState) => void;

export class StateMachine {
  private snap: StateSnapshot = { state: 'IDLE', micActive: false, speaking: false, seq: 0 };
  private listeners = new Set<Listener>();

  get state(): AssistantState {
    return this.snap.state;
  }

  get snapshot(): StateSnapshot {
    return { ...this.snap };
  }

  /** Moves to `to`. Returns false (and changes nothing) if the transition is not allowed. */
  transition(to: AssistantState, extra: Partial<Omit<StateSnapshot, 'state' | 'seq'>> = {}): boolean {
    const prev = this.snap.state;
    if (!canTransition(prev, to)) return false;
    this.snap = {
      micActive: this.snap.micActive,
      speaking: this.snap.speaking,
      ...extra,
      state: to,
      seq: this.snap.seq + 1,
    };
    for (const l of this.listeners) l(this.snapshot, prev);
    return true;
  }

  /** Updates flags (mic/speaking) without changing state. */
  patch(extra: Partial<Pick<StateSnapshot, 'micActive' | 'speaking' | 'label' | 'transcript'>>): void {
    this.snap = { ...this.snap, ...extra, seq: this.snap.seq + 1 };
    for (const l of this.listeners) l(this.snapshot, this.snap.state);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
