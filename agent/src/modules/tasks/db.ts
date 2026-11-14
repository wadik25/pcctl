import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../../config.ts';
import { logger } from '../../util/log.ts';
import type {
  InboxMessage,
  InboxTask,
  MessageKind,
  PendingEval,
  SuggestedSlot,
  TaskPriority,
  TaskStatus,
  TaskStep,
} from './types.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const log = logger('tasks/db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  body TEXT,
  transcript TEXT,
  audio_path TEXT,
  duration_seconds INTEGER,
  received_at INTEGER NOT NULL,
  evaluated_at INTEGER,
  is_task INTEGER,
  confidence REAL,
  llm_raw TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  llm_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_pending
  ON messages (evaluated_at, chat_jid, received_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id),
  title TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  estimated_minutes INTEGER NOT NULL DEFAULT 15,
  suggested_slot TEXT NOT NULL DEFAULT 'GEPLANT_SPAETER',
  can_use_ai INTEGER NOT NULL DEFAULT 0,
  recommended_tool TEXT NOT NULL DEFAULT 'Manuell',
  workflow_hint TEXT NOT NULL DEFAULT '',
  is_voice_message INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'inbox',
  snoozed_until INTEGER,
  elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  sender_name TEXT,
  chat_jid TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, created_at DESC);

CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  seconds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let cached: InstanceType<typeof Database> | null = null;

export function dbPath(): string {
  return join(DATA_DIR, 'tasks.db');
}

export function getDb(): InstanceType<typeof Database> {
  if (cached) return cached;
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  cached = db;
  log.info(`Datenbank bereit: ${dbPath()}`);
  return db;
}

type MessageRow = {
  id: string;
  chat_jid: string;
  sender_name: string;
  kind: string;
  body: string | null;
  transcript: string | null;
  audio_path: string | null;
  duration_seconds: number | null;
  received_at: number;
  evaluated_at: number | null;
  is_task: number | null;
  confidence: number | null;
  llm_raw: string | null;
  retry_count: number;
  last_attempt_at: number | null;
  llm_error: string | null;
};

type TaskRow = {
  id: string;
  message_id: string | null;
  title: string;
  context: string;
  priority: string;
  estimated_minutes: number;
  suggested_slot: string;
  can_use_ai: number;
  recommended_tool: string;
  workflow_hint: string;
  is_voice_message: number;
  status: string;
  snoozed_until: number | null;
  elapsed_seconds: number;
  sender_name: string | null;
  chat_jid: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
};

type StepRow = {
  id: string;
  task_id: string;
  title: string;
  done: number;
  position: number;
};

function mapMessage(row: MessageRow): InboxMessage {
  return {
    id: row.id,
    chatJid: row.chat_jid,
    senderName: row.sender_name,
    kind: row.kind as MessageKind,
    body: row.body,
    transcript: row.transcript,
    audioPath: row.audio_path,
    durationSeconds: row.duration_seconds,
    receivedAt: row.received_at,
    evaluatedAt: row.evaluated_at,
    isTask: row.is_task === null ? null : row.is_task === 1,
    confidence: row.confidence,
    llmRaw: row.llm_raw,
    retryCount: row.retry_count,
    lastAttemptAt: row.last_attempt_at,
    llmError: row.llm_error,
  };
}

function mapStep(row: StepRow): TaskStep {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    done: row.done === 1,
    position: row.position,
  };
}

function mapTask(row: TaskRow, steps: TaskStep[]): InboxTask {
  return {
    id: row.id,
    messageId: row.message_id,
    title: row.title,
    context: row.context,
    priority: row.priority as TaskPriority,
    estimatedMinutes: row.estimated_minutes,
    suggestedSlot: row.suggested_slot as SuggestedSlot,
    canUseAi: row.can_use_ai === 1,
    recommendedTool: row.recommended_tool,
    workflowHint: row.workflow_hint,
    isVoiceMessage: row.is_voice_message === 1,
    status: row.status as TaskStatus,
    snoozedUntil: row.snoozed_until,
    elapsedSeconds: row.elapsed_seconds,
    senderName: row.sender_name,
    chatJid: row.chat_jid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    steps,
    source: row.message_id ? 'whatsapp' : 'manual',
  };
}

