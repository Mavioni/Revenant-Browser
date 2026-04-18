export const NAV_HOME_URL = 'https://duckduckgo.com/';

const ALLOWED_NAV_SCHEMES = new Set(['http:', 'https:']);

/**
 * Normalize user input from the omnibox into a safe navigation URL.
 *
 * Security contract:
 *   - Only http: and https: schemes are accepted verbatim.
 *   - Any other scheme (file:, data:, blob:, javascript:, chrome:, etc.)
 *     is treated as a search query and routed through DuckDuckGo.
 *   - Empty input returns the home URL.
 *   - Bare domains (single-token, contains a dot, no whitespace) are
 *     promoted to https://.
 *   - Everything else is a search query.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return NAV_HOME_URL;

  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase() + ':';
    if (ALLOWED_NAV_SCHEMES.has(scheme)) return trimmed;
    // Unknown or dangerous scheme — fall through to search instead of loading it.
    return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  }

  // No scheme: disambiguate bare-domain vs search.
  if (/\s/.test(trimmed) || !/\./.test(trimmed)) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  }
  return `https://${trimmed}`;
}

/**
 * Guard for target=_blank navigations that enter through setWindowOpenHandler.
 * Returns the URL if it is safe to load in-view, or null if it should be ignored.
 */
export function safeWindowOpenUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!schemeMatch) return null; // No scheme on window.open → reject, don't default-https
  const scheme = schemeMatch[1].toLowerCase() + ':';
  return ALLOWED_NAV_SCHEMES.has(scheme) ? trimmed : null;
}
