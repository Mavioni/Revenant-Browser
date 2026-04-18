import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * Revenant Browser — smoke E2E.
 *
 * Scope: shell-only. Does not exercise:
 *   - OpenClaw tool routing (requires gateway on 127.0.0.1:18789)
 *   - Speech (requires Python 3.12 venv + model weights)
 *   - session:start (requires NeuralClaw stack)
 *
 * Boots the packaged main process from `dist/main/index.js`, asserts
 * the window renders, checks right-rail screen switching, and drives
 * the URL bar against https://example.com to prove the browser IPC
 * path and the `browser:nav-updated` event bus are wired.
 */

const REPO_ROOT = path.join(__dirname, '..', '..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'dist', 'main', 'index.js');
const EXAMPLE_URL = 'https://example.com/';

let app: ElectronApplication;
let win: Page;

let userDataDir: string;

test.beforeAll(async () => {
  // Isolated user-data-dir per test run — prevents localStorage (last-visited
  // screen, etc.) from leaking between runs and flaking the start-screen test.
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revenant-test-'));

  app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      REVENANT_TEST_MODE: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    timeout: 30_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('main window appears with correct title', async () => {
  expect(win).toBeTruthy();
  // Electron BrowserWindow title is set in createWindow() to "Revenant Browser"
  const title = await win.title();
  expect(title).toBe('Revenant Browser');
});

test('start screen is visible on boot', async () => {
  const startScreen = win.locator('.screen[data-screen="start"]');
  await expect(startScreen).toBeVisible();
  await expect(startScreen).toHaveClass(/active/);
});

test('right-rail "browsing" button switches to browsing screen', async () => {
  const browsingBtn = win.locator('.right-rail-btns button[data-screen="browsing"]');
  await browsingBtn.click();

  const browsingScreen = win.locator('.screen[data-screen="browsing"]');
  await expect(browsingScreen).toHaveClass(/active/, { timeout: 5_000 });

  const startScreen = win.locator('.screen[data-screen="start"]');
  await expect(startScreen).not.toHaveClass(/active/);
});

test('URL bar Enter drives WebContentsView and fires nav-updated', async () => {
  // Make sure we're on the browsing screen so the viewport is mounted.
  await win.locator('.right-rail-btns button[data-screen="browsing"]').click();
  await expect(win.locator('.screen[data-screen="browsing"]')).toHaveClass(/active/);

  // Install a one-shot nav-updated listener in the renderer via the
  // already-exposed preload bridge. We resolve on the first event whose
  // URL matches example.com (ignores transient about:blank states).
  const navEventPromise = win.evaluate<{ url: string; title: string; loading: boolean }>(
    () =>
      new Promise((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        if (!w.revenant?.browser?.onNavUpdated) {
          resolve({ url: 'BRIDGE_MISSING', title: '', loading: false });
          return;
        }
        w.revenant.browser.onNavUpdated((info: { url: string; title: string; loading: boolean }) => {
          if (info.url && info.url.includes('example.com')) {
            resolve(info);
          }
        });
      }),
  );

  const urlInput = win.locator('#url');
  await urlInput.fill(EXAMPLE_URL);
  await urlInput.press('Enter');

  const info = await Promise.race([
    navEventPromise,
    new Promise<{ url: string }>((_, reject) =>
      setTimeout(() => reject(new Error('nav-updated timeout (no example.com event in 20s)')), 20_000),
    ),
  ]);

  expect(info.url).toContain('example.com');
});

test('back / forward / reload IPC handlers do not throw', async () => {
  // These are safe to call even when history is empty — main-process
  // handlers guard with `canGoBack()` / `canGoForward()`.
  const result = await win.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const errors: string[] = [];
    try { await w.revenant.browser.back(); } catch (e) { errors.push(`back: ${String(e)}`); }
    try { await w.revenant.browser.forward(); } catch (e) { errors.push(`forward: ${String(e)}`); }
    try { await w.revenant.browser.reload(); } catch (e) { errors.push(`reload: ${String(e)}`); }
    return errors;
  });
  expect(result).toEqual([]);
});

test('preload bridge exposes window.revenant.browser surface', async () => {
  const shape = await win.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const b = w.revenant?.browser;
    if (!b) return null;
    return {
      hasNavigate: typeof b.navigate === 'function',
      hasBack: typeof b.back === 'function',
      hasForward: typeof b.forward === 'function',
      hasReload: typeof b.reload === 'function',
      hasHome: typeof b.home === 'function',
      hasGetState: typeof b.getState === 'function',
      hasOnNavUpdated: typeof b.onNavUpdated === 'function',
    };
  });

  expect(shape).not.toBeNull();
  expect(shape!).toMatchObject({
    hasNavigate: true,
    hasBack: true,
    hasForward: true,
    hasReload: true,
    hasHome: true,
    hasGetState: true,
    hasOnNavUpdated: true,
  });
});