export function listPendingEvals(): PendingEval[] {
  const rows = getDb()
    .prepare(
      `SELECT chat_jid AS chatJid,
              MAX(sender_name) AS senderName,
              MAX(CASE WHEN kind = 'voice' THEN 1 ELSE 0 END) AS hasVoice,
              MAX(received_at) AS receivedAt,
              SUM(CASE WHEN kind = 'voice' AND transcript IS NULL THEN 1 ELSE 0 END) AS waitingVoice
       FROM messages
       WHERE evaluated_at IS NULL AND llm_error IS NULL
       GROUP BY chat_jid
       ORDER BY receivedAt DESC`,
    )
    .all() as {
      chatJid: string;
      senderName: string;
      hasVoice: number;
      receivedAt: number;
      waitingVoice: number;
    }[];
  return rows.map((row) => ({
    chatJid: row.chatJid,
    senderName: row.senderName,
    kind: row.hasVoice ? 'voice' : 'text',
    receivedAt: row.receivedAt,
    waitingVoice: row.waitingVoice > 0,
  }));
}

export function insertMessage(message: InboxMessage): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO messages (
        id, chat_jid, sender_name, kind, body, transcript, audio_path, duration_seconds,
        received_at, evaluated_at, is_task, confidence, llm_raw, retry_count, last_attempt_at, llm_error
      ) VALUES (
        @id, @chatJid, @senderName, @kind, @body, @transcript, @audioPath, @durationSeconds,
        @receivedAt, @evaluatedAt, @isTask, @confidence, @llmRaw, @retryCount, @lastAttemptAt, @llmError
      )`,
    )
    .run({
      id: message.id,
      chatJid: message.chatJid,
      senderName: message.senderName,
      kind: message.kind,
      body: message.body,
      transcript: message.transcript,
      audioPath: message.audioPath,
      durationSeconds: message.durationSeconds,
      receivedAt: message.receivedAt,
      evaluatedAt: message.evaluatedAt,
      isTask: message.isTask === null ? null : message.isTask ? 1 : 0,
      confidence: message.confidence,
      llmRaw: message.llmRaw,
      retryCount: message.retryCount,
      lastAttemptAt: message.lastAttemptAt,
      llmError: message.llmError,
    });
  return result.changes > 0;
}

export function updateMessage(id: string, patch: Partial<InboxMessage>): InboxMessage {
  const current = getMessage(id);
  if (!current) throw new Error(`Nachricht nicht gefunden: ${id}`);
  const next: InboxMessage = { ...current, ...patch, id };
  getDb()
    .prepare(
      `UPDATE messages SET
        body = @body, transcript = @transcript, audio_path = @audioPath,
        duration_seconds = @durationSeconds, evaluated_at = @evaluatedAt,
        is_task = @isTask, confidence = @confidence, llm_raw = @llmRaw,
        retry_count = @retryCount, last_attempt_at = @lastAttemptAt, llm_error = @llmError
       WHERE id = @id`,
    )
    .run({
      id,
      body: next.body,
      transcript: next.transcript,
      audioPath: next.audioPath,
      durationSeconds: next.durationSeconds,
      evaluatedAt: next.evaluatedAt,
      isTask: next.isTask === null ? null : next.isTask ? 1 : 0,
      confidence: next.confidence,
      llmRaw: next.llmRaw,
      retryCount: next.retryCount,
      lastAttemptAt: next.lastAttemptAt,
      llmError: next.llmError,
    });
  return next;
}

export function getMessage(id: string): InboxMessage | null {
  const row = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  return row ? mapMessage(row) : null;
}

export function latestMessage(chatJid: string): InboxMessage | null {
  const row = getDb()
    .prepare('SELECT * FROM messages WHERE chat_jid = ? ORDER BY received_at DESC LIMIT 1')
    .get(chatJid) as MessageRow | undefined;
  return row ? mapMessage(row) : null;
}

export function listOpenTasks(chatJid: string): InboxTask[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE chat_jid = ? AND status IN ('inbox', 'active', 'paused', 'snoozed')
       ORDER BY updated_at DESC LIMIT 12`,
    )
    .all(chatJid) as TaskRow[];
  return rows.map((row) => mapTask(row, stepsFor(row.id)));
}

