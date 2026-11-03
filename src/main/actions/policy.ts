// Permission and confirmation policy for a whole plan.
//
//   deny    - at least one action is not allowed at all; nothing runs
//   confirm - the user must say "yes" (or click) before anything runs
//   allow   - ordinary, approved actions; run immediately
import { actionListSchema, formatZodError, type Action } from '../../shared/schemas';
import { assessAction } from './registry';
import type { PolicyContext } from './types';

export type Decision =
  | { decision: 'allow'; actions: Action[] }
  | { decision: 'confirm'; actions: Action[]; reasons: string[] }
  | { decision: 'deny'; reasons: string[] };

/** Plans longer than this always ask first, whatever their source. */
export const CONFIRM_ABOVE_ACTIONS = 6;

export function assessPlan(rawActions: unknown, ctx: PolicyContext): Decision {
  // Re-validate even "trusted" plans: commands on disk can be edited by hand.
  const parsed = actionListSchema.safeParse(rawActions);
  if (!parsed.success) return { decision: 'deny', reasons: [`invalid plan: ${formatZodError(parsed.error)}`] };
  const actions = parsed.data;

  if (actions.some((a) => a.type === 'workflow')) {
    return { decision: 'deny', reasons: ['workflows must be expanded before assessment'] };
  }

  const denied: string[] = [];
  const confirm: string[] = [];
  for (const action of actions) {
    const risk = assessAction(action, ctx);
    if (risk.level === 'deny') denied.push(risk.reason);
    else if (risk.level === 'confirm') confirm.push(risk.reason);
  }
  if (denied.length) return { decision: 'deny', reasons: denied };

  if (ctx.source === 'llm' && ctx.settings.llm.confirmPlans) confirm.unshift('this plan came from the AI interpreter');
  if (actions.length > CONFIRM_ABOVE_ACTIONS) confirm.push(`it has ${actions.length} steps`);

  return confirm.length ? { decision: 'confirm', actions, reasons: confirm } : { decision: 'allow', actions };
}
