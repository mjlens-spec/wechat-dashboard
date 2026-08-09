// @ts-check

/**
 * @param {{
 *   now: number;
 *   intervalMs: number;
 *   lastSuccessAt: number | null;
 *   lastAttemptAt: number | null;
 * }} options
 */
export function automaticSyncTiming({
  now,
  intervalMs,
  lastSuccessAt,
  lastAttemptAt,
}) {
  const reference = Math.max(
    finiteTimestamp(lastSuccessAt),
    finiteTimestamp(lastAttemptAt),
  );
  const nextDueAt = reference > 0 ? reference + intervalMs : now;
  return { due: nextDueAt <= now, nextDueAt };
}

/** @param {number | null} value */
function finiteTimestamp(value) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}
