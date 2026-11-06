import { RunFinishedOutcomeSchema } from '@ag-ui/core/schemas';

/** AG-UI defines a missing outcome as success for producers predating outcomes. */
export function runFinishedOutcome(event: Record<string, unknown>): 'success' | 'interrupt' | 'cancelled' {
  return RunFinishedOutcomeSchema.nullish().parse(event.outcome)?.type ?? 'success';
}

export function runCompletionError(event: Record<string, unknown>, label: string): string | null {
  const outcome = runFinishedOutcome(event);
  return outcome === 'success' ? null : `${label} run ended with ${outcome} outcome`;
}
