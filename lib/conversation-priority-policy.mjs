/**
 * @template T
 * @param {Array<T & {
 *   name: string,
 *   messageText: string,
 *   messageCount: number,
 *   lastActivity: number,
 *   starred: boolean
 * }>} records
 * @param {{
 *   priorityKeywords?: Array<{ id: string, keyword: string }>,
 *   search?: string,
 *   limit?: number
 * }} options
 * @returns {Array<T & {
 *   matched_keywords: string[],
 *   search_matched: boolean,
 *   search_match_location: 'name' | 'message' | 'combined' | null,
 *   priority_score: number
 * }>}
 */
export function prioritizeGroupRecords(
  records,
  { priorityKeywords = [], search = '', limit = 80 } = {},
) {
  const searchTerms = normalizedTerms(search);
  const normalizedKeywords = priorityKeywords
    .map((entry) => ({ ...entry, normalized: normalizeText(entry.keyword) }))
    .filter((entry) => entry.normalized);

  return records
    .map((record) => {
      const normalizedName = normalizeText(record.name);
      const normalizedMessages = normalizeText(record.messageText);
      const normalizedCorpus = `${normalizedName}\n${normalizedMessages}`;
      const matchedKeywords = normalizedKeywords
        .filter((entry) => normalizedCorpus.includes(entry.normalized))
        .map((entry) => entry.keyword);
      const searchMatched =
        searchTerms.length === 0 || searchTerms.every((term) => normalizedCorpus.includes(term));
      const searchMatchLocation = searchTerms.length === 0
        ? null
        : searchTerms.every((term) => normalizedName.includes(term))
          ? 'name'
          : searchTerms.every((term) => normalizedMessages.includes(term))
            ? 'message'
            : searchMatched
              ? 'combined'
              : null;

      return {
        ...record,
        matched_keywords: matchedKeywords,
        search_matched: searchMatched,
        search_match_location: searchMatchLocation,
        priority_score:
          Number(Boolean(record.starred)) * 100 +
          matchedKeywords.length * 10 +
          Math.min(9, Math.max(0, Number(record.messageCount) || 0)),
      };
    })
    .filter((record) => record.search_matched)
    .sort((left, right) =>
      Number(Boolean(right.starred)) - Number(Boolean(left.starred)) ||
      right.matched_keywords.length - left.matched_keywords.length ||
      right.messageCount - left.messageCount ||
      right.lastActivity - left.lastActivity ||
      left.name.localeCompare(right.name, 'zh-CN'),
    )
    .slice(0, Math.max(1, limit));
}

export function normalizePriorityKeyword(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 64);
}

function normalizedTerms(value) {
  return normalizeText(value).split(/\s+/).filter(Boolean).slice(0, 8);
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN');
}
