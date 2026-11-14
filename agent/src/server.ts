import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig } from './config.ts';
import { isAllowedAddress, safeCompare, primaryLanAddress } from './util/net.ts';
import { logger } from './util/log.ts';

import * as stats from './modules/stats.ts';
import * as power from './modules/power.ts';
import * as audio from './modules/audio.ts';
import * as display from './modules/display.ts';
import * as rgb from './modules/rgb.ts';
import * as apps from './modules/apps.ts';
import * as scenes from './modules/scenes.ts';
import * as wol from './modules/wol.ts';
import * as gnome from './modules/gnome.ts';
import * as claudeSessions from './modules/claude/sessions.ts';
import * as claudeInput from './modules/claude/input.ts';
import { tasks, type PermissionMode } from './modules/claude/runner.ts';
import { approvals, type Decision } from './modules/claude/approvals.ts';
import * as taskDb from './modules/tasks/db.ts';
import { tasks as inbox } from './modules/tasks/store.ts';
import { timer } from './modules/tasks/timer.ts';
import { workmode } from './modules/tasks/workmode.ts';
import { queue } from './modules/tasks/queue.ts';
import { whatsapp } from './modules/tasks/whatsapp.ts';
import type { InboxTask, TaskPriority, SuggestedSlot, WhitelistEntry } from './modules/tasks/types.ts';

const log = logger('server');
const config = loadConfig();

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

// ---------------------------------------------------------------- Zugriffsschutz

/** Endpunkte, die ohne Token erreichbar sind – bewusst nur der Erreichbarkeitstest. */
const PUBLIC_ROUTES = new Set(['/api/ping']);

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const queryToken = (request.query as Record<string, unknown> | undefined)?.['token'];
  return typeof queryToken === 'string' ? queryToken : null;
}

app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
  const clientIp = request.ip;

  // Erste Schranke: Herkunft. Greift auch dann, wenn die Firewall umgangen wurde.
  if (!isAllowedAddress(clientIp, config.allowedNetworks)) {
    log.warn(`Zugriff von nicht erlaubter Adresse abgewiesen: ${clientIp}`);
    return reply.code(403).send({ error: 'Zugriff von dieser Adresse nicht erlaubt' });
  }

  if (PUBLIC_ROUTES.has(request.url.split('?')[0] ?? '')) return;

  // Zweite Schranke: Token.
  const token = extractToken(request);
  if (!token || !safeCompare(token, config.token)) {
    return reply.code(401).send({ error: 'Ungültiges oder fehlendes Token' });
  }
});

/** Einheitliche Fehlerbehandlung: Modul-Fehler werden zu 400 statt 500. */
function handle<T>(work: () => Promise<T> | T) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await work();
    } catch (err) {
      const message = (err as Error).message;
      log.warn(`${request.method} ${request.url}: ${message}`);
      return reply.code(400).send({ error: message });
    }
  };
}

// ---------------------------------------------------------------- Allgemein

app.get('/api/ping', async () => ({ service: 'pcctl-agent', version: 1, time: Date.now() }));

app.get(
  '/api/status',
  handle(async () => {
    const [audioState, displayState, rgbState, powerCaps, bridge] = await Promise.all([
      audio.status(),
      display.status(),
      rgb.status(),
      power.capabilities(),
      gnome.status(),
    ]);

    return {
      stats: stats.compactSnapshot(),
      audio: audioState,
      display: displayState,
      rgb: rgbState,
      power: { capabilities: powerCaps, scheduled: power.scheduledAction() },
      scenes: scenes.loadScenes().map(({ id, name, icon, description }) => ({ id, name, icon, description })),
      gnomeBridge: bridge,
      claude: { runningTasks: tasks.runningCount(), pendingApprovals: approvals.list().length },
      wol: wol.readiness(),
      workMode: workmode.status(),
      whatsapp: whatsapp.getStatus(),
      inbox: {
        open: inbox.list('inbox').length,
        active: inbox.active(),
      },
    };
  }),
);

// ---------------------------------------------------------------- Stats

app.get('/api/stats', handle(() => stats.snapshot()));
app.get('/api/stats/compact', handle(() => stats.compactSnapshot()));

// ---------------------------------------------------------------- Energie

app.post('/api/power/poweroff', handle(() => power.powerOff()));
app.post('/api/power/reboot', handle(() => power.reboot()));
app.post('/api/power/suspend', handle(() => power.suspend()));
app.post('/api/power/lock', handle(() => power.lockSession()));
app.get('/api/power/scheduled', handle(() => power.scheduledAction() ?? { scheduled: null }));
app.delete('/api/power/scheduled', handle(() => power.cancelScheduled()));

