/** Inputs supplied once when expanding a workflow module into its durable plan. */
import type { WorkflowDef } from './workflow.ts';
import { validateWorkflowDef } from './workflow.ts';

export interface WorkflowContext {
  prompt?: string;
}

export type WorkflowFactory = (context: WorkflowContext) => WorkflowDef | Promise<WorkflowDef>;

/** Keep plain object modules compatible; factories receive invocation-local input. */
export async function evaluateWorkflowModule(
  value: unknown,
  context: WorkflowContext = {},
): Promise<WorkflowDef> {
  if (value === undefined) throw new Error('workflow file has no default export');
  const def = typeof value === 'function' ? await (value as WorkflowFactory)({ ...context }) : value;
  validateWorkflowDef(def as WorkflowDef);
  return def as WorkflowDef;
}
