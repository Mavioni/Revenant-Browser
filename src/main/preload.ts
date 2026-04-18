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
