import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../../util/log.ts';
import * as db from './db.ts';
import { tasks } from './store.ts';
import type { InboxTask } from './types.ts';

const log = logger('tasks/timer');

type TickPayload = {
  task: InboxTask;
  elapsedSeconds: number;
};

class TaskTimer extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private sessionStartedAt = 0;

  start(id: string): InboxTask {
    const current = tasks.active();
    if (current && current.id !== id) this.pause(current.id);

    const task = db.getTask(id);
    if (!task) throw new Error('Aufgabe nicht gefunden');
    if (task.status === 'done' || task.status === 'dropped') {
      throw new Error('Abgeschlossene Aufgaben lassen sich nicht starten');
    }

    const now = Date.now();
    const updated = tasks.setStatus(id, 'active', {
      startedAt: task.startedAt ?? now,
      snoozedUntil: null,
    });

    this.sessionId = randomUUID();
    this.sessionStartedAt = now;
    db.insertWorkSession(this.sessionId, id, now);
    this.arm();
    log.info(`Timer gestartet: ${updated.title}`);
    this.emit('tick', { task: updated, elapsedSeconds: updated.elapsedSeconds } satisfies TickPayload);
    return updated;
  }

  pause(id?: string): InboxTask {
    const task = id ? db.getTask(id) : tasks.active();
    if (!task) throw new Error('Keine laufende Aufgabe');
    this.closeSession(task);
    this.disarm();
    const updated = tasks.setStatus(task.id, 'paused');
    log.info(`Timer pausiert: ${updated.title}`);
    return updated;
  }

  complete(id: string): InboxTask {
    const task = db.getTask(id);
    if (!task) throw new Error('Aufgabe nicht gefunden');
    if (task.status === 'active') this.closeSession(task);
    this.disarm();
    const updated = tasks.setStatus(id, 'done', { completedAt: Date.now() });
    log.info(`Aufgabe erledigt: ${updated.title}`);
    return updated;
  }

  snooze(id: string, until: number): InboxTask {
    const task = db.getTask(id);
    if (!task) throw new Error('Aufgabe nicht gefunden');
    if (task.status === 'active') this.closeSession(task);
    this.disarm();
    return tasks.setStatus(id, 'snoozed', { snoozedUntil: until });
  }

  drop(id: string): InboxTask {
    const task = db.getTask(id);
    if (!task) throw new Error('Aufgabe nicht gefunden');
    if (task.status === 'active') this.closeSession(task);
    this.disarm();
    return tasks.setStatus(id, 'dropped', { completedAt: Date.now() });
  }

  /** Nach einem Absturz nicht einfach weiterlaufen lassen. */
  recover(): void {
    const active = tasks.active();
    if (!active) return;
    this.closeSession(active);
    this.disarm();
    tasks.setStatus(active.id, 'paused');
    log.info(`Offene Aufgabe nach Neustart pausiert: ${active.title}`);
  }

  private arm() {
    this.disarm();
    this.interval = setInterval(() => {
      const active = tasks.active();
      if (!active) {
        this.disarm();
        return;
      }
      const updated = db.updateTaskRow(active.id, { elapsedSeconds: active.elapsedSeconds + 1 });
      this.emit('tick', { task: updated, elapsedSeconds: updated.elapsedSeconds } satisfies TickPayload);
    }, 1000);
    this.interval.unref();
  }

  private disarm() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private closeSession(task: InboxTask) {
    if (!this.sessionId) return;
    const seconds = Math.max(0, Math.round((Date.now() - this.sessionStartedAt) / 1000));
    db.closeWorkSession(this.sessionId, Date.now(), seconds);
    this.sessionId = null;
  }
}

export const timer = new TaskTimer();
