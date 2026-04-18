import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { SpeechSynthesisResult, SpeechTranscription } from './lelu-types';

interface PendingWorkerRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerEnvelope {
  id?: string;
  action?: string;
  payload?: any;
  error?: string;
}

export class SpeechService {
  private worker: ChildProcess | null = null;
  private workerLines: readline.Interface | null = null;
  private readonly pending = new Map<string, PendingWorkerRequest>();
  private nextRequestId = 0;

  constructor(
    private readonly pythonDir: string,
    private readonly getConfig: () => any,
  ) {}

  async transcribe(payload: unknown): Promise<SpeechTranscription> {
    try {
      return await this.sendRequest<SpeechTranscription>('transcribe', {
        model: this.getConfig().leluAsrModel,
        payload,
      }, 240000);
    } catch (error) {
      return {
        status: 'error',
        backend: String(this.getConfig().leluAsrModel || 'whisper'),
        error: error instanceof Error ? error.message : 'Transcription worker failed.',
      };
    }
  }

  async synthesize(text: string, options: Record<string, unknown> = {}): Promise<SpeechSynthesisResult> {
    try {
      return await this.sendRequest<SpeechSynthesisResult>('synthesize', {
        backend: this.getConfig().leluTtsBackend,
        text,
        options: {
          voice: this.getConfig().leluSpeechVoice || 'af_heart',
          speed: 1,
          ...options,
        },
      }, 240000);
    } catch (error) {
      return {
        status: 'error',
        backend: String(this.getConfig().leluTtsBackend || 'kokoro'),
        textLength: text.length,
        error: error instanceof Error ? error.message : 'Speech worker failed.',
      };
    }
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Speech service stopped.'));
    }
    this.pending.clear();

    this.workerLines?.close();
    this.workerLines = null;

    if (this.worker) {
      try {
        this.worker.kill();
      } catch {
        // Worker is already gone.
      }
      this.worker = null;
    }
  }

  private resolvePythonExecutable(): string {
    const venvPython = process.platform === 'win32'
      ? path.join(this.pythonDir, '.venv', 'Scripts', 'python.exe')
      : path.join(this.pythonDir, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPython)) return venvPython;
    return 'python';
  }

  private ensureWorker(): void {
    if (this.worker && !this.worker.killed) return;

    const workerPath = path.join(this.pythonDir, 'lelu_speech_worker.py');
    const pythonExecutable = this.resolvePythonExecutable();
    // Pass a minimal env allowlist — never forward the full process.env, which
    // can contain secrets (OPENCLAW_GATEWAY_TOKEN, API keys, etc.).
    const scopedEnv: Record<string, string> = {
      HF_HUB_DISABLE_TELEMETRY: '1',
      PYTHONIOENCODING: 'utf-8',
    };
    const hostPath = process.env.PATH || process.env.Path || process.env.path;
    if (hostPath) scopedEnv.PATH = hostPath;
    for (const k of ['SYSTEMROOT','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP','HOME','HF_HOME','TRANSFORMERS_CACHE','TORCH_HOME']) {
      const v = process.env[k];
      if (v) scopedEnv[k] = v;
    }

    const worker = spawn(pythonExecutable, [workerPath], {
      cwd: this.pythonDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: scopedEnv,
    });

    worker.stderr?.on('data', (chunk: Buffer) => {
      console.warn('[lelu-speech]', chunk.toString().trim());
    });

    worker.on('exit', () => {
      this.worker = null;
      this.workerLines?.close();
      this.workerLines = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Speech worker exited before responding.'));
      }
      this.pending.clear();
    });

    this.workerLines = readline.createInterface({ input: worker.stdout! });
    this.workerLines.on('line', (line) => this.handleWorkerLine(line));
    this.worker = worker;
  }

  private handleWorkerLine(line: string): void {
    if (!line.trim()) return;

    let envelope: WorkerEnvelope;
    try {
      envelope = JSON.parse(line) as WorkerEnvelope;
    } catch (error) {
      console.warn('[lelu-speech] Failed to parse worker payload:', error);
      return;
    }

    if (!envelope.id) return;
    const pending = this.pending.get(envelope.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(envelope.id);

    if (envelope.error) {
      pending.reject(new Error(envelope.error));
      return;
    }

    pending.resolve(envelope.payload);
  }

  private sendRequest<T>(action: string, payload: any, timeoutMs: number): Promise<T> {
    this.ensureWorker();

    if (!this.worker?.stdin) {
      return Promise.reject(new Error('Speech worker stdin is unavailable.'));
    }

    const id = `speech-${Date.now()}-${++this.nextRequestId}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${action} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.worker?.stdin?.write(`${JSON.stringify({ id, action, payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Failed to send worker request.'));
      }
    });
  }
}
