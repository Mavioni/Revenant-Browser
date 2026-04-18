import { BrowserWindow, WebContentsView } from 'electron';
import crypto from 'crypto';
import { safeWindowOpenUrl } from './url-utils';

/* =============================================================================
 * TAB MANAGER — owns one WebContentsView per tab (real per-tab Chromium).
 *
 * Design locks:
 *   - Tab = own WebContentsView (decision #1a)
 *   - Identity shell inherits from parentTabId, reshuffleable (#2)
 *   - Shrink + truncate on overflow is a CSS concern (renderer-side) (#3)
 *   - Tab Graph is a live DAG, broadcast on create/navigate/close (#4a)
 *   - URL bar routes to active tab; creates one if none (A1)
 *   - Boot with zero tabs; Start page is home (B2)
 *
 * Not in scope for this chunk (metadata-only for now):
 *   - Real User-Agent / canvas / WebGL spoofing (Phase 2)
 *   - Real Tor / VPN egress-lane routing (Phase 2)
 * ===========================================================================*/

export type EgressLane = 'reykjavik' | 'zurich' | 'tokyo' | 'onion' | 'local';

export interface IdentityShell {
  userAgent: string;
  canvas: 'spoofed' | 'real';
  webgl: 'masked' | 'real';
  timezone: string;
  language: string;
  fontCount: number;
}

export type TabState = 'active' | 'suspended' | 'closed';

export interface TabDTO {
  id: string;
  parentTabId: string | null;
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  createdAt: string;
  lastFocusedAt: string;
  state: TabState;
  ghostMode: boolean;
  identityShell: IdentityShell;
  egressLane: EgressLane;
  activeVisit: number; // count of navigations in this tab, for Graph layout
}

export interface GraphVisit {
  url: string;
  at: string;
}

export interface GraphNode {
  tabId: string;
  title: string;
  url: string;
  parentTabId: string | null;
  createdAt: string;
  state: TabState;
  visits: GraphVisit[];
}

interface Tab {
  id: string;
  view: WebContentsView;
  parentTabId: string | null;
  createdAt: string;
  lastFocusedAt: string;
  state: TabState;
  ghostMode: boolean;
  identityShell: IdentityShell;
  egressLane: EgressLane;
  favicon: string | null;
  visits: GraphVisit[];
}

export interface CreateTabOpts {
  url?: string;
  parentTabId?: string | null;
  ghostMode?: boolean;
  egressLane?: EgressLane;
}

type Listener<T> = (payload: T) => void;

/* =============================================================================
 * Identity-shell generator (metadata-only for v1)
 * ===========================================================================*/

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

const TZ_POOL = ['UTC+0', 'UTC-5', 'UTC-8', 'UTC+1', 'UTC+9'];
const LANG_POOL = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP', 'is-IS'];
const EGRESS_POOL: EgressLane[] = ['reykjavik', 'zurich', 'tokyo', 'onion', 'local'];

function rand<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateIdentityShell(): IdentityShell {
  return {
    userAgent: rand(UA_POOL),
    canvas: 'spoofed',
    webgl: 'masked',
    timezone: rand(TZ_POOL),
    language: rand(LANG_POOL),
    fontCount: 10 + Math.floor(Math.random() * 8),
  };
}

/* =============================================================================
 * TabManager
 * ===========================================================================*/

export class TabManager {
  private readonly tabs = new Map<string, Tab>();
  private activeTabId: string | null = null;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private attached = false;

  private readonly onListUpdatedListeners: Listener<TabDTO[]>[] = [];
  private readonly onActiveChangedListeners: Listener<TabDTO | null>[] = [];
  private readonly onNavUpdatedListeners: Listener<TabDTO>[] = [];
  private readonly onGraphUpdatedListeners: Listener<GraphNode[]>[] = [];

  constructor(private readonly window: BrowserWindow) {}

  onListUpdated(cb: Listener<TabDTO[]>): void { this.onListUpdatedListeners.push(cb); }
  onActiveChanged(cb: Listener<TabDTO | null>): void { this.onActiveChangedListeners.push(cb); }
  onNavUpdated(cb: Listener<TabDTO>): void { this.onNavUpdatedListeners.push(cb); }
  onGraphUpdated(cb: Listener<GraphNode[]>): void { this.onGraphUpdatedListeners.push(cb); }

  /* ----- layout ----- */