export function appendSteps(taskId: string, titles: string[]): InboxTask {
  const current = getTask(taskId);
  if (!current) throw new Error(`Aufgabe nicht gefunden: ${taskId}`);
  const have = new Set(current.steps.map((step) => step.title.trim().toLowerCase()));
  const fresh = titles.map((title) => title.trim()).filter((title) => title && !have.has(title.toLowerCase()));
  const now = Date.now();
  if (fresh.length === 0) {
    getDb().prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId);
    return getTask(taskId) ?? current;
  }
  const start = current.steps.reduce((max, step) => Math.max(max, step.position), -1) + 1;
  const insert = getDb().prepare(
    'INSERT INTO task_steps (id, task_id, title, done, position) VALUES (?, ?, ?, 0, ?)',
  );
  const tx = getDb().transaction(() => {
    fresh.forEach((title, index) => insert.run(randomUUID(), taskId, title, start + index));
    getDb().prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId);
  });
  tx();
  const next = getTask(taskId);
  if (!next) throw new Error(`Aufgabe nicht gefunden: ${taskId}`);
  return next;
}

/**
 * Nächstes auswertbares Bündel: alle noch offenen Nachrichten eines Chats,
 * sobald das Debounce-Fenster vorbei ist und keine Sprachnachricht mehr auf
 * ihr Transkript wartet.
 */
export function nextBundle(debounceMs: number, retryDelayMs: number, maxRetries: number): InboxMessage[] {
  const now = Date.now();
  const chats = getDb()
    .prepare(
      `SELECT chat_jid AS chatJid,
              MAX(received_at) AS latest,
              MAX(retry_count) AS retries,
              MAX(last_attempt_at) AS lastAttempt,
              SUM(CASE WHEN kind = 'voice' AND transcript IS NULL THEN 1 ELSE 0 END) AS waitingVoice
       FROM messages
       WHERE evaluated_at IS NULL AND llm_error IS NULL
       GROUP BY chat_jid`,
    )
    .all() as { chatJid: string; latest: number; retries: number; lastAttempt: number | null; waitingVoice: number }[];

  for (const chat of chats) {
    if (chat.waitingVoice > 0) continue;
    const waitingRetry = chat.retries > 0;
    if (waitingRetry && chat.retries >= maxRetries) continue;
    if (!waitingRetry && now - chat.latest < debounceMs) continue;
    if (waitingRetry && chat.lastAttempt !== null && now - chat.lastAttempt < retryDelayMs) continue;

    const rows = getDb()
      .prepare(
        `SELECT * FROM messages
         WHERE chat_jid = ? AND evaluated_at IS NULL AND llm_error IS NULL
         ORDER BY received_at ASC`,
      )
      .all(chat.chatJid) as MessageRow[];
    if (rows.length === 0) continue;
    return rows.map(mapMessage);
  }
  return [];
}

