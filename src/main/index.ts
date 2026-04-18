import { app, BrowserWindow, ipcMain, Tray, Menu, dialog, desktopCapturer } from 'electron';
import path from 'path';
import fs from 'fs';
import { setupTray } from './tray';
import { CompanionStore } from './companion-store';
import { RuntimeSupervisor } from './runtime-supervisor';
import { SpeechService } from './speech-service';
import { OpenClawGatewayClient } from './openclaw-client';
import {
  ExecutionResult,
  PermissionTier,
  SpeechSynthesisResult,
} from './lelu-types';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let companionStore: CompanionStore;
let runtimeSupervisor: RuntimeSupervisor;
let speechService: SpeechService;
let openClawClient: OpenClawGatewayClient;
let speechResetTimer: ReturnType<typeof setTimeout> | null = null;

const VALID_PERMISSION_TIERS: PermissionTier[] = [
  'observe',
  'draft',
  'workspace-mutate',
  'system-mutate',
  'external-act',
];

const DEFAULT_CONFIG_TEMPLATE: Record<string, unknown> = {
  leluRuntimeRoot: '',
  leluComposeFile: 'docker-compose.yml',
  leluOpenClawEndpoint: 'http://127.0.0.1:18789',
  leluRemoteOptIn: false,
  leluTtsBackend: 'kokoro',
  leluSpeechVoice: 'af_heart',
  leluAsrModel: 'openai/whisper-large-v3-turbo',
  leluVisionModel: 'Qwen/Qwen3-VL-2B-Instruct',
  leluGitHubToken: '',
};

function getResourcePath(relativePath: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  }
  return path.join(__dirname, '..', '..', 'resources', relativePath);
}

function getDataDir(): string {
  return path.join(app.getPath('appData'), 'revenant-browser');
}

function getConfigPath(): string {
  return path.join(getDataDir(), 'config.json');
}

function buildDefaultConfig(): Record<string, unknown> {
  return {
    ...DEFAULT_CONFIG_TEMPLATE,
    leluRuntimeRoot: path.join(app.getPath('home'), 'NeuralClaw'),
  };
}

function getConfig(): Record<string, unknown> {
  const defaults = buildDefaultConfig();
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...defaults, ...userConfig };
    } catch {
      return defaults;
    }
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2));
  return defaults;
}

const VALID_CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG_TEMPLATE));

function setConfig(key: string, value: unknown): void {
  if (!VALID_CONFIG_KEYS.has(key)) return;
  const configPath = getConfigPath();
  const config = getConfig();
  (config as Record<string, unknown>)[key] = value;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'Revenant Browser',
    icon: getResourcePath('icon.ico'),
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', () => {
    (app as unknown as { isQuitting: boolean }).isQuitting = true;
    app.quit();
  });
}

