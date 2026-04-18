import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  CompanionEvent,
  ExecutionResult,
  GrantPolicy,
  MemorySeedSource,
  MemorySyncJob,
  PermissionTier,
  ToolGrantDecision,
  ToolGrantRequest,
  ToolIntent,
  ToolPlan,
} from './lelu-types';

const DEFAULT_GRANT_POLICY: Record<PermissionTier, GrantPolicy> = {
  observe: 'auto',
  draft: 'auto',
  'workspace-mutate': 'confirm',
  'system-mutate': 'hard-confirm',
  'external-act': 'hard-confirm',
};

export class CompanionStore {
  private readonly leluDir: string;
  private readonly auditLogPath: string;
  private readonly jobsPath: string;
  private readonly pending = new Map<string, ToolGrantRequest>();
  private jobs: MemorySyncJob[] = [];
  private readonly grantListeners: Array<(event: CompanionEvent<ToolGrantRequest>) => void> = [];
  private readonly decisionListeners: Array<(event: CompanionEvent<ToolGrantDecision>) => void> = [];

  constructor(dataDir: string) {
    this.leluDir = path.join(dataDir, 'lelu');
    this.auditLogPath = path.join(this.leluDir, 'audit.jsonl');
    this.jobsPath = path.join(this.leluDir, 'memory-sync-jobs.json');

    fs.mkdirSync(this.leluDir, { recursive: true });
    this.jobs = this.loadJobs();
  }

  getGrantPolicy(): Record<PermissionTier, GrantPolicy> {
    return { ...DEFAULT_GRANT_POLICY };
  }

  onGrantRequest(callback: (event: CompanionEvent<ToolGrantRequest>) => void): void {
    this.grantListeners.push(callback);
  }

  onGrantDecision(callback: (event: CompanionEvent<ToolGrantDecision>) => void): void {
    this.decisionListeners.push(callback);
  }

  getPendingRequest(requestId: string): ToolGrantRequest | null {
    return this.pending.get(requestId) || null;
  }

