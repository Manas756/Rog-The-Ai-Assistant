// The workflow engine: runs validated, policy-approved actions in order and
// reports each step. It stops at the first failure so later steps never run on
// top of a half-finished setup.
import type { Action } from '../../shared/schemas';
import { describeAction, runAction } from './registry';
import type { ActionContext, StepResult } from './types';

export interface ExecutionHooks {
  onStep?(index: number, total: number, action: Action, description: string): void;
  onStepResult?(index: number, result: StepResult): void;
}

export interface ExecutionResult {
  ok: boolean;
  results: StepResult[];
  failedAt?: number;
  cancelled?: boolean;
}

const STEP_TIMEOUT_MS = 15_000;

export async function executePlan(
  actions: Action[],
  ctx: ActionContext,
  hooks: ExecutionHooks = {},
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  const results: StepResult[] = [];
  for (let i = 0; i < actions.length; i++) {
    if (signal?.aborted) {
      return { ok: false, results, cancelled: true, failedAt: i };
    }
    const action = actions[i]!;
    hooks.onStep?.(i, actions.length, action, describeAction(action, ctx));
    let result: StepResult;
    try {
      result = await withTimeout(runAction(action, ctx), STEP_TIMEOUT_MS);
    } catch (err) {
      result = { ok: false, stage: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
    results.push(result);
    hooks.onStepResult?.(i, result);
    if (!result.ok) return { ok: false, results, failedAt: i };
  }
  return { ok: true, results };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`step timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