export function insertTask(task: InboxTask): void {
  const database = getDb();
  const tx = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO tasks (
          id, message_id, title, context, priority, estimated_minutes, suggested_slot,
          can_use_ai, recommended_tool, workflow_hint, is_voice_message, status,
          snoozed_until, elapsed_seconds, sender_name, chat_jid,
          created_at, updated_at, started_at, completed_at
        ) VALUES (
          @id, @messageId, @title, @context, @priority, @estimatedMinutes, @suggestedSlot,
          @canUseAi, @recommendedTool, @workflowHint, @isVoiceMessage, @status,
          @snoozedUntil, @elapsedSeconds, @senderName, @chatJid,
          @createdAt, @updatedAt, @startedAt, @completedAt
        )`,
      )
      .run({
        id: task.id,
        messageId: task.messageId,
        title: task.title,
        context: task.context,
        priority: task.priority,
        estimatedMinutes: task.estimatedMinutes,
        suggestedSlot: task.suggestedSlot,
        canUseAi: task.canUseAi ? 1 : 0,
        recommendedTool: task.recommendedTool,
        workflowHint: task.workflowHint,
        isVoiceMessage: task.isVoiceMessage ? 1 : 0,
        status: task.status,
        snoozedUntil: task.snoozedUntil,
        elapsedSeconds: task.elapsedSeconds,
        senderName: task.senderName,
        chatJid: task.chatJid,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
      });
    const insertStep = database.prepare(
      'INSERT INTO task_steps (id, task_id, title, done, position) VALUES (?, ?, ?, ?, ?)',
    );
    for (const step of task.steps) {
      insertStep.run(step.id, task.id, step.title, step.done ? 1 : 0, step.position);
    }
  });
  tx();
}

export function updateTaskRow(id: string, patch: Partial<InboxTask>): InboxTask {
  const current = getTask(id);
  if (!current) throw new Error(`Aufgabe nicht gefunden: ${id}`);
  const next: InboxTask = { ...current, ...patch, id, steps: patch.steps ?? current.steps, updatedAt: Date.now() };
  getDb()
    .prepare(
      `UPDATE tasks SET
        title = @title, context = @context, priority = @priority,
        estimated_minutes = @estimatedMinutes, suggested_slot = @suggestedSlot,
        can_use_ai = @canUseAi, recommended_tool = @recommendedTool,
        workflow_hint = @workflowHint, status = @status, snoozed_until = @snoozedUntil,
        elapsed_seconds = @elapsedSeconds, started_at = @startedAt, completed_at = @completedAt,
        updated_at = @updatedAt
       WHERE id = @id`,
    )
    .run({
      id,
      title: next.title,
      context: next.context,
      priority: next.priority,
      estimatedMinutes: next.estimatedMinutes,
      suggestedSlot: next.suggestedSlot,
      canUseAi: next.canUseAi ? 1 : 0,
      recommendedTool: next.recommendedTool,
      workflowHint: next.workflowHint,
      status: next.status,
      snoozedUntil: next.snoozedUntil,
      elapsedSeconds: next.elapsedSeconds,
      startedAt: next.startedAt,
      completedAt: next.completedAt,
      updatedAt: next.updatedAt,
    });
  return getTask(id) ?? next;
}

export function getTask(id: string): InboxTask | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) return null;
  return mapTask(row, stepsFor(id));
}

export function listTasks(status?: TaskStatus): InboxTask[] {
  const rows = status
    ? (getDb().prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC').all(status) as TaskRow[])
    : (getDb().prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as TaskRow[]);
  return rows.map((row) => mapTask(row, stepsFor(row.id)));
}

export function activeTask(): InboxTask | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE status = 'active' LIMIT 1").get() as TaskRow | undefined;
  return row ? mapTask(row, stepsFor(row.id)) : null;
}

export function inboxPreview(limit = 3): InboxTask[] {
  const rows = getDb()
    .prepare("SELECT * FROM tasks WHERE status = 'inbox' ORDER BY created_at DESC LIMIT ?")
    .all(limit) as TaskRow[];
  return rows.map((row) => mapTask(row, stepsFor(row.id)));
}

function stepsFor(taskId: string): TaskStep[] {
  const rows = getDb()
    .prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY position ASC')
    .all(taskId) as StepRow[];
  return rows.map(mapStep);
}

export function toggleStep(stepId: string): InboxTask {
  const row = getDb().prepare('SELECT * FROM task_steps WHERE id = ?').get(stepId) as StepRow | undefined;
  if (!row) throw new Error('Schritt nicht gefunden');
  getDb().prepare('UPDATE task_steps SET done = ? WHERE id = ?').run(row.done ? 0 : 1, stepId);
  getDb().prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now(), row.task_id);
  const task = getTask(row.task_id);
  if (!task) throw new Error('Aufgabe nicht gefunden');
  return task;
}

export function insertWorkSession(id: string, taskId: string, startedAt: number): void {
  getDb().prepare('INSERT INTO work_sessions (id, task_id, started_at, seconds) VALUES (?, ?, ?, 0)').run(id, taskId, startedAt);
}

export function closeWorkSession(id: string, endedAt: number, seconds: number): void {
  getDb().prepare('UPDATE work_sessions SET ended_at = ?, seconds = ? WHERE id = ?').run(endedAt, seconds, id);
}

/** Timeout-Abbrüche wieder in die Warteschlange, damit sie nach einem längeren Limit neu laufen. */
export function reopenTimedOutMessages(maxAgeMs = 7 * 24 * 60 * 60 * 1000): number {
  const result = getDb()
    .prepare(
      `UPDATE messages
       SET evaluated_at = NULL, retry_count = 0, last_attempt_at = NULL, llm_error = NULL
       WHERE is_task IS NULL
         AND evaluated_at IS NOT NULL
         AND evaluated_at >= ?
         AND llm_error LIKE '%timeout%'`,
    )
    .run(Date.now() - maxAgeMs);
  return result.changes;
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
