// @ts-check

const BROWSER_ADAPTERS = new Map(
  [
    ['com.apple.safari', 'com.apple.Safari', 'safari'],
    ['com.apple.safaritechnologypreview', 'com.apple.SafariTechnologyPreview', 'safari'],
    ['com.google.chrome', 'com.google.Chrome', 'chromium'],
    ['com.google.chrome.beta', 'com.google.Chrome.beta', 'chromium'],
    ['com.google.chrome.dev', 'com.google.Chrome.dev', 'chromium'],
    ['com.google.chrome.canary', 'com.google.Chrome.canary', 'chromium'],
    ['org.chromium.chromium', 'org.chromium.Chromium', 'chromium'],
    ['com.microsoft.edgemac', 'com.microsoft.edgemac', 'chromium'],
    ['com.microsoft.edgemac.beta', 'com.microsoft.edgemac.Beta', 'chromium'],
    ['com.microsoft.edgemac.dev', 'com.microsoft.edgemac.Dev', 'chromium'],
    ['com.microsoft.edgemac.canary', 'com.microsoft.edgemac.Canary', 'chromium'],
    ['com.brave.browser', 'com.brave.Browser', 'chromium'],
    ['com.brave.browser.beta', 'com.brave.Browser.beta', 'chromium'],
    ['com.brave.browser.nightly', 'com.brave.Browser.nightly', 'chromium'],
    ['com.vivaldi.vivaldi', 'com.vivaldi.Vivaldi', 'chromium'],
    ['com.vivaldi.vivaldi.snapshot', 'com.vivaldi.Vivaldi.snapshot', 'chromium'],
    ['com.operasoftware.opera', 'com.operasoftware.Opera', 'chromium'],
    ['com.operasoftware.operagx', 'com.operasoftware.OperaGX', 'chromium'],
    ['company.thebrowser.browser', 'company.thebrowser.Browser', 'chromium'],
    ['ai.perplexity.comet', 'ai.perplexity.comet', 'chromium'],
  ].map(([key, bundleId, kind]) => [key, { bundleId, kind }]),
);

/**
 * @param {unknown} rawHandlers
 */
export function selectDefaultHttpBrowserBundleId(rawHandlers) {
  if (!Array.isArray(rawHandlers)) return null;
  const handlers = rawHandlers.filter(
    (handler) => handler && typeof handler === 'object',
  );
  const explicitHttp = handlers.filter(
    (handler) => handler.LSHandlerURLScheme?.toLowerCase() === 'http',
  );
  const browserRole = handlers.filter(
    (handler) => handler.LSHandlerContentType === 'com.apple.default-app.web-browser',
  );
  return newestBundleId(explicitHttp) ?? newestBundleId(browserRole);
}

/** @param {string | null | undefined} bundleId */
export function browserAutomationAdapter(bundleId) {
  if (typeof bundleId !== 'string') return null;
  return BROWSER_ADAPTERS.get(bundleId.trim().toLowerCase()) ?? null;
}

/**
 * Builds a fixed AppleScript for a trusted browser adapter. The target URL is
 * passed separately as argv, so browsing data and shell strings are never
 * interpolated into the script.
 *
 * @param {{ bundleId: string; kind: string }} adapter
 */
export function existingPageRefreshAppleScript(adapter) {
  if (!browserAutomationAdapter(adapter?.bundleId)) {
    throw new Error('Unsupported default browser adapter.');
  }
  const selectTab =
    adapter.kind === 'safari'
      ? 'set current tab of browserWindow to browserTab'
      : 'set active tab index of browserWindow to tabIndex';
  return [
    'on run argv',
    '  set targetURL to item 1 of argv',
    '  set targetURLWithoutSlash to item 2 of argv',
    `  tell application id "${adapter.bundleId}"`,
    '    if it is running then',
    '      repeat with windowIndex from 1 to (count of windows)',
    '        set browserWindow to window windowIndex',
    '        repeat with tabIndex from 1 to (count of tabs of browserWindow)',
    '          set browserTab to tab tabIndex of browserWindow',
    '          if my sameDashboardURL((URL of browserTab as text), targetURL, targetURLWithoutSlash) then',
    `            ${selectTab}`,
    '            set URL of browserTab to targetURL',
    '            try',
    '              set index of browserWindow to 1',
    '            end try',
    '            activate',
    '            return "refreshed_existing_page"',
    '          end if',
    '        end repeat',
    '      end repeat',
    '    end if',
    '  end tell',
    '  return "page_not_open"',
    'end run',
    '',
    'on sameDashboardURL(candidateURL, targetURL, targetURLWithoutSlash)',
    '  return candidateURL is targetURL or candidateURL is targetURLWithoutSlash',
    'end sameDashboardURL',
  ].join('\n');
}

/** @param {Array<Record<string, unknown>>} handlers */
function newestBundleId(handlers) {
  return handlers
    .map((handler) => ({
      bundleId:
        typeof handler.LSHandlerRoleAll === 'string'
          ? handler.LSHandlerRoleAll
          : null,
      changedAt: Number(handler.LSHandlerModificationDate) || 0,
    }))
    .filter((handler) => handler.bundleId)
    .sort((left, right) => right.changedAt - left.changedAt)[0]?.bundleId ?? null;
}