  setBounds(bounds: { x: number; y: number; width: number; height: number }, visible: boolean): void {
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    };
    if (!visible || this.bounds.width === 0 || this.bounds.height === 0) {
      this.detachActive();
      return;
    }
    this.attachActive();
  }

  private attachActive(): void {
    const active = this.getActive();
    if (!active) return;
    if (!this.attached) {
      this.window.contentView.addChildView(active.view);
      this.attached = true;
    }
    active.view.setBounds(this.bounds);
  }

  private detachActive(): void {
    const active = this.getActive();
    if (active && this.attached) {
      try { this.window.contentView.removeChildView(active.view); } catch { /* noop */ }
    }
    this.attached = false;
  }

  /* ----- registry ----- */

  list(): TabDTO[] {
    return [...this.tabs.values()]
      .filter((t) => t.state !== 'closed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => this.toDTO(t));
  }

  active(): TabDTO | null {
    const a = this.getActive();
    return a ? this.toDTO(a) : null;
  }

  private getActive(): Tab | null {
    if (!this.activeTabId) return null;
    const t = this.tabs.get(this.activeTabId);
    return t && t.state !== 'closed' ? t : null;
  }

  /* ----- lifecycle ----- */

  create(opts: CreateTabOpts = {}): TabDTO {
    const parent = opts.parentTabId ? this.tabs.get(opts.parentTabId) || null : null;
    const identity = parent ? { ...parent.identityShell } : generateIdentityShell();
    const egress = opts.egressLane ?? (parent ? parent.egressLane : rand(EGRESS_POOL));
    const ghost = opts.ghostMode ?? (parent ? parent.ghostMode : false);

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Apply UA from identity shell (real display-layer spoof; rest is metadata).
    try { view.webContents.setUserAgent(identity.userAgent); } catch { /* noop */ }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const tab: Tab = {
      id,
      view,
      parentTabId: opts.parentTabId ?? null,
      createdAt: now,
      lastFocusedAt: now,
      state: 'active',
      ghostMode: ghost,
      identityShell: identity,
      egressLane: egress,
      favicon: null,
      visits: [],
    };

    this.wireTab(tab);
    this.tabs.set(id, tab);

    // Navigate to requested URL (or leave blank)
    const target = opts.url && opts.url.trim() ? opts.url.trim() : null;
    if (target) {
      view.webContents.loadURL(target).catch(() => undefined);
    }

    // Switch to the new tab.
    this.switch(id);

    this.emitList();
    this.emitGraph();
    return this.toDTO(tab);
  }

  private wireTab(tab: Tab): void {
    const wc = tab.view.webContents;

    const emitNav = () => {
      this.emitNav(tab);
      this.emitGraph();
    };

    wc.on('did-navigate', (_e, url: string) => {
      tab.visits.push({ url, at: new Date().toISOString() });
      emitNav();
    });
    wc.on('did-navigate-in-page', emitNav);
    wc.on('did-start-loading', emitNav);
    wc.on('did-stop-loading', emitNav);
    wc.on('page-title-updated', emitNav);
    wc.on('page-favicon-updated', (_e, favicons: string[]) => {
      tab.favicon = favicons[0] ?? null;
      emitNav();
    });

    // Open target=_blank in a new tab inheriting this one (per identity-inheritance).
    wc.setWindowOpenHandler(({ url }) => {
      const safe = safeWindowOpenUrl(url);
      if (safe) this.create({ url: safe, parentTabId: tab.id });
      return { action: 'deny' };
    });
  }

  switch(tabId: string): TabDTO | null {
    const target = this.tabs.get(tabId);
    if (!target || target.state === 'closed') return null;

    if (this.activeTabId === tabId) {
      target.lastFocusedAt = new Date().toISOString();
      return this.toDTO(target);
    }

    // Detach current
    this.detachActive();

    this.activeTabId = tabId;
    target.state = 'active';
    target.lastFocusedAt = new Date().toISOString();

    // Re-attach if bounds are valid (i.e. we're on the Browsing screen)
    if (this.bounds.width > 0 && this.bounds.height > 0) {
      this.attachActive();
    }

    this.emitList();
    this.emitActive();
    return this.toDTO(target);
  }

  close(tabId: string): { ok: true; closedId: string; newActiveId: string | null } {
    const target = this.tabs.get(tabId);
    if (!target || target.state === 'closed') {
      return { ok: true, closedId: tabId, newActiveId: this.activeTabId };
    }

    const wasActive = this.activeTabId === tabId;
    if (wasActive) this.detachActive();

    target.state = 'closed';
    try {
      target.view.webContents.close();
    } catch { /* noop */ }

    let newActiveId: string | null = null;
    if (wasActive) {
      const remaining = [...this.tabs.values()].filter((t) => t.state !== 'closed');
      remaining.sort((a, b) => b.lastFocusedAt.localeCompare(a.lastFocusedAt));
      if (remaining.length > 0) {
        newActiveId = remaining[0].id;
        this.switch(newActiveId);
      } else {
        this.activeTabId = null;
        this.emitActive();
      }
    }

    this.emitList();
    this.emitGraph();
    return { ok: true, closedId: tabId, newActiveId };
  }

  /* ----- navigation ----- */

  navigate(tabId: string, url: string): { ok: boolean; url?: string; error?: string } {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.state === 'closed') return { ok: false, error: 'tab-not-found' };
    tab.view.webContents.loadURL(url).catch(() => undefined);
    return { ok: true, url };
  }

  back(tabId: string): { ok: true; navigated: boolean } {
    const tab = this.tabs.get(tabId);
    if (!tab) return { ok: true, navigated: false };
    const history = tab.view.webContents.navigationHistory;
    if (history?.canGoBack?.()) {
      history.goBack();
      return { ok: true, navigated: true };
    }
    return { ok: true, navigated: false };
  }

  forward(tabId: string): { ok: true; navigated: boolean } {
    const tab = this.tabs.get(tabId);
    if (!tab) return { ok: true, navigated: false };
    const history = tab.view.webContents.navigationHistory;
    if (history?.canGoForward?.()) {
      history.goForward();
      return { ok: true, navigated: true };
    }
    return { ok: true, navigated: false };
  }

  reload(tabId: string): void {
    const tab = this.tabs.get(tabId);
    tab?.view.webContents.reload();
  }

  /* ----- identity / egress ----- */

  reshuffleIdentity(tabId: string): TabDTO | null {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.state === 'closed') return null;
    tab.identityShell = generateIdentityShell();
    try { tab.view.webContents.setUserAgent(tab.identityShell.userAgent); } catch { /* noop */ }
    this.emitNav(tab);
    return this.toDTO(tab);
  }

  setEgressLane(tabId: string, lane: EgressLane): TabDTO | null {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.state === 'closed') return null;
    tab.egressLane = lane;
    this.emitNav(tab);
    return this.toDTO(tab);
  }

  /* ----- graph ----- */

  graphSnapshot(): GraphNode[] {
    return [...this.tabs.values()].map((t) => ({
      tabId: t.id,
      title: t.view.webContents.getTitle() || '(untitled)',
      url: t.view.webContents.getURL() || '',
      parentTabId: t.parentTabId,
      createdAt: t.createdAt,
      state: t.state,
      visits: [...t.visits],
    }));
  }

  /* ----- emit ----- */

  private toDTO(t: Tab): TabDTO {
    const wc = t.view.webContents;
    return {
      id: t.id,
      parentTabId: t.parentTabId,
      url: wc.getURL() || '',
      title: wc.getTitle() || '',
      favicon: t.favicon,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory?.canGoBack?.() ?? false,
      canGoForward: wc.navigationHistory?.canGoForward?.() ?? false,
      createdAt: t.createdAt,
      lastFocusedAt: t.lastFocusedAt,
      state: t.state,
      ghostMode: t.ghostMode,
      identityShell: t.identityShell,
      egressLane: t.egressLane,
      activeVisit: t.visits.length,
    };
  }

  private emitList(): void {
    const payload = this.list();
    for (const cb of this.onListUpdatedListeners) cb(payload);
  }

  private emitActive(): void {
    const payload = this.active();
    for (const cb of this.onActiveChangedListeners) cb(payload);
  }

  private emitNav(tab: Tab): void {
    const payload = this.toDTO(tab);
    for (const cb of this.onNavUpdatedListeners) cb(payload);
  }

  private emitGraph(): void {
    const payload = this.graphSnapshot();
    for (const cb of this.onGraphUpdatedListeners) cb(payload);
  }

  /* ----- teardown ----- */

  dispose(): void {
    this.detachActive();
    for (const tab of this.tabs.values()) {
      try { tab.view.webContents.close(); } catch { /* noop */ }
    }
    this.tabs.clear();
    this.activeTabId = null;
  }
}