test('window.revenant.tabs surface exposes full tab namespace', async () => {
  const shape = await win.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const t = w.revenant?.tabs;
    if (!t) return null;
    return {
      hasList: typeof t.list === 'function',
      hasActive: typeof t.active === 'function',
      hasCreate: typeof t.create === 'function',
      hasSwitch: typeof t.switch === 'function',
      hasClose: typeof t.close === 'function',
      hasNavigate: typeof t.navigate === 'function',
      hasReshuffleIdentity: typeof t.reshuffleIdentity === 'function',
      hasSetEgressLane: typeof t.setEgressLane === 'function',
      hasGraphSnapshot: typeof t.graphSnapshot === 'function',
      hasOnListUpdated: typeof t.onListUpdated === 'function',
      hasOnActiveChanged: typeof t.onActiveChanged === 'function',
      hasOnNavUpdated: typeof t.onNavUpdated === 'function',
      hasOnGraphUpdated: typeof t.onGraphUpdated === 'function',
    };
  });
  expect(shape).not.toBeNull();
  expect(shape!).toMatchObject({
    hasList: true, hasActive: true, hasCreate: true, hasSwitch: true, hasClose: true,
    hasNavigate: true, hasReshuffleIdentity: true, hasSetEgressLane: true,
    hasGraphSnapshot: true, hasOnListUpdated: true, hasOnActiveChanged: true,
    hasOnNavUpdated: true, hasOnGraphUpdated: true,
  });
});

test('tabs.create → tabs.list round-trip; tabs.close removes the tab', async () => {
  const list0 = await win.evaluate(() => (window as any).revenant.tabs.list());
  const initialCount = Array.isArray(list0) ? list0.length : 0;

  const created = await win.evaluate(() =>
    (window as any).revenant.tabs.create({ url: 'https://example.com/' }),
  );
  expect(created).toBeTruthy();
  expect(typeof created.id).toBe('string');
  expect(created.id.length).toBeGreaterThan(0);

  const list1 = await win.evaluate(() => (window as any).revenant.tabs.list());
  expect(Array.isArray(list1)).toBe(true);
  expect(list1.length).toBe(initialCount + 1);
  expect(list1.some((t: { id: string }) => t.id === created.id)).toBe(true);

  const closed = await win.evaluate((id) => (window as any).revenant.tabs.close(id), created.id);
  expect(closed).toMatchObject({ ok: true, closedId: created.id });

  const list2 = await win.evaluate(() => (window as any).revenant.tabs.list());
  expect(list2.length).toBe(initialCount);
  expect(list2.some((t: { id: string }) => t.id === created.id)).toBe(false);
});

test('tabs.reshuffleIdentity returns a fresh identity shell', async () => {
  const created = await win.evaluate(() =>
    (window as any).revenant.tabs.create({ url: 'https://example.com/' }),
  );
  const firstUA = created.identityShell.userAgent;

  // Reshuffle until UA changes (pool has 5 options — 4/5 odds each try)
  let reshuffled = created;
  for (let i = 0; i < 8; i += 1) {
    reshuffled = await win.evaluate(
      (id) => (window as any).revenant.tabs.reshuffleIdentity(id),
      created.id,
    );
    if (reshuffled.identityShell.userAgent !== firstUA) break;
  }
  expect(reshuffled.identityShell.userAgent).not.toBe(firstUA);

  // Clean up
  await win.evaluate((id) => (window as any).revenant.tabs.close(id), created.id);
});
