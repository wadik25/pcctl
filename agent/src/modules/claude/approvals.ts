import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../../util/log.ts';

const log = logger('claude/approvals');

/**
 * Genehmigungen vom Handy beantworten.
 *
 * Ablauf:
 *   1. Ein PreToolUse-Hook in ~/.claude/settings.json ruft scripts/approval-hook.mjs auf.
 *   2. Das Skript meldet die Anfrage an /api/claude/approvals/request und wartet.
 *   3. Der Agent schickt sie über WebSocket an die App.
 *   4. Die Antwort aus der App löst die wartende Anfrage auf.
 *   5. Bleibt die Antwort aus, entscheidet der eingestellte Rückfallwert.
 *
 * Der Rückfallwert ist bewusst "ask": Wenn das Handy nicht erreichbar ist,
 * wird die Frage einfach wie gewohnt im Terminal gestellt, statt etwas
 * ungefragt zuzulassen.
 */

export type Decision = 'allow' | 'deny' | 'ask';

export type ApprovalRequest = {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  cwd: string;
  createdAt: number;
  expiresAt: number;
};

type Pending = {
  request: ApprovalRequest;
  resolve: (decision: { decision: Decision; reason: string }) => void;
  timer: NodeJS.Timeout;
};

class ApprovalRegistry extends EventEmitter {
  private pending = new Map<string, Pending>();
  private history: Array<ApprovalRequest & { decision: Decision; decidedAt: number }> = [];

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  recent(limit = 20) {
    return this.history.slice(-limit).reverse();
  }

  /**
   * Legt eine Anfrage an und wartet auf die Entscheidung.
   * Wird nur vom Hook-Endpunkt aufgerufen.
   */
  request(
    input: { sessionId: string; toolName: string; toolInput: unknown; cwd: string },
    timeoutMs: number,
  ): Promise<{ decision: Decision; reason: string }> {
    const id = randomUUID();
    const now = Date.now();

    const request: ApprovalRequest = {
      id,
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      cwd: input.cwd,
      createdAt: now,
      expiresAt: now + timeoutMs,
    };

    log.info(`Genehmigung angefragt: ${input.toolName} (${id.slice(0, 8)})`);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log.warn(`Genehmigung ${id.slice(0, 8)} ohne Antwort – Rückfall auf normale Nachfrage`);
        this.emit('expired', request);
        resolve({ decision: 'ask', reason: 'Keine Antwort vom Handy – normale Nachfrage' });
      }, timeoutMs);

      this.pending.set(id, { request, resolve, timer });
      this.emit('requested', request);
    });
  }

  /** Beantwortet eine wartende Anfrage. */
  decide(id: string, decision: Decision, reason?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(id);

    this.history.push({ ...entry.request, decision, decidedAt: Date.now() });
    if (this.history.length > 100) this.history.shift();

    log.info(`Genehmigung ${id.slice(0, 8)}: ${decision}`);
    entry.resolve({ decision, reason: reason ?? `Vom Handy: ${decision}` });
    this.emit('decided', { id, decision });
    return true;
  }
}

export const approvals = new ApprovalRegistry();