function broadcastCompanionEvent(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

async function initialize(): Promise<void> {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const appRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '..', '..');
  const pythonDir = path.join(appRoot, 'python');

  companionStore = new CompanionStore(dataDir);
  runtimeSupervisor = new RuntimeSupervisor(getConfig);
  speechService = new SpeechService(pythonDir, getConfig);
  openClawClient = new OpenClawGatewayClient(getConfig);

  runtimeSupervisor.onHealthChanged((health) => {
    broadcastCompanionEvent('companion:runtime-health', health);
  });

  companionStore.onGrantRequest((event) => {
    broadcastCompanionEvent('companion:grant-request', event.payload);
  });

  companionStore.onGrantDecision((event) => {
    broadcastCompanionEvent('companion:grant-decision', event.payload);
  });

  // Session lifecycle
  ipcMain.handle('session:start', async () => runtimeSupervisor.sessionStart());
  ipcMain.handle('session:resume', async () => runtimeSupervisor.sessionResume());
  ipcMain.handle('session:stop', async () => runtimeSupervisor.sessionStop());
  ipcMain.handle('session:health', () => runtimeSupervisor.getHealth());

  // Speech — routes through Python worker (Whisper + Kokoro via 3.12 venv)
  ipcMain.handle('speech:transcribe', async (_event, payload: unknown) => {
    return speechService.transcribe(payload);
  });

  ipcMain.handle('speech:speak', async (_event, text: string, options?: Record<string, unknown>) => {
    const result: SpeechSynthesisResult = await speechService.synthesize(text, options ?? {});
    broadcastCompanionEvent('companion:speech-output', result);
    if (speechResetTimer) clearTimeout(speechResetTimer);
    speechResetTimer = setTimeout(() => {
      speechResetTimer = null;
    }, Math.max(1000, (result.durationMs ?? 0) + 400));
    return result;
  });

  // Vision — desktop capture for AI screen understanding
  ipcMain.handle('vision:capture', async (_event, request: { source: 'screen' | 'window' | 'selection'; detail: 'thumbnail' | 'full' }) => {
    const size = request.detail === 'full' ? { width: 1920, height: 1080 } : { width: 640, height: 360 };
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: size });
    const source = sources[0];
    if (!source) {
      return {
        source: request.source,
        capturedAt: new Date().toISOString(),
        note: 'No capturable display found.',
      };
    }
    const thumbnail = source.thumbnail;
    return {
      source: request.source,
      capturedAt: new Date().toISOString(),
      dataUrl: thumbnail.toDataURL(),
      width: thumbnail.getSize().width,
      height: thumbnail.getSize().height,
    };
  });

  ipcMain.handle('vision:analyze', async () => {
    return { status: 'not-implemented', note: 'VLM analyze endpoint is scoped for a later phase.' };
  });

  // Tool routing — gated through CompanionStore approval tiers
  async function dispatchTool(intent: 'plan' | 'execute', title: string, tierInput: string, reason: string, command?: string): Promise<ExecutionResult> {
    const tier: PermissionTier = VALID_PERMISSION_TIERS.includes(tierInput as PermissionTier)
      ? (tierInput as PermissionTier)
      : 'observe';
    const outcome = companionStore.requestGrant(intent, title, tier, reason, command);
    if (outcome.status === 'auto-approved') {
      const result = intent === 'plan'
        ? await openClawClient.planTool(title, tier, reason, command)
        : await openClawClient.executeTool(title, tier, reason, command);
      companionStore.recordExecution(outcome.request, result);
      return result;
    }
    return {
      status: intent === 'plan' ? 'planned' : 'blocked',
      backend: 'openclaw',
      output: `${intent === 'plan' ? 'Plan' : 'Execution'} queued for approval (tier: ${tier}).`,
      requestId: outcome.request.id,
    };
  }

  ipcMain.handle('tool:plan', async (_event, title: string, tier: string, reason: string, command?: string) => {
    return dispatchTool('plan', title, tier, reason, command);
  });

  ipcMain.handle('tool:execute', async (_event, title: string, tier: string, reason: string, command?: string) => {
    return dispatchTool('execute', title, tier, reason, command);
  });

  ipcMain.handle('tool:pending', () => companionStore.listPendingRequests());

  ipcMain.handle('tool:approve', async (_event, requestId: string, approved: boolean, note?: string) => {
    const pending = companionStore.getPendingRequest(requestId);
    if (!pending) {
      return { status: 'error', backend: 'companion-queue', output: 'Request not found or already resolved.' } satisfies ExecutionResult;
    }
    const decision = companionStore.decideGrant(requestId, approved, note ?? '');
    if (!decision || decision.decision !== 'approved') {
      return { status: 'blocked', backend: 'companion-queue', output: 'Request denied.' } satisfies ExecutionResult;
    }
    const { title, tier, reason, command, intent } = pending;
    const result = intent === 'plan'
      ? await openClawClient.planTool(title, tier, reason, command)
      : await openClawClient.executeTool(title, tier, reason, command);
    companionStore.recordExecution(pending, result);
    return result;
  });

  // Config
  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:set', (_event, key: string, value: unknown) => {
    setConfig(key, value);
    return getConfig();
  });

  // App
  ipcMain.handle('app:get-data-dir', () => getDataDir());
  ipcMain.handle('app:quit', () => {
    (app as unknown as { isQuitting: boolean }).isQuitting = true;
    app.quit();
  });
  ipcMain.handle('app:check-internet', async () => {
    try {
      const response = await fetch('https://1.1.1.1/cdn-cgi/trace', { method: 'GET' });
      return { online: response.ok };
    } catch {
      return { online: false };
    }
  });
}

app.whenReady().then(async () => {
  await initialize();
  createWindow();
  if (mainWindow) {
    tray = setupTray(mainWindow, getResourcePath('icon.ico'));
  }
});

app.on('window-all-closed', () => {
  speechService?.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  speechService?.stop();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
