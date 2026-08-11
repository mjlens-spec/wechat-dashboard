// @ts-check

/** @typedef {'wechat' | 'feishu' | 'all'} KeywordSource */

/**
 * @param {unknown} value
 * @returns {KeywordSource}
 */
export function normalizeKeywordSource(value) {
  return value === 'wechat' || value === 'feishu' ? value : 'all';
}

/**
 * @param {KeywordSource} source
 * @param {'wechat' | 'feishu'} platform
 */
export function keywordMatchesPlatform(source, platform) {
  return source === 'all' || source === platform;
}
