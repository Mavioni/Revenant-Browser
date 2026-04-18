export type SessionState = 'stopped' | 'starting' | 'ready' | 'error';

export type CompanionPresence = 'tray-only' | 'docked-companion' | 'overlay-companion';

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'executing' | 'warning';

export type PermissionTier =
  | 'observe'
  | 'draft'
  | 'workspace-mutate'
  | 'system-mutate'
  | 'external-act';

export type ToolIntent = 'plan' | 'execute';

export type GrantPolicy = 'auto' | 'confirm' | 'hard-confirm';

export interface RuntimeServiceHealth {
  key: string;
  label: string;
  port: number;
  url: string;
  status: 'healthy' | 'auth-required' | 'unreachable';
  detail: string;
}

export interface RuntimeHealth {
  state: SessionState;
  startedBySupervisor: boolean;
  rootPath: string;
  composeFile: string;
  remoteOptIn: boolean;
  updatedAt: string;
  services: RuntimeServiceHealth[];
  lastError?: string;
}

export interface AvatarSnapshot {
  visible: boolean;
  presence: CompanionPresence;
  state: AvatarState;
  expression: string;
  modelUrl?: string;
  voiceActivity: number;
  sessionState: SessionState;
}

export interface CompanionEvent<T = unknown> {
  type: string;
  at: string;
  payload?: T;
}

export interface ToolGrantRequest {
  id: string;
  intent: ToolIntent;
  backend: 'openclaw';
  tier: PermissionTier;
  title: string;
  reason: string;
  command?: string;
  policy: GrantPolicy;
  createdAt: string;
}

export interface ToolGrantDecision {
  requestId: string;
  tier: PermissionTier;
  decision: 'approved' | 'denied';
  decidedAt: string;
  note?: string;
}

export interface ToolPlan {
  id: string;
  intent: ToolIntent;
  backend: 'openclaw';
  title: string;
  tier: PermissionTier;
  summary: string;
  command?: string;
  status: 'queued' | 'requires-approval' | 'approved';
}

export interface PerceptionRequest {
  source: 'screen' | 'window' | 'selection';
  detail: 'thumbnail' | 'full';
}

export interface PerceptionResult {
  source: string;
  capturedAt: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  note?: string;
}

export interface MemorySeedSource {
  kind: 'repo' | 'starred' | 'followed';
  id: string;
}

export interface MemorySyncJob {
  id: string;
  state: 'queued' | 'running' | 'ready' | 'error';
  createdAt: string;
  completedAt?: string;
  stores: string[];
  sources: MemorySeedSource[];
  summary: string;
  ingestedCount?: number;
  warnings?: string[];
  error?: string;
}

export interface CompanionMemoryEntry {
  store: 'operator-profile' | 'repo-codemap' | 'task-episodes' | 'companion-context';
  title: string;
  snippet: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryHit {
  store: string;
  title: string;
  snippet: string;
  source: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface AssistantTurn {
  id: string;
  role: 'assistant';
  content: string;
  createdAt: string;
}

export interface SpeechFrame {
  offsetMs: number;
  level: number;
  viseme: 'aa' | 'ee' | 'ih' | 'oh' | 'ou' | 'rest';
}

export interface SpeechTranscription {
  status: 'transcribed' | 'error' | 'unavailable';
  backend: string;
  text?: string;
  language?: string | null;
  durationMs?: number;
  note?: string;
  receivedBytes?: number;
  error?: string;
}

export interface SpeechSynthesisResult {
  status: 'executed' | 'error' | 'unavailable';
  backend: string;
  textLength: number;
  voice?: string;
  mimeType?: string;
  audioBase64?: string;
  sampleRate?: number;
  durationMs?: number;
  frames?: SpeechFrame[];
  note?: string;
  error?: string;
}

export interface ExecutionResult {
  status: 'planned' | 'blocked' | 'executed' | 'error';
  backend?: string;
  output?: string;
  outputData?: unknown;
  error?: string;
  requestId?: string;
}
