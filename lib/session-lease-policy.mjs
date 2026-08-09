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
    lease.version === 1 &&
      state.version === 1 &&
      lease.session_id === state.session_id &&
      lease.project_root === projectRoot &&
      state.project_root === projectRoot &&
      Number.isFinite(lease.expires_at) &&
      lease.expires_at > now &&
      Number.isFinite(lease.skill_expires_at) &&
      lease.skill_expires_at > now,
  );
}
