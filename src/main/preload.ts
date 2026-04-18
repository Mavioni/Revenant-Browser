import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('revenant', {
  session: {
    start: () => ipcRenderer.invoke('session:start'),
    resume: () => ipcRenderer.invoke('session:resume'),
    stop: () => ipcRenderer.invoke('session:stop'),
    health: () => ipcRenderer.invoke('session:health'),
  },

  speech: {
    transcribe: (payload: string | Record<string, unknown>) =>
      ipcRenderer.invoke('speech:transcribe', payload),
    speak: (text: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke('speech:speak', text, options),
  },

  vision: {
    capture: (request: { source: 'screen' | 'window' | 'selection'; detail: 'thumbnail' | 'full' }) =>
      ipcRenderer.invoke('vision:capture', request),
    analyze: (request: unknown) => ipcRenderer.invoke('vision:analyze', request),
  },

  tool: {
    plan: (title: string, tier: string, reason: string, command?: string) =>
      ipcRenderer.invoke('tool:plan', title, tier, reason, command),
    execute: (title: string, tier: string, reason: string, command?: string) =>
      ipcRenderer.invoke('tool:execute', title, tier, reason, command),
    pending: () => ipcRenderer.invoke('tool:pending'),
    approve: (requestId: string, approved: boolean, note?: string) =>
      ipcRenderer.invoke('tool:approve', requestId, approved, note),
  },

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (key: string, value: unknown) => ipcRenderer.invoke('config:set', key, value),
  },

  app: {
    getDataDir: () => ipcRenderer.invoke('app:get-data-dir'),
    checkInternet: () => ipcRenderer.invoke('app:check-internet'),
    quit: () => ipcRenderer.invoke('app:quit'),
  },

  browser: {
    navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    home: () => ipcRenderer.invoke('browser:home'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }, visible: boolean) =>
      ipcRenderer.invoke('browser:set-bounds', bounds, visible),
    getState: () => ipcRenderer.invoke('browser:get-state'),
    onNavUpdated: (callback: (info: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }) => void) => {
      const listener = (_event: unknown, info: unknown) => callback(info as Parameters<typeof callback>[0]);
      ipcRenderer.on('browser:nav-updated', listener);
      return () => ipcRenderer.removeListener('browser:nav-updated', listener);
    },
  },

  tabs: {
    list: () => ipcRenderer.invoke('tabs:list'),
    active: () => ipcRenderer.invoke('tabs:active'),
    create: (opts?: { url?: string; parentTabId?: string | null; ghostMode?: boolean; egressLane?: string }) =>
      ipcRenderer.invoke('tabs:create', opts),
    switch: (tabId: string) => ipcRenderer.invoke('tabs:switch', tabId),
    close: (tabId: string) => ipcRenderer.invoke('tabs:close', tabId),
    navigate: (tabId: string, url: string) => ipcRenderer.invoke('tabs:navigate', tabId, url),
    back: (tabId: string) => ipcRenderer.invoke('tabs:back', tabId),
    forward: (tabId: string) => ipcRenderer.invoke('tabs:forward', tabId),
    reload: (tabId: string) => ipcRenderer.invoke('tabs:reload', tabId),
    reshuffleIdentity: (tabId: string) => ipcRenderer.invoke('tabs:reshuffle-identity', tabId),
    setEgressLane: (tabId: string, lane: string) => ipcRenderer.invoke('tabs:set-egress-lane', tabId, lane),
    graphSnapshot: () => ipcRenderer.invoke('tabs:graph-snapshot'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }, visible: boolean) =>
      ipcRenderer.invoke('tabs:set-bounds', bounds, visible),
    onListUpdated: (callback: (list: unknown[]) => void) => {
      const listener = (_event: unknown, list: unknown) => callback(list as unknown[]);
      ipcRenderer.on('tabs:list-updated', listener);
      return () => ipcRenderer.removeListener('tabs:list-updated', listener);
    },
    onActiveChanged: (callback: (active: unknown) => void) => {
      const listener = (_event: unknown, active: unknown) => callback(active);
      ipcRenderer.on('tabs:active-changed', listener);
      return () => ipcRenderer.removeListener('tabs:active-changed', listener);
    },
    onNavUpdated: (callback: (tab: unknown) => void) => {
      const listener = (_event: unknown, tab: unknown) => callback(tab);
      ipcRenderer.on('tabs:nav-updated', listener);
      return () => ipcRenderer.removeListener('tabs:nav-updated', listener);
    },
    onGraphUpdated: (callback: (graph: unknown[]) => void) => {
      const listener = (_event: unknown, graph: unknown) => callback(graph as unknown[]);
      ipcRenderer.on('tabs:graph-updated', listener);
      return () => ipcRenderer.removeListener('tabs:graph-updated', listener);
    },
  },

  on: (eventName: string, callback: (...args: unknown[]) => void) => {
    const ALLOWED_CHANNELS = new Set([
      'companion:runtime-health',
      'companion:grant-request',
      'companion:grant-decision',
      'companion:speech-output',
    ]);
    const channel = `companion:${eventName}`;
    if (!ALLOWED_CHANNELS.has(channel)) return;
    ipcRenderer.on(channel, (_event, ...args: unknown[]) => callback(...args));
  },
});
