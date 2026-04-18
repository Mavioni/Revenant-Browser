import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { execFileSync } from 'child_process';
import { RuntimeHealth, RuntimeServiceHealth, SessionState } from './lelu-types';

interface ServiceProbeSpec {
  key: string;
  label: string;
  port: number;
  path: string;
}

const SERVICE_SPECS: ServiceProbeSpec[] = [
  { key: 'trit-trt', label: 'TRIT-TRT', port: 8765, path: '/health' },
  { key: 'ollama', label: 'Ollama', port: 11434, path: '/api/tags' },
  { key: 'openclaw', label: 'OpenClaw', port: 18789, path: '/health' },
  { key: 'hippocampus', label: 'ChromaDB', port: 8000, path: '/api/v2/heartbeat' },
];

export class RuntimeSupervisor {
  private state: SessionState = 'stopped';
  private lastError = '';
  private startedBySupervisor = false;
  private healthListeners: Array<(health: RuntimeHealth) => void> = [];

  constructor(private readonly getConfig: () => any) {}

  onHealthChanged(callback: (health: RuntimeHealth) => void): void {
    this.healthListeners.push(callback);
  }

  async sessionStart(): Promise<RuntimeHealth> {
    this.state = 'starting';
    this.lastError = '';
    this.emitHealth(await this.getHealth());

    const runtimeRoot = this.getRuntimeRoot();
    const composePath = this.getComposePath();

    if (!fs.existsSync(runtimeRoot)) {
      this.state = 'error';
      this.lastError = `Runtime root not found: ${runtimeRoot}`;
      return this.emitAndReturn();
    }

    if (!fs.existsSync(composePath)) {
      this.state = 'error';
      this.lastError = `Compose file not found: ${composePath}`;
      return this.emitAndReturn();
    }

    try {
      execFileSync('docker', ['compose', '-f', composePath, 'up', '-d'], {
        cwd: runtimeRoot,
        stdio: 'ignore',
        windowsHide: true,
      });
      this.startedBySupervisor = true;
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : 'Failed to start docker compose.';
      return this.emitAndReturn();
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const health = await this.getHealth();
      this.emitHealth(health);
      if (health.state === 'ready') return health;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    this.state = 'error';
    this.lastError = 'Core services did not become ready before the startup timeout expired.';
    return this.emitAndReturn();
  }

  async sessionResume(): Promise<RuntimeHealth> {
    const health = await this.getHealth();
    if (health.state === 'ready' || health.services.some((service) => service.status !== 'unreachable')) {
      this.state = health.state;
      return this.emitAndReturn();
    }
    return this.sessionStart();
  }

  async sessionStop(): Promise<RuntimeHealth> {
    const runtimeRoot = this.getRuntimeRoot();
    const composePath = this.getComposePath();

    if (this.startedBySupervisor && fs.existsSync(runtimeRoot) && fs.existsSync(composePath)) {
      try {
        execFileSync('docker', ['compose', '-f', composePath, 'down'], {
          cwd: runtimeRoot,
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to stop docker compose.';
      }
    }

    this.state = 'stopped';
    this.startedBySupervisor = false;
    return this.emitAndReturn();
  }

  async getHealth(): Promise<RuntimeHealth> {
    const services = await Promise.all(SERVICE_SPECS.map((spec) => this.probeService(spec)));
    const nextState = this.deriveState(services);
    this.state = nextState;

    return {
      state: nextState,
      startedBySupervisor: this.startedBySupervisor,
      rootPath: this.getRuntimeRoot(),
      composeFile: this.getComposePath(),
      remoteOptIn: Boolean(this.getConfig().leluRemoteOptIn),
      updatedAt: new Date().toISOString(),
      services,
      lastError: this.lastError || undefined,
    };
  }

  private deriveState(services: RuntimeServiceHealth[]): SessionState {
    const reachable = services.filter((service) => service.status !== 'unreachable');
    const inferenceReachable = services.some(
      (service) => ['trit-trt', 'ollama'].includes(service.key) && service.status !== 'unreachable',
    );
    const gatewayReachable = services.some(
      (service) => service.key === 'openclaw' && service.status !== 'unreachable',
    );

    if (inferenceReachable && gatewayReachable) return 'ready';
    if (reachable.length > 0) return 'starting';
    if (this.state === 'starting' || this.lastError) return 'error';
    return 'stopped';
  }

  private async probeService(spec: ServiceProbeSpec): Promise<RuntimeServiceHealth> {
    return new Promise((resolve) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: spec.port,
          path: spec.path,
          method: 'GET',
          timeout: 1200,
        },
        (response) => {
          response.resume();
          const status = response.statusCode ?? 0;
          if (status === 401 || status === 403) {
            resolve({
              key: spec.key,
              label: spec.label,
              port: spec.port,
              url: `http://127.0.0.1:${spec.port}${spec.path}`,
              status: 'auth-required',
              detail: `HTTP ${status}`,
            });
            return;
          }

          resolve({
            key: spec.key,
            label: spec.label,
            port: spec.port,
            url: `http://127.0.0.1:${spec.port}${spec.path}`,
            status: status > 0 && status < 500 ? 'healthy' : 'unreachable',
            detail: status > 0 ? `HTTP ${status}` : 'No response',
          });
        },
      );

      request.on('timeout', () => {
        request.destroy(new Error('timeout'));
      });

      request.on('error', (error) => {
        resolve({
          key: spec.key,
          label: spec.label,
          port: spec.port,
          url: `http://127.0.0.1:${spec.port}${spec.path}`,
          status: 'unreachable',
          detail: error.message,
        });
      });

      request.end();
    });
  }

  private emitHealth(health: RuntimeHealth): void {
    for (const listener of this.healthListeners) listener(health);
  }

  private async emitAndReturn(): Promise<RuntimeHealth> {
    const health = await this.getHealth();
    this.emitHealth(health);
    return health;
  }

  private getRuntimeRoot(): string {
    const configuredRoot = String(this.getConfig().leluRuntimeRoot || '').trim();
    if (configuredRoot) return configuredRoot;
    return path.join(os.homedir(), 'NeuralClaw');
  }

  private getComposePath(): string {
    const fileName = String(this.getConfig().leluComposeFile || 'docker-compose.yml').trim() || 'docker-compose.yml';
    return path.join(this.getRuntimeRoot(), fileName);
  }
}
