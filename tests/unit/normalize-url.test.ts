/**
 * Unit tests for `normalizeUrl()` and `safeWindowOpenUrl()` from
 * `src/main/url-utils.ts`.
 *
 * Security contract under test:
 *   - Only http:// and https:// schemes are permitted to navigate.
 *   - Any other scheme (file:, data:, blob:, javascript:, about:, chrome:, ...)
 *     is redirected to the DuckDuckGo search fallback.
 *   - Empty input returns the home URL.
 *   - Bare domains (single-token, has a dot, no whitespace) are promoted to https://.
 *   - Everything else is a search query.
 */

import { describe, it, expect } from 'vitest';
import { normalizeUrl, safeWindowOpenUrl, NAV_HOME_URL } from '../../src/main/url-utils';

describe('normalizeUrl', () => {
  describe('empty / whitespace input', () => {
    it('returns home URL for empty string', () => {
      expect(normalizeUrl('')).toBe(NAV_HOME_URL);
    });

    it('returns home URL for whitespace-only string', () => {
      expect(normalizeUrl('   ')).toBe(NAV_HOME_URL);
      expect(normalizeUrl('\t\n')).toBe(NAV_HOME_URL);
    });
  });

  describe('allowed scheme passthrough', () => {
    it('keeps https:// URLs unchanged', () => {
      expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    });

    it('keeps http:// URLs unchanged', () => {
      expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000');
    });

    it('is case-insensitive for scheme', () => {
      expect(normalizeUrl('HTTPS://EXAMPLE.COM')).toBe('HTTPS://EXAMPLE.COM');
    });

    it('trims surrounding whitespace before scheme check', () => {
      expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com');
    });
  });

  describe('disallowed scheme — redirects to search (security)', () => {
    it('redirects file:// URLs to search', () => {
      expect(normalizeUrl('file:///C:/Users/massi/secret.txt')).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
    });

    it('redirects data: URLs to search', () => {
      expect(normalizeUrl('data:text/html,<script>alert(1)</script>')).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
    });

    it('redirects blob: URLs to search', () => {
      expect(normalizeUrl('blob:https://example.com/xyz')).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
    });

    it('redirects javascript: URLs to search', () => {
      expect(normalizeUrl('javascript:alert(1)')).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
    });

    it('redirects chrome: URLs to search', () => {
      expect(normalizeUrl('chrome://settings')).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
    });

    it('redirects about: URLs to search', () => {
      expect(normalizeUrl('about:blank')).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
    });
  });

  describe('bare-domain promotion', () => {
    it('prepends https:// to a bare domain', () => {
      expect(normalizeUrl('example.com')).toBe('https://example.com');
    });

    it('prepends https:// to a subdomain', () => {
      expect(normalizeUrl('docs.revenant.local')).toBe('https://docs.revenant.local');
    });

    it('preserves path and query when promoting', () => {
      expect(normalizeUrl('example.com/path?q=1')).toBe('https://example.com/path?q=1');
    });
  });

  describe('search fallback (no dot OR contains whitespace)', () => {
    it('treats single-word input as a search query', () => {
      expect(normalizeUrl('revenant')).toBe('https://duckduckgo.com/?q=revenant');
    });

    it('treats multi-word input as a search query', () => {
      expect(normalizeUrl('hello world')).toBe('https://duckduckgo.com/?q=hello%20world');
    });

    it('URL-encodes special characters in search query', () => {
      expect(normalizeUrl('c++ & rust')).toBe('https://duckduckgo.com/?q=c%2B%2B%20%26%20rust');
    });

    it('treats "dotted phrase with spaces" as search, not URL', () => {
      expect(normalizeUrl('example.com is great')).toBe(
        'https://duckduckgo.com/?q=example.com%20is%20great',
      );
    });
  });
});

describe('safeWindowOpenUrl', () => {
  it('returns the URL unchanged for https://', () => {
    expect(safeWindowOpenUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  it('returns the URL unchanged for http://', () => {
    expect(safeWindowOpenUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('rejects file:// (returns null)', () => {
    expect(safeWindowOpenUrl('file:///C:/Windows/System32/config.sys')).toBeNull();
  });

  it('rejects javascript:', () => {
    expect(safeWindowOpenUrl('javascript:void(0)')).toBeNull();
  });

  it('rejects data:', () => {
    expect(safeWindowOpenUrl('data:text/html,<h1>x</h1>')).toBeNull();
  });

  it('rejects bare domains (no scheme) — unlike normalizeUrl, window.open requires a full URL', () => {
    expect(safeWindowOpenUrl('example.com')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(safeWindowOpenUrl('')).toBeNull();
    expect(safeWindowOpenUrl('   ')).toBeNull();
  });
});
