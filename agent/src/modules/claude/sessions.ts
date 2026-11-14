import {
  readdirSync,
  statSync,
  existsSync,
  createReadStream,
  watch,
  openSync,
  readSync,
  closeSync,
  type FSWatcher,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { logger } from '../../util/log.ts';

const log = logger('claude/sessions');

/**
 * Liest Sitzungsprotokolle von Claude Code und Cursor mit.
 *
 * Claude Code: ~/.claude/projects/<kodierter-pfad>/<session-id>.jsonl
 * Cursor:      ~/.cursor/projects/<kodierter-pfad>/agent-transcripts/<id>/<id>.jsonl
 *
 * Relevante Typen sind "user" und "assistant" (jeweils mit message.content).
 */

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CURSOR_PROJECTS_DIR = join(homedir(), '.cursor', 'projects');

export type SessionSummary = {
  id: string;
  project: string;
  projectPath: string;
  title: string | null;
  lastActivity: number;
  sizeBytes: number;
  messageCount: number | null;
};

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; name: string; input: unknown; id: string }
  | { type: 'tool_result'; content: unknown; tool_use_id: string }
  | { type: string; [key: string]: unknown };

export type SessionEvent = {
  uuid: string;
  type: 'user' | 'assistant';
  role: string;
  timestamp: number;
  blocks: ContentBlock[];
  model: string | null;
};

/** Der Verzeichnisname kodiert den Projektpfad: /run/media/x → -run-media-x */
function decodeProjectName(dirName: string): string {
  const withSlash = dirName.startsWith('-') ? dirName : `-${dirName}`;
  return withSlash.replace(/^-/, '/').replace(/-/g, '/');
}

function sessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

/** Liest den Titel aus den letzten Zeilen, ohne die ganze Datei zu laden. */
function readTitle(filePath: string): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(filePath).size;
    const tailBytes = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(tailBytes);

    // Gezielt nur das Dateiende lesen – Protokolle werden mehrere MB groß.
    fd = openSync(filePath, 'r');
    readSync(fd, buffer, 0, tailBytes, size - tailBytes);

    const lines = buffer.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (line.includes('"ai-title"')) {
        try {
          const parsed = JSON.parse(line) as { type?: string; aiTitle?: string };
          if (parsed.type === 'ai-title' && parsed.aiTitle) return parsed.aiTitle;
        } catch {
          /* unvollständige Zeile am Pufferrand */
        }
      }
      const query = line.match(/<user_query>\\n?([\s\S]*?)\\n?<\/user_query>/) ?? line.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
      if (query?.[1]) return query[1].replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  } catch {
    /* Datei nicht lesbar */
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return null;
}

function collectClaudeSessions(): SessionSummary[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const sessions: SessionSummary[] = [];

  for (const projectDir of readdirSync(PROJECTS_DIR)) {
    const fullDir = join(PROJECTS_DIR, projectDir);
    try {
      if (!statSync(fullDir).isDirectory()) continue;
    } catch {
      continue;
    }

    for (const file of sessionFiles(fullDir)) {
      const filePath = join(fullDir, file);
      try {
        const stat = statSync(filePath);
        sessions.push({
          id: basename(file, '.jsonl'),
          project: decodeProjectName(projectDir),
          projectPath: filePath,
          title: null,
          lastActivity: stat.mtimeMs,
          sizeBytes: stat.size,
          messageCount: null,
        });
      } catch {
        /* Datei verschwunden */
      }
    }
  }

  return sessions;
}

/** Cursor legt je Chat eine Datei unter agent-transcripts/<id>/<id>.jsonl ab. */
function collectCursorSessions(): SessionSummary[] {
  if (!existsSync(CURSOR_PROJECTS_DIR)) return [];
  const sessions: SessionSummary[] = [];

  for (const projectDir of readdirSync(CURSOR_PROJECTS_DIR)) {
    const transcriptsDir = join(CURSOR_PROJECTS_DIR, projectDir, 'agent-transcripts');
    try {
      if (!statSync(transcriptsDir).isDirectory()) continue;
    } catch {
      continue;
    }

    for (const sessionDir of readdirSync(transcriptsDir)) {
      if (sessionDir === 'subagents') continue;
      const filePath = join(transcriptsDir, sessionDir, `${sessionDir}.jsonl`);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        sessions.push({
          id: sessionDir,
          project: decodeProjectName(projectDir),
          projectPath: filePath,
          title: null,
          lastActivity: stat.mtimeMs,
          sizeBytes: stat.size,
          messageCount: null,
        });
      } catch {
        /* Datei fehlt oder Unteragent */
      }
    }
  }

  return sessions;
}

