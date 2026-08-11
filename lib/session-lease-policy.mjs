// @ts-check

/**
 * @typedef {{
 *   version: number;
 *   session_id: string;
 *   project_root: string;
 *   skill_expires_at: number;
 *   expires_at: number;
 * }} LeaseShape
 */

/**
 * @typedef {{
 *   version: number;
 *   session_id: string;
 *   project_root: string;
 * }} StateShape
 */

/**
 * @param {LeaseShape} lease
 * @param {StateShape} state
 * @param {string} projectRoot
 * @param {number} now
 */
export function isActiveManagedLease(lease, state, projectRoot, now) {
  return Boolean(
    isMatchingManagedSession(lease, state, projectRoot) &&
      Number.isFinite(lease.expires_at) &&
      lease.expires_at > now &&
      Number.isFinite(lease.skill_expires_at) &&
      lease.skill_expires_at > now,
  );
}

/**
 * Renew an already-open viewer independently from the initial Skill grace window.
 * An expired viewer lease is never revived, and the first viewer heartbeat still
 * has to arrive before the Skill grace window closes.
 *
 * @param {LeaseShape & { last_viewer_heartbeat_at?: number | null }} lease
 * @param {StateShape} state
 * @param {string} projectRoot
 * @param {number} now
 * @param {number} viewerLeaseMs
 */
export function heartbeatManagedLease(
  lease,
  state,
  projectRoot,
  now,
  viewerLeaseMs,
) {
  if (!isMatchingManagedSession(lease, state, projectRoot)) return null;
  if (!Number.isFinite(lease.expires_at) || lease.expires_at <= now) return null;

  const hasActiveViewer = Number.isFinite(lease.last_viewer_heartbeat_at);
  const initialGraceActive =
    Number.isFinite(lease.skill_expires_at) && lease.skill_expires_at > now;
  if (!hasActiveViewer && !initialGraceActive) return null;
  if (!Number.isFinite(viewerLeaseMs) || viewerLeaseMs <= 0) return null;

  return {
    ...lease,
    expires_at: now + viewerLeaseMs,
    last_viewer_heartbeat_at: now,
  };
}

/**
 * @param {LeaseShape} lease
 * @param {StateShape} state
 * @param {string} projectRoot
 */
function isMatchingManagedSession(lease, state, projectRoot) {
  return Boolean(
    lease?.version === 1 &&
      state?.version === 1 &&
      lease.session_id === state.session_id &&
      lease.project_root === projectRoot &&
      state.project_root === projectRoot,
  );
}
