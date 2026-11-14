import { EventEmitter } from 'node:events';
import { loadConfig } from '../../config.ts';
import { logger } from '../../util/log.ts';
import * as db from './db.ts';
import { extractTask, looksLikeSmalltalk } from './extractor.ts';
import { tasks } from './store.ts';
import type { ExtractionItem, InboxMessage, InboxTask } from './types.ts';

const log = logger('tasks/queue');

class TaskQueue extends EventEmitter {
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  start(): void {
    if (this.timer) return;
    const reopened = db.reopenTimedOutMessages();
    if (reopened > 0) log.info(`${reopened} Nachrichten nach KI-Timeout erneut in die Warteschlange`);
    this.timer = setInterval(() => {
      void this.tick();
    }, 2000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const handle of this.debounceTimers.values()) clearTimeout(handle);
    this.debounceTimers.clear();
  }

  /** Nach einer neuen Nachricht das Debounce-Fenster dieses Chats neu starten. */
  notify(chatJid: string): void {
    const config = loadConfig();
    const existing = this.debounceTimers.get(chatJid);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.debounceTimers.delete(chatJid);
      void this.tick();
    }, config.messageDebounceMs + 50);
    handle.unref();
    this.debounceTimers.set(chatJid, handle);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    const config = loadConfig();
    const bundle = db.nextBundle(config.messageDebounceMs, config.llmRetryDelayMs, config.llmMaxRetries);
    if (bundle.length === 0) return;

    this.busy = true;
    try {
      await this.process(bundle);
    } catch (err) {
      log.error(`Bündel fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async process(bundle: InboxMessage[]): Promise<void> {
    const config = loadConfig();
    const first = bundle[0];
    if (!first) return;

    const text = bundle
      .map((message) => (message.kind === 'voice' ? message.transcript : message.body) ?? '')
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
    const isVoice = bundle.some((message) => message.kind === 'voice');
    const senderName = bundle.map((message) => message.senderName).find(Boolean) ?? first.senderName;

    if (!text || looksLikeSmalltalk(text)) {
      this.finish(bundle, { isTask: false, confidence: 1, llmRaw: '{"skipped":"heuristic"}' });
      log.info(`Smalltalk verworfen (${bundle.length} Nachrichten von ${senderName})`);
      return;
    }

    const open = db.listOpenTasks(first.chatJid);
    if (isMediaOnlyStub(text) && open.length === 0) {
      this.finish(bundle, { isTask: false, confidence: 1, llmRaw: '{"skipped":"media"}' });
      log.info(`Medien ohne offenen Auftrag verworfen von ${senderName}`);
      return;
    }

    log.info(`KI-Auswertung (${bundle.length} Nachrichten, ${text.length} Zeichen) von ${senderName}`);
    let result;
    try {
      result = await extractTask({
        senderName,
        chatJid: first.chatJid,
        isVoice,
        text,
        openTasks: open.map((task) => ({
          id: task.id,
          title: task.title,
          context: task.context,
          steps: task.steps.map((step) => step.title),
        })),
      });
    } catch (err) {
      const message = (err as Error).message;
      log.warn(`Erste Extraktion fehlgeschlagen: ${message}`);
      await sleep(2000);
      try {
        result = await extractTask({
          senderName,
          chatJid: first.chatJid,
          isVoice,
          text,
          openTasks: open.map((task) => ({
            id: task.id,
            title: task.title,
            context: task.context,
            steps: task.steps.map((step) => step.title),
          })),
          effort: 'low',
        });
      } catch (retryErr) {
        this.fail(bundle, (retryErr as Error).message, config.llmMaxRetries);
        return;
      }
    }

    const accepted = result.confidence >= config.taskConfidenceThreshold && result.items.length > 0;
    this.finish(bundle, {
      isTask: accepted,
      confidence: result.confidence,
      llmRaw: JSON.stringify(result),
    });

    if (!accepted) {
      log.info(`Keine Aufgabe (confidence ${result.confidence.toFixed(2)}, ${result.items.length} items) von ${senderName}`);
      return;
    }

    let createdCount = 0;
    let updatedCount = 0;
    const live = [...open];
    for (const item of result.items) {
      const target = resolveTarget(item, live);
      if (target) {
        const next = tasks.enrich(target.id, {
          title: item.title,
          context: item.context,
          steps: item.steps,
        });
        const index = live.findIndex((task) => task.id === target.id);
        if (index >= 0) live[index] = next;
        this.emit('taskEnriched', next);
        updatedCount += 1;
      } else {
        const created = tasks.create({
          title: item.title,
          context: item.context,
          isVoiceMessage: isVoice,
          messageId: [...bundle].reverse().find((message) => message.kind === 'voice')?.id ?? first.id,
          senderName,
          chatJid: first.chatJid,
          steps: item.steps,
        });
        live.unshift(created);
        this.emit('taskFromMessage', created);
        createdCount += 1;
      }
    }
    log.info(
      `${createdCount} angelegt, ${updatedCount} ergänzt von ${senderName} (confidence ${result.confidence.toFixed(2)})`,
    );
  }

  private finish(bundle: InboxMessage[], result: { isTask: boolean; confidence: number; llmRaw: string }): void {
    const now = Date.now();
    for (const message of bundle) {
      db.updateMessage(message.id, {
        evaluatedAt: now,
        isTask: result.isTask,
        confidence: result.confidence,
        llmRaw: result.llmRaw,
        llmError: null,
      });
    }
    this.emit('pendingChanged');
  }

  private fail(bundle: InboxMessage[], error: string, maxRetries: number): void {
    const now = Date.now();
    const retries = Math.max(...bundle.map((message) => message.retryCount)) + 1;
    const exhausted = retries >= maxRetries;
    for (const message of bundle) {
      db.updateMessage(message.id, {
        evaluatedAt: exhausted ? now : null,
        retryCount: retries,
        lastAttemptAt: now,
        llmError: exhausted ? error.slice(0, 400) : null,
      });
    }
    this.emit('pendingChanged');
    if (exhausted) {
      log.error(`Nachricht nach ${retries} Versuchen aufgegeben: ${error}`);
      this.emit('llmFailed', {
        chatJid: bundle[0]?.chatJid,
        error,
        retries,
      });
    } else {
      log.warn(`Wiedervorlage ${retries}/${maxRetries}: ${error}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMediaOnlyStub(text: string): boolean {
  const lines = text
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('[Antwort auf:'));
  if (lines.length === 0) return false;
  return lines.every((line) => /^\[(Bild|Video|Datei:.+)\]$/.test(line));
}

function resolveTarget(item: ExtractionItem, open: InboxTask[]): InboxTask | null {
  if (item.matchId) {
    const byId = open.find((task) => task.id === item.matchId);
    if (byId) return byId;
  }
  const byTitle = open.find((task) => titlesMatch(task.title, item.title));
  if (byTitle) return byTitle;
  if (item.kind === 'update' && open.length === 1) return open[0] ?? null;
  return null;
}

function titlesMatch(left: string, right: string): boolean {
  const a = left.toLowerCase().replace(/\s+/g, ' ').trim();
  const b = right.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 10 && (b.includes(a) || a.includes(b))) return true;
  return false;
}

export const queue = new TaskQueue();