export function listSessions(limit = 25): SessionSummary[] {
  const sessions = [...collectClaudeSessions(), ...collectCursorSessions()];

  // Titel nur für die tatsächlich zurückgegebenen Sitzungen ermitteln – das
  // Lesen kostet I/O und lohnt sich nicht für hunderte alte Protokolle.
  return sessions
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, limit)
    .map((session) => ({ ...session, title: readTitle(session.projectPath) }));
}

export function findSession(id: string): SessionSummary | null {
  return listSessions(500).find((s) => s.id === id) ?? null;
}

function parseEvent(line: string): SessionEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = raw['type'] ?? raw['role'];
  if (type !== 'user' && type !== 'assistant') return null;

  const message = raw['message'] as { role?: string; content?: unknown; model?: string } | undefined;
  if (!message) return null;

  // Nutzer-Nachrichten sind teils reiner Text, teils Blocklisten.
  const content = message.content;
  const blocks: ContentBlock[] = Array.isArray(content)
    ? (content as ContentBlock[])
    : typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : [];

  return {
    uuid: String(raw['uuid'] ?? '') || createHash('sha1').update(line).digest('hex').slice(0, 16),
    type,
    role: message.role ?? type,
    timestamp: raw['timestamp'] ? Date.parse(String(raw['timestamp'])) : 0,
    blocks,
    model: message.model ?? null,
  };
}

/** Liest den Verlauf einer Sitzung, standardmäßig nur die letzten Einträge. */
export async function readHistory(sessionId: string, limit = 50): Promise<SessionEvent[]> {
  const session = findSession(sessionId);
  if (!session) throw new Error(`Sitzung ${sessionId} nicht gefunden`);

  const events: SessionEvent[] = [];
  const stream = createReadStream(session.projectPath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    const event = parseEvent(line);
    if (event) {
      if (!event.uuid) event.uuid = `${sessionId}:${events.length}`;
      events.push(event);
    }
  }

  return limit > 0 ? events.slice(-limit) : events;
}

/**
 * Verfolgt eine Sitzungsdatei und meldet neue Ereignisse.
 *
 * fs.watch meldet Änderungen, gelesen wird jeweils nur der neu angehängte
 * Teil ab der zuletzt bekannten Position.
 */
export class SessionTail extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private position = 0;
  private buffer = '';
  private reading = false;
  private readonly filePath: string;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  start(fromBeginning = false) {
    try {
      this.position = fromBeginning ? 0 : statSync(this.filePath).size;
    } catch (err) {
      this.emit('error', new Error(`Sitzungsdatei nicht lesbar: ${(err as Error).message}`));
      return;
    }

    this.watcher = watch(this.filePath, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') void this.drain();
    });

    if (fromBeginning) void this.drain();
    log.debug(`Verfolge ${basename(this.filePath)} ab Position ${this.position}`);
  }

  /** Liest alles, was seit der letzten Position dazugekommen ist. */
  private async drain() {
    if (this.reading) return;
    this.reading = true;

    try {
      const size = statSync(this.filePath).size;
      // Bei Rotation/Kürzung von vorn beginnen.
      if (size < this.position) this.position = 0;
      if (size === this.position) return;

      const stream = createReadStream(this.filePath, {
        start: this.position,
        end: size - 1,
        encoding: 'utf8',
      });

      for await (const chunk of stream) {
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        // Die letzte Zeile kann unvollständig sein und wartet auf den Rest.
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = parseEvent(line);
          if (event) this.emit('event', event);
        }
      }

      this.position = size;
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.reading = false;
    }
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    this.removeAllListeners();
  }
}

/** Ermittelt die zuletzt aktive Sitzung – meist die, die gerade läuft. */
export function mostRecentSession(): SessionSummary | null {
  return listSessions(1)[0] ?? null;
}
