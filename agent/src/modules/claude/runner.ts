import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { userPath } from '../../util/exec.ts';
import { logger } from '../../util/log.ts';

function resolveClaudeBin(): string {
  const candidates = [join(homedir(), '.local/bin/claude'), '/usr/local/bin/claude'];
  return candidates.find((path) => existsSync(path)) ?? 'claude';
}

const log = logger('claude/runner');

/**
 * Startet Claude-Code-Aufgaben im Hintergrund.
 *
 * Aufrufform: claude -p "<prompt>" --output-format stream-json --verbose
 * Die Ausgabe besteht aus einer JSON-Zeile je Ereignis und wird unverändert
 * an verbundene Clients weitergereicht.
 *
 * Über --session-id wird die Sitzungskennung vorgegeben, damit sich das
 * zugehörige Protokoll später eindeutig zuordnen lässt.
 */

export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export type Task = {
  id: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  status: TaskStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  /** Gesammelte Ereignisse, damit ein später verbundener Client aufholen kann. */
  events: unknown[];
  resultText: string | null;
  error: string | null;
};

export type PermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

const MAX_BUFFERED_EVENTS = 500;
const MAX_TASKS = 50;

class TaskRegistry extends EventEmitter {
  private tasks = new Map<string, Task>();
  // stdin ist bewusst geschlossen – die Aufgabe läuft ohne Rückfragen über stdin.
  private processes = new Map<string, ChildProcessByStdio<null, Readable, Readable>>();

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): Task | null {
    return this.tasks.get(id) ?? null;
  }

  /** Ältere abgeschlossene Aufgaben verwerfen, damit der Speicher nicht wächst. */
  private prune() {
    const finished = this.list().filter((t) => t.status !== 'running');
    for (const task of finished.slice(MAX_TASKS)) {
      this.tasks.delete(task.id);
    }
  }

  start(options: { prompt: string; cwd?: string; permissionMode?: PermissionMode; resumeSessionId?: string }): Task {
    const cwd = options.cwd ?? homedir();
    if (!existsSync(cwd)) throw new Error(`Arbeitsverzeichnis existiert nicht: ${cwd}`);
    if (!options.prompt.trim()) throw new Error('Der Prompt darf nicht leer sein');

    const id = randomUUID();
    const sessionId = options.resumeSessionId ?? randomUUID();

    const args = ['-p', options.prompt, '--output-format', 'stream-json', '--verbose'];

    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    // Ohne ausdrückliche Angabe werden Dateiänderungen angenommen, aber keine
    // Berechtigungen umgangen – heikle Aufrufe laufen weiter über den Hook.
    args.push('--permission-mode', options.permissionMode ?? 'acceptEdits');

    const task: Task = {
      id,
      sessionId,
      prompt: options.prompt,
      cwd,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      events: [],
      resultText: null,
      error: null,
    };

    this.tasks.set(id, task);
    this.prune();

    const child = spawn(resolveClaudeBin(), args, {
      cwd,
      env: { ...process.env, PATH: userPath(), CLAUDE_CODE_ENTRYPOINT: 'pcctl' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.processes.set(id, child);
    log.info(`Aufgabe ${id.slice(0, 8)} gestartet in ${cwd}`);

    let stdoutBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        // Das Abschlussereignis trägt den Ergebnistext.
        if (event['type'] === 'result' && typeof event['result'] === 'string') {
          task.resultText = event['result'];
        }

        task.events.push(event);
        if (task.events.length > MAX_BUFFERED_EVENTS) task.events.shift();
        this.emit('event', { taskId: id, event });
      }
    });

    let stderrText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
      if (stderrText.length > 8000) stderrText = stderrText.slice(-8000);
    });

    child.on('error', (err) => {
      task.status = 'failed';
      task.error = err.message;
      task.endedAt = Date.now();
      this.processes.delete(id);
      log.error(`Aufgabe ${id.slice(0, 8)} konnte nicht starten: ${err.message}`);
      this.emit('status', task);
    });

    child.on('close', (code) => {
      this.processes.delete(id);
      task.exitCode = code;
      task.endedAt = Date.now();

      if (task.status === 'cancelled') {
        // Status bleibt bestehen.
      } else if (code === 0) {
        task.status = 'done';
      } else {
        task.status = 'failed';
        task.error = stderrText.trim().split('\n').slice(-3).join(' ') || `Beendet mit Code ${code}`;
      }

      log.info(`Aufgabe ${id.slice(0, 8)} ${task.status} (Code ${code})`);
      this.emit('status', task);
    });

    return task;
  }

  cancel(id: string): boolean {
    const child = this.processes.get(id);
    const task = this.tasks.get(id);
    if (!child || !task) return false;

    task.status = 'cancelled';
    child.kill('SIGTERM');
    // Falls der Prozess nicht reagiert, nach kurzer Frist nachhelfen.
    setTimeout(() => {
      if (this.processes.has(id)) child.kill('SIGKILL');
    }, 3000);

    log.info(`Aufgabe ${id.slice(0, 8)} abgebrochen`);
    return true;
  }

  runningCount(): number {
    return this.processes.size;
  }
}

export const tasks = new TaskRegistry();