app.post('/api/power/schedule', async (request, reply) => {
  const body = request.body as { action?: string; minutes?: number } | undefined;
  const action = body?.action;
  const minutes = body?.minutes;

  if (action !== 'poweroff' && action !== 'reboot' && action !== 'suspend') {
    return reply.code(400).send({ error: 'action muss poweroff, reboot oder suspend sein' });
  }
  if (typeof minutes !== 'number' || minutes <= 0 || minutes > 24 * 60) {
    return reply.code(400).send({ error: 'minutes muss zwischen 1 und 1440 liegen' });
  }

  return power.scheduleAction(action, minutes);
});

// ---------------------------------------------------------------- Monitore

app.get('/api/display', handle(() => display.status()));
app.get('/api/display/capabilities', handle(() => display.capabilities()));
app.post('/api/display/off', handle(() => display.blank()));
app.post('/api/display/on', handle(() => display.unblank()));
app.post('/api/display/toggle', handle(() => display.toggle()));

app.post('/api/display/brightness', async (request, reply) => {
  const percent = (request.body as { percent?: number } | undefined)?.percent;
  if (typeof percent !== 'number') return reply.code(400).send({ error: 'percent fehlt' });
  try {
    return await display.setBrightness(percent);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------- RGB

app.get('/api/rgb', handle(() => rgb.status()));
app.post('/api/rgb/off', handle(() => rgb.off()));
app.post('/api/rgb/on', handle(() => rgb.on()));
app.post('/api/rgb/toggle', handle(() => rgb.toggle()));

app.post('/api/rgb/color', async (request, reply) => {
  const color = (request.body as { color?: string } | undefined)?.color;
  if (!color) return reply.code(400).send({ error: 'color fehlt' });
  try {
    return await rgb.setColor(color);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------- Audio

app.get('/api/audio', handle(() => audio.status()));
app.post('/api/audio/mic/toggle', handle(() => audio.toggleMicMute()));
app.post('/api/audio/mic/mute', handle(() => audio.setMicMuted(true)));
app.post('/api/audio/mic/unmute', handle(() => audio.setMicMuted(false)));
app.post('/api/audio/output/toggle', handle(() => audio.toggleOutputMute()));
app.get('/api/audio/media', handle(() => audio.mediaStatus()));

app.post('/api/audio/volume', async (request, reply) => {
  const body = request.body as { percent?: number; delta?: number; target?: 'output' | 'microphone' } | undefined;
  const target = body?.target ?? 'output';
  try {
    if (typeof body?.delta === 'number') return await audio.adjustVolume(target, body.delta);
    if (typeof body?.percent === 'number') return await audio.setVolume(target, body.percent);
    return reply.code(400).send({ error: 'percent oder delta angeben' });
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/audio/media/:command', async (request, reply) => {
  const command = (request.params as { command: string }).command;
  const allowed = ['PlayPause', 'Play', 'Pause', 'Next', 'Previous', 'Stop'] as const;
  const match = allowed.find((c) => c.toLowerCase() === command.toLowerCase());
  if (!match) return reply.code(400).send({ error: `Unbekannter Medienbefehl: ${command}` });
  return audio.mediaControl(match);
});

// ---------------------------------------------------------------- Anwendungen

app.get('/api/apps', handle(() => apps.list()));

app.post('/api/apps/:pid/quit', async (request, reply) => {
  const pid = Number((request.params as { pid: string }).pid);
  const force = (request.body as { force?: boolean } | undefined)?.force === true;
  if (!Number.isInteger(pid)) return reply.code(400).send({ error: 'Ungültige PID' });
  try {
    return await apps.quit(pid, { force });
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------- Szenen

app.get('/api/scenes', handle(() => scenes.loadScenes()));
app.post('/api/scenes/:id/run', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  try {
    return await scenes.runScene(id);
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message });
  }
});

app.put('/api/scenes', async (request, reply) => {
  const body = request.body;
  if (!Array.isArray(body)) return reply.code(400).send({ error: 'Erwartet wird eine Liste von Szenen' });
  return scenes.saveScenes(body as scenes.Scene[]);
});

// ---------------------------------------------------------------- Wake-on-LAN

app.get('/api/wol', handle(() => wol.readiness()));
app.post('/api/wol/wake', async (request, reply) => {
  const body = request.body as { mac?: string; broadcast?: string } | undefined;
  try {
    return await wol.wake(body?.mac, body?.broadcast);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------- Claude

app.get('/api/claude/sessions', handle(() => claudeSessions.listSessions(30)));

app.get('/api/claude/sessions/:id/history', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const limit = Number((request.query as { limit?: string } | undefined)?.limit ?? 50);
  try {
    return await claudeSessions.readHistory(id, limit);
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message });
  }
});

app.get('/api/claude/tasks', handle(() => tasks.list()));
app.get('/api/claude/tasks/:id', async (request, reply) => {
  const task = tasks.get((request.params as { id: string }).id);
  return task ?? reply.code(404).send({ error: 'Aufgabe nicht gefunden' });
});

app.post('/api/claude/tasks', async (request, reply) => {
  const body = request.body as
    | { prompt?: string; cwd?: string; permissionMode?: PermissionMode; resumeSessionId?: string }
    | undefined;
  if (!body?.prompt) return reply.code(400).send({ error: 'prompt fehlt' });
  try {
    return tasks.start({
      prompt: body.prompt,
      cwd: body.cwd,
      permissionMode: body.permissionMode,
      resumeSessionId: body.resumeSessionId,
    });
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/claude/tasks/:id/cancel', async (request, reply) => {
  const ok = tasks.cancel((request.params as { id: string }).id);
  return ok ? { cancelled: true } : reply.code(404).send({ error: 'Aufgabe läuft nicht' });
});

// Tastatureingabe in den Editor – experimentell, siehe modules/claude/input.ts
app.get('/api/claude/input/readiness', handle(() => claudeInput.readiness()));

app.post('/api/claude/input', async (request, reply) => {
  const body = request.body as { text?: string; submit?: boolean; windowId?: number } | undefined;
  if (!body?.text) return reply.code(400).send({ error: 'text fehlt' });

  const result = await claudeInput.typeIntoEditor(body.text, {
    submit: body.submit,
    activateWindowId: body.windowId,
  });
  // Eine abgelehnte Eingabe ist kein Serverfehler, sondern ein erwartetes Ergebnis.
  return result.ok ? result : reply.code(409).send(result);
});

// Genehmigungen
app.get('/api/claude/approvals', handle(() => ({ pending: approvals.list(), recent: approvals.recent() })));

app.post('/api/claude/approvals/:id/decide', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = request.body as { decision?: Decision; reason?: string } | undefined;
  if (body?.decision !== 'allow' && body?.decision !== 'deny' && body?.decision !== 'ask') {
    return reply.code(400).send({ error: 'decision muss allow, deny oder ask sein' });
  }
  const ok = approvals.decide(id, body.decision, body.reason);
  return ok ? { decided: true } : reply.code(404).send({ error: 'Anfrage nicht gefunden oder abgelaufen' });
});

/**
 * Endpunkt für den PreToolUse-Hook. Blockiert, bis die App antwortet oder
 * die Frist abläuft.
 */
app.post('/api/claude/approvals/request', async (request, reply) => {
  const body = request.body as
    | { sessionId?: string; toolName?: string; toolInput?: unknown; cwd?: string; timeoutMs?: number }
    | undefined;

  if (!body?.toolName) return reply.code(400).send({ error: 'toolName fehlt' });

  const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 60_000, 5_000), 300_000);
  return approvals.request(
    {
      sessionId: body.sessionId ?? 'unbekannt',
      toolName: body.toolName,
      toolInput: body.toolInput,
      cwd: body.cwd ?? '',
    },
    timeoutMs,
  );
});

// ---------------------------------------------------------------- Aufgaben-Inbox

app.get('/api/tasks', async (request, reply) => {
  const status = (request.query as { status?: string } | undefined)?.status;
  if (status && !isTaskStatus(status)) {
    return reply.code(400).send({ error: 'Unbekannter Status' });
  }
  return inbox.list(status as InboxTask['status'] | undefined);
});

app.get('/api/tasks/views', handle(() => inbox.views()));
app.get('/api/tasks/pending', handle(() => inbox.pending()));
app.get('/api/tasks/active', handle(() => inbox.active() ?? { active: null }));

app.get('/api/tasks/:id/transcript', async (request, reply) => {
  try {
    return inbox.transcript((request.params as { id: string }).id);
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message });
  }
});

app.post('/api/tasks', async (request, reply) => {
  const body = request.body as
    | {
        title?: string;
        context?: string;
        priority?: TaskPriority;
        estimatedMinutes?: number;
        suggestedSlot?: SuggestedSlot;
        canUseAi?: boolean;
        recommendedTool?: string;
        workflowHint?: string;
        steps?: string[];
      }
    | undefined;
  if (!body?.title?.trim()) return reply.code(400).send({ error: 'title fehlt' });
  try {
    return inbox.create({ ...body, title: body.title.trim() });
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.patch('/api/tasks/:id', async (request, reply) => {
  try {
    return inbox.update((request.params as { id: string }).id, (request.body ?? {}) as Partial<InboxTask>);
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message });
  }
});

app.post('/api/tasks/:id/start', async (request, reply) => {
  try {
    return timer.start((request.params as { id: string }).id);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/tasks/:id/pause', async (request, reply) => {
  try {
    return timer.pause((request.params as { id: string }).id);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/tasks/:id/complete', async (request, reply) => {
  try {
    return timer.complete((request.params as { id: string }).id);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/tasks/:id/snooze', async (request, reply) => {
  const body = request.body as { until?: number; hours?: number } | undefined;
  const until = body?.until ?? Date.now() + Math.max(1, body?.hours ?? 4) * 60 * 60 * 1000;
  try {
    return timer.snooze((request.params as { id: string }).id, until);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/tasks/:id/drop', async (request, reply) => {
  try {
    return timer.drop((request.params as { id: string }).id);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/tasks/steps/:id/toggle', async (request, reply) => {
  try {
    return inbox.toggleStep((request.params as { id: string }).id);
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message });
  }
});

app.get('/api/workmode', handle(() => workmode.status()));
app.post('/api/workmode', async (request) => {
  const enabled = (request.body as { enabled?: boolean } | undefined)?.enabled;
  return typeof enabled === 'boolean' ? workmode.set(enabled) : workmode.toggle();
});

app.get('/api/whatsapp/status', handle(() => whatsapp.getStatus()));
app.get('/api/whatsapp/qr', handle(() => {
  const status = whatsapp.getStatus();
  return { qr: status.qr, state: status.state };
}));
app.post('/api/whatsapp/connect', handle(() => whatsapp.connect()));
app.post('/api/whatsapp/logout', handle(() => whatsapp.logout()));
app.get('/api/whatsapp/chats', handle(() => whatsapp.listChats()));
app.get('/api/whatsapp/whitelist', handle(() => whatsapp.whitelist()));
app.put('/api/whatsapp/whitelist', async (request, reply) => {
  const body = request.body as { chats?: WhitelistEntry[] } | WhitelistEntry[] | undefined;
  const entries = Array.isArray(body) ? body : body?.chats;
  if (!Array.isArray(entries)) return reply.code(400).send({ error: 'Erwartet wird eine Liste von Chats' });
  return whatsapp.saveWhitelist(entries);
});

app.post('/api/whatsapp/whitelist/add', async (request, reply) => {
  const body = request.body as { name?: string; phone?: string; jid?: string } | undefined;
  const id = body?.jid || body?.phone;
  if (!id) return reply.code(400).send({ error: 'phone oder jid fehlt' });
  try {
    return whatsapp.addToWhitelist(body?.name ?? '', id);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

function isTaskStatus(value: string): value is InboxTask['status'] {
  return value === 'inbox' || value === 'active' || value === 'paused' || value === 'done' || value === 'snoozed' || value === 'dropped';
}

// ---------------------------------------------------------------- WebSocket

type Client = {
  socket: WebSocket;
  /** Sitzung, deren Protokoll dieser Client verfolgt. */
  tail: claudeSessions.SessionTail | null;
};

const clients = new Set<Client>();

function broadcast(type: string, payload: unknown) {
  const message = JSON.stringify({ type, payload, at: Date.now() });
  for (const client of clients) {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(message);
  }
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket: WebSocket) => {
  const client: Client = { socket, tail: null };
  clients.add(client);
  log.info(`WebSocket verbunden (${clients.size} aktiv)`);

  socket.send(JSON.stringify({ type: 'hello', payload: { stats: stats.compactSnapshot() }, at: Date.now() }));

  socket.on('message', (raw) => {
    let message: { action?: string; sessionId?: string };
    try {
      message = JSON.parse(String(raw)) as typeof message;
    } catch {
      return;
    }

    // Ein Client kann genau ein Sitzungsprotokoll gleichzeitig verfolgen.
    if (message.action === 'watchSession' && message.sessionId) {
      client.tail?.stop();
      client.tail = null;

      const session = claudeSessions.findSession(message.sessionId);
      if (!session) {
        socket.send(JSON.stringify({ type: 'error', payload: { message: 'Sitzung nicht gefunden' } }));
        return;
      }

      const tail = new claudeSessions.SessionTail(session.projectPath);
      tail.on('event', (event) => {
        socket.send(JSON.stringify({ type: 'sessionEvent', payload: { sessionId: session.id, event } }));
      });
      tail.start();
      client.tail = tail;
      socket.send(JSON.stringify({ type: 'watching', payload: { sessionId: session.id } }));
    }

    if (message.action === 'unwatchSession') {
      client.tail?.stop();
      client.tail = null;
    }
  });

  socket.on('close', () => {
    client.tail?.stop();
    clients.delete(client);
    log.info(`WebSocket getrennt (${clients.size} aktiv)`);
  });

  socket.on('error', (err) => log.warn(`WebSocket-Fehler: ${err.message}`));
});

// Ereignisse aus den Modulen an alle Clients weiterreichen.
tasks.on('event', (payload) => broadcast('taskEvent', payload));
tasks.on('status', (task) => broadcast('taskStatus', task));
approvals.on('requested', (request) => broadcast('approvalRequested', request));
approvals.on('expired', (request) => broadcast('approvalExpired', request));
approvals.on('decided', (payload) => broadcast('approvalDecided', payload));

inbox.on('created', (task) => broadcast('taskCreated', task));
inbox.on('updated', (task) => broadcast('taskUpdated', task));
timer.on('tick', (payload) => broadcast('activeTaskTick', payload));
workmode.on('changed', (state) => broadcast('workModeChanged', state));
whatsapp.on('status', (status) => broadcast('whatsappStatus', status));
whatsapp.on('voiceTranscribed', (payload) => broadcast('voiceTranscribed', payload));
whatsapp.on('inboxPending', () => broadcast('inboxPending', inbox.pending()));
queue.on('pendingChanged', () => broadcast('inboxPending', inbox.pending()));
queue.on('taskEnriched', (task) => broadcast('taskEnriched', task));
queue.on('llmFailed', (payload) => broadcast('whatsappStatus', { ...whatsapp.getStatus(), error: `KI-Auswertung fehlgeschlagen: ${payload.error}` }));

/**
 * Laufender Rundruf, solange jemand zuhört.
 *
 * Neben den Kennzahlen gehen auch die Schaltzustände mit. Sonst bekäme die
 * App Änderungen, die direkt am Rechner vorgenommen werden (Mikrofon über
 * eine Taste stummschalten), gar nicht mit und zeigte einen veralteten Stand.
 * Verwendet werden nur günstige Quellen: wpctl sowie die bereits im Speicher
 * gehaltenen Zustände von Monitoren und Beleuchtung.
 */
setInterval(() => {
  if (clients.size === 0) return;

  void audio
    .status()
    .then((audioState) => {
      broadcast('live', {
        stats: stats.compactSnapshot(),
        audio: audioState,
        display: display.quickState(),
        rgb: rgb.quickState(),
      });
    })
    .catch(() => {
      // Fällt die Audioabfrage aus, sollen wenigstens die Kennzahlen weiterlaufen.
      broadcast('live', { stats: stats.compactSnapshot() });
    });
}, 2000).unref();

// ---------------------------------------------------------------- Start

async function main() {
  taskDb.getDb();
  timer.recover();
  queue.start();
  stats.warmUp();
  gnome.retryUntilAvailable();
  void display.detect().catch(() => undefined);
  void whatsapp.connect().catch((err) => log.warn(`WhatsApp-Start: ${(err as Error).message}`));

  await app.listen({ port: config.port, host: config.host });

  // WebSocket an denselben Port hängen, mit derselben Prüfung wie HTTP.
  app.server.on('upgrade', (request, socket, head) => {
    const remote = request.socket.remoteAddress ?? '';
    if (!isAllowedAddress(remote, config.allowedNetworks)) {
      socket.destroy();
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    if (url.pathname !== '/ws' || !safeCompare(token, config.token)) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  const lan = primaryLanAddress();
  log.info(`pcctl-agent läuft auf http://${lan ?? config.host}:${config.port}`);
  log.info(`Erlaubte Netze: ${config.allowedNetworks.join(', ')}`);
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} empfangen – beende`);
    queue.stop();
    whatsapp.endSocket();
    wss.close();
    void app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500).unref();
  });
}

main().catch((err) => {
  log.error(`Start fehlgeschlagen: ${(err as Error).message}`);
  process.exit(1);
});
