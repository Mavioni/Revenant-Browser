import fs from 'fs';
import path from 'path';
import { ExecutionResult, PermissionTier } from './lelu-types';

interface OpenClawToolInvocation {
  tool: string;
  action?: string;
  args?: Record<string, unknown>;
}

interface OpenClawChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class OpenClawGatewayClient {
  constructor(private readonly getConfig: () => any) {}

  async planTool(title: string, tier: PermissionTier, reason: string, command?: string): Promise<ExecutionResult> {
    return this.runAgentTurn('plan', title, tier, reason, command);
  }

  async executeTool(title: string, tier: PermissionTier, reason: string, command?: string): Promise<ExecutionResult> {
    const directInvocation = this.parseInvocation(command);
    if (directInvocation) {
      return this.invokeTool(directInvocation);
    }
    return this.runAgentTurn('execute', title, tier, reason, command);
  }

  private async runAgentTurn(
    mode: 'plan' | 'execute',
    title: string,
    tier: PermissionTier,
    reason: string,
    command?: string,
  ): Promise<ExecutionResult> {
    const endpoint = `${this.getBaseUrl()}/v1/chat/completions`;
    const headers = this.buildHeaders();
    const systemMessage = mode === 'plan'
      ? [
          'You are Lelu, the local operator companion running through an OpenClaw gateway.',
          'Return a concise execution plan only. Do not perform destructive actions.',
          'Prefer explicit steps, constraints, rollback notes, and the minimum scope needed.',
          `The host-side approval tier for this request is ${tier}. Respect that boundary in your plan.`,
        ].join(' ')
      : [
          'You are Lelu, the local operator companion running through an OpenClaw gateway.',
          'The host shell has already applied the approval gate for this request.',
          `You may operate within the ${tier} boundary that was approved by the operator.`,
          'Be concise, execute the requested task if tools are available, and summarize the result clearly.',
        ].join(' ');

    const userMessage = [
      `Title: ${title}`,
      `Reason: ${reason}`,
      command ? `Command or payload: ${command}` : 'Command or payload: none provided.',
    ].join('\n');

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          ...headers,
          'x-openclaw-message-channel': 'desktop-companion',
        },
        body: JSON.stringify({
          model: 'openclaw/default',
          user: 'lelu-desktop-tooling',
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemMessage },
            { role: 'user', content: userMessage },
          ],
        }),
      });

      if (!response.ok) {
        return {
          status: 'error',
          backend: 'openclaw',
          error: await this.describeGatewayError(response),
        };
      }

      const data = await response.json() as OpenClawChatResponse;
      const content = data.choices?.[0]?.message?.content?.trim();

      return {
        status: 'executed',
        backend: 'openclaw',
        output: content || JSON.stringify(data),
        outputData: data,
      };
    } catch (error) {
      return {
        status: 'error',
        backend: 'openclaw',
        error: error instanceof Error ? error.message : 'OpenClaw gateway request failed.',
      };
    }
  }

  private async invokeTool(invocation: OpenClawToolInvocation): Promise<ExecutionResult> {
    const endpoint = `${this.getBaseUrl()}/tools/invoke`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          tool: invocation.tool,
          action: invocation.action || 'json',
          args: invocation.args || {},
        }),
      });

      if (!response.ok) {
        return {
          status: 'error',
          backend: 'openclaw',
          error: await this.describeGatewayError(response),
        };
      }

      const data = await response.json() as Record<string, unknown>;
      const result = Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : data;

      return {
        status: 'executed',
        backend: 'openclaw',
        output: typeof result === 'string' ? result : JSON.stringify(result),
        outputData: result,
      };
    } catch (error) {
      return {
        status: 'error',
        backend: 'openclaw',
        error: error instanceof Error ? error.message : 'OpenClaw tool invocation failed.',
      };
    }
  }

  private parseInvocation(command?: string): OpenClawToolInvocation | null {
    if (!command) return null;
    const trimmed = command.trim();
    if (!trimmed.startsWith('{')) return null;

    try {
      const parsed = JSON.parse(trimmed) as OpenClawToolInvocation;
      if (!parsed || typeof parsed.tool !== 'string' || !parsed.tool.trim()) return null;
      return {
        tool: parsed.tool.trim(),
        action: typeof parsed.action === 'string' && parsed.action.trim() ? parsed.action.trim() : 'json',
        args: parsed.args && typeof parsed.args === 'object' ? parsed.args : {},
      };
    } catch {
      return null;
    }
  }

  private getBaseUrl(): string {
    const configured = String(this.getConfig().leluOpenClawEndpoint || '').trim();
    return configured || 'http://127.0.0.1:18789';
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'RevenantBrowser-Lelu/1.0',
    };

    const token = this.getGatewayToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }

  private getGatewayToken(): string {
    const fromEnv = String(process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
    if (fromEnv) return fromEnv;

    const runtimeRoot = String(this.getConfig().leluRuntimeRoot || '').trim();
    if (!runtimeRoot) return '';

    const envPath = path.join(runtimeRoot, 'config', '.env');
    if (!fs.existsSync(envPath)) return '';

    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [key, ...valueParts] = trimmed.split('=');
        if (key === 'OPENCLAW_GATEWAY_TOKEN') {
          return valueParts.join('=').trim().replace(/^['"]|['"]$/g, '');
        }
      }
    } catch {
      return '';
    }

    return '';
  }

  private async describeGatewayError(response: Response): Promise<string> {
    if (response.status === 401) {
      return 'OpenClaw rejected the request. Verify OPENCLAW_GATEWAY_TOKEN in the runtime config/.env or set it in the current environment.';
    }
    if (response.status === 404) {
      return 'OpenClaw HTTP endpoint is unavailable. Enable gateway.http.endpoints.chatCompletions.enabled and restart the gateway.';
    }

    try {
      const text = await response.text();
      if (text.trim()) return `OpenClaw responded with HTTP ${response.status}: ${text.trim()}`;
    } catch {
      // Fall through to status text.
    }

    return `OpenClaw responded with HTTP ${response.status}.`;
  }
}