  listPendingRequests(): ToolGrantRequest[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  createToolPlan(
    intent: ToolIntent,
    title: string,
    tier: PermissionTier,
    reason: string,
    command?: string,
    backend: 'openclaw' = 'openclaw',
  ): ToolPlan {
    const policy = DEFAULT_GRANT_POLICY[tier];
    const plan: ToolPlan = {
      id: crypto.randomUUID(),
      intent,
      backend,
      title,
      tier,
      summary: reason,
      command,
      status: policy === 'auto' ? 'approved' : 'requires-approval',
    };

    this.log('tool.plan', plan);
    return plan;
  }

  requestGrant(
    intent: ToolIntent,
    title: string,
    tier: PermissionTier,
    reason: string,
    command?: string,
    backend: 'openclaw' = 'openclaw',
  ): {
    status: 'auto-approved' | 'pending';
    request: ToolGrantRequest;
    decision?: ToolGrantDecision;
  } {
    const request: ToolGrantRequest = {
      id: crypto.randomUUID(),
      intent,
      backend,
      title,
      tier,
      reason,
      command,
      policy: DEFAULT_GRANT_POLICY[tier],
      createdAt: new Date().toISOString(),
    };

    if (request.policy === 'auto') {
      const decision: ToolGrantDecision = {
        requestId: request.id,
        tier,
        decision: 'approved',
        decidedAt: new Date().toISOString(),
        note: 'Trusted Operator auto-approved tier.',
      };
      this.log('tool.grant.auto', { request, decision });
      this.emitDecision(decision);
      return { status: 'auto-approved', request, decision };
    }

    this.pending.set(request.id, request);
    this.log('tool.grant.pending', request);
    this.emitGrant(request);
    return { status: 'pending', request };
  }

  decideGrant(requestId: string, approved: boolean, note = ''): ToolGrantDecision | null {
    const request = this.pending.get(requestId);
    if (!request) return null;

    this.pending.delete(requestId);

    const decision: ToolGrantDecision = {
      requestId,
      tier: request.tier,
      decision: approved ? 'approved' : 'denied',
      decidedAt: new Date().toISOString(),
      note,
    };

    this.log('tool.grant.decision', { request, decision });
    this.emitDecision(decision);
    return decision;
  }

  recordExecution(request: ToolGrantRequest, result: ExecutionResult): void {
    this.log('tool.execution', { request, result });
  }

  createMemorySyncJob(mode: 'curated-core' | 'curated-expanded' = 'curated-core'): MemorySyncJob {
    const sources: MemorySeedSource[] = [
      { kind: 'repo', id: 'Mavioni/Revenant-Browser' },
      { kind: 'repo', id: 'Mavioni/NeuralClaw' },
      { kind: 'repo', id: 'Mavioni/trit-trt' },
      { kind: 'repo', id: 'Mavioni/HappyPair' },
      { kind: 'repo', id: 'Mavioni/Searchbud' },
      { kind: 'repo', id: 'Mavioni/parakeet-crypto' },
    ];

    if (mode === 'curated-expanded') {
      sources.push(
        { kind: 'starred', id: 'selected-stars' },
        { kind: 'followed', id: 'selected-follows' },
      );
    }

    const job: MemorySyncJob = {
      id: crypto.randomUUID(),
      state: 'queued',
      createdAt: new Date().toISOString(),
      stores: ['operator-profile', 'repo-codemap', 'task-episodes', 'companion-context'],
      sources,
      summary:
        mode === 'curated-core'
          ? 'Seed Lelu memory from the core private-operating repos and workspace context.'
          : 'Seed Lelu memory from the core repos plus selected GitHub stars and follows.',
      warnings: [],
    };

    this.jobs = [job, ...this.jobs].slice(0, 25);
    this.persistJobs();
    this.log('memory.sync.queued', job);
    return job;
  }

  markMemorySyncRunning(jobId: string): MemorySyncJob | null {
    return this.updateJob(jobId, (job) => ({
      ...job,
      state: 'running',
      warnings: job.warnings || [],
    }), 'memory.sync.running');
  }

  completeMemorySyncJob(jobId: string, ingestedCount: number, warnings: string[] = []): MemorySyncJob | null {
    return this.updateJob(jobId, (job) => ({
      ...job,
      state: 'ready',
      completedAt: new Date().toISOString(),
      ingestedCount,
      warnings,
      error: undefined,
    }), 'memory.sync.ready');
  }

  failMemorySyncJob(jobId: string, error: string): MemorySyncJob | null {
    return this.updateJob(jobId, (job) => ({
      ...job,
      state: 'error',
      completedAt: new Date().toISOString(),
      error,
    }), 'memory.sync.error');
  }

  listMemorySyncJobs(): MemorySyncJob[] {
    return [...this.jobs];
  }

  private updateJob(
    jobId: string,
    updater: (job: MemorySyncJob) => MemorySyncJob,
    logType: string,
  ): MemorySyncJob | null {
    const index = this.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) return null;

    const updated = updater(this.jobs[index]);
    this.jobs[index] = updated;
    this.persistJobs();
    this.log(logType, updated);
    return updated;
  }

  private loadJobs(): MemorySyncJob[] {
    try {
      if (!fs.existsSync(this.jobsPath)) return [];
      const raw = fs.readFileSync(this.jobsPath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private persistJobs(): void {
    fs.writeFileSync(this.jobsPath, JSON.stringify(this.jobs, null, 2));
  }

  private emitGrant(request: ToolGrantRequest): void {
    const event: CompanionEvent<ToolGrantRequest> = {
      type: 'tool.grant.pending',
      at: new Date().toISOString(),
      payload: request,
    };
    for (const listener of this.grantListeners) listener(event);
  }

  private emitDecision(decision: ToolGrantDecision): void {
    const event: CompanionEvent<ToolGrantDecision> = {
      type: 'tool.grant.decision',
      at: new Date().toISOString(),
      payload: decision,
    };
    for (const listener of this.decisionListeners) listener(event);
  }

  private log(type: string, payload: unknown): void {
    const entry = JSON.stringify({ type, at: new Date().toISOString(), payload });
    fs.appendFileSync(this.auditLogPath, entry + '\n');
  }
}
