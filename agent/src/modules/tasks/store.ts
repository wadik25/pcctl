import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../../util/log.ts';
import * as db from './db.ts';
import type { InboxTask, PendingEval, SuggestedSlot, TaskPriority, TaskStatus, TaskViews } from './types.ts';

const log = logger('tasks/store');

export type TaskPatch = {
  title?: string;
  context?: string;
  priority?: TaskPriority;
  estimatedMinutes?: number;
  suggestedSlot?: SuggestedSlot;
  canUseAi?: boolean;
  recommendedTool?: string;
  workflowHint?: string;
};

class TaskStore extends EventEmitter {
  list(status?: TaskStatus): InboxTask[] {
    return db.listTasks(status);
  }

  pending(): PendingEval[] {
    return db.listPendingEvals();
  }

  get(id: string): InboxTask | null {
    return db.getTask(id);
  }

  views(): TaskViews {
    const open = db
      .listTasks()
      .filter((task) => task.status === 'inbox' || task.status === 'paused' || task.status === 'snoozed');
    const now = Date.now();
    const due = open.filter((task) => task.status !== 'snoozed' || (task.snoozedUntil ?? 0) <= now);
    const quickWins = due.filter((task) => task.estimatedMinutes < 15 || task.suggestedSlot === 'QUICK_WIN_HEUTE');
    const used = new Set(quickWins.map((task) => task.id));
    const focusBlocks = due.filter(
      (task) => !used.has(task.id) && (task.estimatedMinutes > 45 || task.suggestedSlot === 'FOKUS_HEUTE'),
    );
    focusBlocks.forEach((task) => used.add(task.id));
    const later = due.filter((task) => !used.has(task.id));
    return { quickWins, focusBlocks, later };
  }

  create(input: {
    title: string;
    context?: string;
    priority?: TaskPriority;
    estimatedMinutes?: number;
    suggestedSlot?: SuggestedSlot;
    canUseAi?: boolean;
    recommendedTool?: string;
    workflowHint?: string;
    isVoiceMessage?: boolean;
    messageId?: string | null;
    senderName?: string | null;
    chatJid?: string | null;
    steps?: string[];
  }): InboxTask {
    const now = Date.now();
    const id = randomUUID();
    const task: InboxTask = {
      id,
      messageId: input.messageId ?? null,
      title: input.title.trim(),
      context: (input.context ?? '').trim(),
      priority: input.priority ?? 'MEDIUM',
      estimatedMinutes: input.estimatedMinutes ?? 15,
      suggestedSlot: input.suggestedSlot ?? 'GEPLANT_SPAETER',
      canUseAi: input.canUseAi ?? false,
      recommendedTool: input.recommendedTool ?? 'Manuell',
      workflowHint: input.workflowHint ?? '',
      isVoiceMessage: input.isVoiceMessage ?? false,
      status: 'inbox',
      snoozedUntil: null,
      elapsedSeconds: 0,
      senderName: input.senderName ?? null,
      chatJid: input.chatJid ?? null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      steps: (input.steps ?? []).map((title, position) => ({
        id: randomUUID(),
        taskId: id,
        title,
        done: false,
        position,
      })),
      source: input.messageId ? 'whatsapp' : 'manual',
    };
    if (!task.title) throw new Error('Titel darf nicht leer sein');
    db.insertTask(task);
    log.info(`Neue Aufgabe: ${task.title}`);
    this.emit('created', task);
    return task;
  }

  enrich(
    id: string,
    patch: { title?: string; context: string; steps?: string[] },
  ): InboxTask {
    const current = db.getTask(id);
    if (!current) throw new Error('Aufgabe nicht gefunden');
    const title = (patch.title ?? current.title).trim() || current.title;
    const context = mergeContext(current.context, patch.context);
    db.updateTaskRow(id, { title, context });
    const task = patch.steps?.length ? db.appendSteps(id, patch.steps) : (db.getTask(id) ?? current);
    log.info(`Aufgabe ergänzt: ${task.title}`);
    this.emit('updated', task);
    return task;
  }

  update(id: string, patch: TaskPatch): InboxTask {
    const task = db.updateTaskRow(id, patch);
    this.emit('updated', task);
    return task;
  }

  setStatus(id: string, status: TaskStatus, extra: Partial<InboxTask> = {}): InboxTask {
    const task = db.updateTaskRow(id, { status, ...extra });
    this.emit('updated', task);
    return task;
  }

  toggleStep(stepId: string): InboxTask {
    const task = db.toggleStep(stepId);
    this.emit('updated', task);
    return task;
  }

  active(): InboxTask | null {
    return db.activeTask();
  }

  inboxPreview(limit = 3): InboxTask[] {
    return db.inboxPreview(limit);
  }

  transcript(id: string): { task: InboxTask; transcript: string | null; body: string | null; senderName: string | null; receivedAt: number | null } {
    const task = db.getTask(id);
    if (!task) throw new Error('Aufgabe nicht gefunden');
    const message = task.messageId ? db.getMessage(task.messageId) : null;
    return {
      task,
      transcript: message?.transcript ?? null,
      body: message?.body ?? null,
      senderName: message?.senderName ?? task.senderName,
      receivedAt: message?.receivedAt ?? null,
    };
  }
}

export const tasks = new TaskStore();

function mergeContext(previous: string, incoming: string): string {
  const old = previous.trim();
  const next = incoming.trim();
  if (!next) return old;
  if (!old) return next;
  if (old === next) return old;
  if (next.includes(old) && next.length >= old.length) return next;
  if (old.includes(next)) return old;
  return `${old}\n\n${next}`;
}
