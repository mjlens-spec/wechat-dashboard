// @ts-check

export const UPDATE_INTERVAL_MINUTES = 15;
export const UPDATE_INTERVAL_MS = UPDATE_INTERVAL_MINUTES * 60 * 1000;

/**
 * Semantic analysis starts only after a complete dual-platform sync cycle.
 * Partial or failed updates keep the previous encrypted analysis intact and
 * retry on the next 15-minute cycle.
 *
 * @param {unknown} status
 */
export function completedSyncAllowsSemanticAnalysis(status) {
  return status === 'ok';
}
