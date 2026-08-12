// @ts-check

/**
 * @typedef {{ evidenceIds: string[], title: string, detail: string }} IntelligenceItem
 */

/**
 * A processed or dismissed item stays suppressed when a later analysis cites
 * any of the same messages, even if Terra changes the wording or adds evidence.
 *
 * @param {IntelligenceItem} candidate
 * @param {IntelligenceItem} previous
 */
export function matchesSuppressedItem(candidate, previous) {
  if (hasEvidenceOverlap(candidate.evidenceIds, previous.evidenceIds)) return true;

  const titleScore = textSimilarity(candidate.title, previous.title);
  if (titleScore >= 0.58) return true;

  const detailScore = textSimilarity(candidate.detail, previous.detail);
  return titleScore >= 0.34 && detailScore >= 0.56;
}

/**
 * @param {string[]} left
 * @param {string[]} right
 */
export function hasEvidenceOverlap(left, right) {
  if (left.length === 0 || right.length === 0) return false;
  const known = new Set(left);
  return right.some((value) => known.has(value));
}

/**
 * Compare short Chinese or mixed-language descriptions without persisting
 * plaintext search keys. Character bigrams preserve enough context to avoid
 * treating two unrelated items in the same category as one.
 *
 * @param {string} left
 * @param {string} right
 */
export function textSimilarity(left, right) {
  const leftFeatures = textFeatures(left);
  const rightFeatures = textFeatures(right);
  if (leftFeatures.size === 0 || rightFeatures.size === 0) return 0;

  let intersection = 0;
  for (const feature of leftFeatures) {
    if (rightFeatures.has(feature)) intersection++;
  }
  return (2 * intersection) / (leftFeatures.size + rightFeatures.size);
}

/**
 * @param {string} value
 */
function textFeatures(value) {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
  const features = new Set();

  for (const token of normalized.split(/\s+/u).filter(Boolean)) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length === 1) features.add(`c:${token}`);
      for (let index = 0; index < token.length - 1; index++) {
        features.add(`b:${token.slice(index, index + 2)}`);
      }
      continue;
    }
    features.add(`w:${token}`);
  }

  return features;
}
