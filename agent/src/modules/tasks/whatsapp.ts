import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  proto,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageContent,
  type WASocket,
} from 'baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { CONFIG_DIR, DATA_DIR } from '../../config.ts';
import { logger } from '../../util/log.ts';
import * as db from './db.ts';
import { queue } from './queue.ts';
import { transcribeAudio } from './transcribe.ts';
import type { InboxMessage, WhitelistEntry, WhatsAppStatus } from './types.ts';

const log = logger('tasks/whatsapp');
const silent = pino({ level: 'silent' });
const baileysLog = pino({ level: 'error' });

const AUTH_DIR = join(DATA_DIR, 'wa-auth');
const AUDIO_DIR = join(DATA_DIR, 'audio');
const WHITELIST_FILE = join(CONFIG_DIR, 'whitelist.json');
const CHATS_FILE = join(DATA_DIR, 'wa-chats.json');
/** Beim Nachholen nach Offline-Zeit: ältere History nicht nochmal durch den Flow jagen. */
const CATCHUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type IncomingSource = 'notify' | 'append' | 'history';

class WhatsAppBridge extends EventEmitter {
  private sock: WASocket | null = null;
  private status: WhatsAppStatus = { state: 'disconnected', qr: null, me: null, error: null };
  private chats = new Map<string, string>();
  /** LID (@lid) → Telefon-JID, damit die Whitelist mit Nummern funktioniert. */
  private lids = new Map<string, string>();
  private connecting = false;
  private incomingChain: Promise<void> = Promise.resolve();

  constructor() {
    super();
    this.loadRememberedChats();
  }

  getStatus(): WhatsAppStatus {
    return this.status;
  }

  listChats(): { jid: string; name: string; allowed: boolean }[] {
    const allowed = new Set(loadWhitelist().filter((entry) => entry.enabled).map((entry) => normalizeJid(entry.jid)));
    return [...this.chats.entries()]
      .filter(([jid]) => jid !== 'status@broadcast' && !jid.endsWith('@broadcast'))
      .map(([jid, name]) => ({
        jid,
        name,
        allowed: allowed.has(normalizeJid(jid)) || allowed.has(this.canonicalJid(jid)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  whitelist(): WhitelistEntry[] {
    return loadWhitelist();
  }

  saveWhitelist(entries: WhitelistEntry[]): WhitelistEntry[] {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const cleaned = entries.map((entry) => ({
      jid: normalizeJid(entry.jid.includes('@') ? entry.jid : phoneToJid(entry.jid)),
      name: entry.name.trim() || entry.jid,
      enabled: entry.enabled !== false,
    }));
    writeFileSync(WHITELIST_FILE, `${JSON.stringify({ chats: cleaned }, null, 2)}\n`, { mode: 0o600 });
    return cleaned;
  }

  addToWhitelist(name: string, phoneOrJid: string): WhitelistEntry[] {
    const jid = phoneOrJid.includes('@') ? normalizeJid(phoneOrJid) : phoneToJid(phoneOrJid);
    const current = loadWhitelist().filter((entry) => normalizeJid(entry.jid) !== jid);
    current.push({ jid, name: name.trim() || jid, enabled: true });
    this.rememberChat(jid, name.trim() || jid);
    return this.saveWhitelist(current);
  }

  async connect(): Promise<WhatsAppStatus> {
    if (this.connecting || this.status.state === 'connected') return this.status;
    this.connecting = true;
    this.setStatus({ state: 'connecting', error: null });

    mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLog,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: (notification) => shouldSyncRecentHistory(notification),
      getMessage: async (key) => {
        const id = key.id;
        if (!id) return undefined;
        const stored = db.getMessage(id);
        if (stored?.body) return { conversation: stored.body };
        if (stored?.transcript) return { conversation: stored.transcript };
        return undefined;
      },
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        this.setStatus({ state: 'qr', qr, error: null });
        log.info('WhatsApp-QR bereit (Desktop-App oder GET /api/whatsapp/qr)');
      }
      if (connection === 'open') {
        const me = this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : null;
        const lid = (this.sock?.user as { lid?: string } | undefined)?.lid;
        if (lid && me) this.lids.set(normalizeJid(lid), me);
        this.setStatus({ state: 'connected', qr: null, me, error: null });
        this.connecting = false;
        log.info(`WhatsApp verbunden${me ? ` als ${me}` : ''}`);
        void this.afterConnected();
      }
      if (update.receivedPendingNotifications) {
        log.info('WhatsApp: Offline-Puffer vom Server abgearbeitet');
      }
      if (connection === 'close') {
        this.connecting = false;
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.sock = null;
        if (loggedOut) {
          this.setStatus({ state: 'disconnected', qr: null, me: null, error: 'Abgemeldet' });
          log.warn('WhatsApp-Sitzung abgemeldet');
          return;
        }
        this.setStatus({ state: 'disconnected', qr: null, error: lastDisconnect?.error?.message ?? 'getrennt' });
        log.warn('WhatsApp getrennt, neuer Versuch in 4s');
        setTimeout(() => {
          void this.connect();
        }, 4000).unref();
      }
    });

    this.sock.ev.on('contacts.upsert', (contacts) => this.ingestContacts(contacts));
    this.sock.ev.on('contacts.update', (contacts) => this.ingestContacts(contacts));
    this.sock.ev.on('chats.upsert', (chats) => this.ingestChats(chats));
    this.sock.ev.on('chats.update', (chats) => this.ingestChats(chats));
    this.sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      this.mapLid(lid, jid);
    });
    this.sock.ev.on('messaging-history.set', ({ chats, contacts, messages, syncType }) => {
      this.ingestContacts(contacts);
      this.ingestChats(chats);
      this.persistRememberedChats();
      const incoming = messages ?? [];
      const chatIds = [...new Set(incoming.map((message) => message.key.remoteJid).filter(Boolean))];
      log.info(
        `WhatsApp-History (${historySyncLabel(syncType)}): ${incoming.length} Nachrichten, ${chats.length} Chats` +
          (chatIds.length > 0 ? ` [${chatIds.slice(0, 4).join(', ')}]` : ''),
      );
      this.enqueueIncoming(incoming, 'history');
    });

    this.sock.ev.on('messages.upsert', (upsert) => {
      const source: IncomingSource = upsert.type === 'notify' ? 'notify' : 'append';
      this.enqueueIncoming(upsert.messages, source);
    });

    return this.status;
  }

  async logout(): Promise<WhatsAppStatus> {
    try {
      await this.sock?.logout();
    } catch (err) {
      log.warn(`Logout: ${(err as Error).message}`);
    }
    this.endSocket();
    this.setStatus({ state: 'disconnected', qr: null, me: null, error: null });
    return this.status;
  }

  /** Verbindung schließen, ohne die Sitzung auf dem Handy abzumelden. */
  endSocket(): void {
    this.connecting = false;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.writeRememberedChats();
    }
    try {
      this.sock?.end(undefined);
    } catch (err) {
      log.warn(`WhatsApp-Socket: ${(err as Error).message}`);
    }
    this.sock = null;
  }

  private setStatus(patch: Partial<WhatsAppStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  rememberChat(jid: string, name?: string | null): void {
    const id = normalizeJid(jid);
    if (!id || id === 'status@broadcast') return;
    const label = (name ?? '').trim();
    const previous = this.chats.get(id);
    if (label && (!previous || previous === id || previous.includes('@'))) this.chats.set(id, label);
    else if (!previous) this.chats.set(id, label || id);
    this.persistRememberedChats();
  }

  private canonicalJid(jid: string): string {
    const normalized = normalizeJid(jid);
    return this.lids.get(normalized) ?? normalized;
  }

  private mapLid(lid: string | null | undefined, phone: string | null | undefined): void {
    if (!lid || !phone) return;
    const lidJid = lid.includes('@') ? normalizeJid(lid) : `${String(lid).replace(/\D/g, '')}@lid`;
    const phoneJid = phone.includes('@') ? normalizeJid(phone) : phoneToJid(phone);
    if (!lidJid.endsWith('@lid') || !phoneJid.endsWith('@s.whatsapp.net')) return;
    if (this.lids.get(lidJid) === phoneJid) return;
    this.lids.set(lidJid, phoneJid);
    if (this.isAllowed(phoneJid) || this.isAllowed(lidJid)) {
      this.persistRememberedChats();
      log.info(`LID zugeordnet: ${lidJid} → ${phoneJid}`);
    }
  }

  isAllowed(jid: string): boolean {
    const candidates = new Set([normalizeJid(jid), this.canonicalJid(jid)]);
    return loadWhitelist().some((entry) => entry.enabled && candidates.has(normalizeJid(entry.jid)));
  }

  /** Chat mit der eigenen Nummer (Notiz an mich selbst). */
  private isSelfChat(jid: string): boolean {
    const own = new Set<string>();
    const add = (value?: string | null) => {
      if (!value) return;
      own.add(normalizeJid(value));
      own.add(this.canonicalJid(value));
    };
    add(this.status.me);
    add(this.sock?.user?.id);
    add((this.sock?.user as { lid?: string } | undefined)?.lid ?? null);
    return own.has(normalizeJid(jid)) || own.has(this.canonicalJid(jid));
  }

  private ingestContacts(contacts: { id?: string | null; jid?: string | null; lid?: string | null; notify?: string | null; name?: string | null }[]): void {
    for (const contact of contacts) {
      const phone = contact.jid ? normalizeJid(contact.jid) : contact.id ? normalizeJid(contact.id) : '';
      const lid = contact.lid ? normalizeJid(contact.lid) : contact.id?.endsWith('@lid') ? normalizeJid(contact.id) : '';
      if (lid && phone && phone !== lid) this.mapLid(lid, phone);
      const key = phone || lid;
      if (!key) continue;
      this.rememberChat(key, contact.notify || contact.name);
    }
  }

  private ingestChats(
    chats: {
      id?: string | null;
      name?: string | null;
      lidJid?: string | null;
      messages?: { message?: WAMessage | null }[] | null;
    }[],
  ): void {
    const embedded: WAMessage[] = [];
    for (const chat of chats) {
      if (!chat.id) continue;
      this.rememberChat(chat.id, chat.name);
      this.mapLid(chat.id, chat.lidJid);
      this.mapLid(chat.lidJid, chat.id);
      for (const item of chat.messages ?? []) {
        if (item.message) embedded.push(item.message);
      }
    }
    if (embedded.length > 0) this.enqueueIncoming(embedded, 'history');
  }

  private async afterConnected(): Promise<void> {
    await this.resolveWhitelistLids();
    await sleep(5000);
    await this.requestCatchUp();
  }

  private async resolveWhitelistLids(): Promise<void> {
    const sock = this.sock;
    if (!sock) return;
    const entries = loadWhitelist().filter((entry) => entry.enabled);
    try {
      const results = await sock.onWhatsApp(...entries.map((entry) => entry.jid));
      for (const result of results ?? []) {
        this.mapLid(result.lid ? String(result.lid) : null, result.jid);
        const phone = result.jid ? normalizeJid(result.jid) : '';
        const name = entries.find((entry) => normalizeJid(entry.jid) === phone)?.name;
        if (result.lid && name) this.rememberChat(String(result.lid), name);
      }
    } catch (err) {
      log.warn(`LID-Auflösung: ${(err as Error).message}`);
    }
    this.guessLidMappingFromNames();
  }

  private guessLidMappingFromNames(): void {
    for (const entry of loadWhitelist().filter((item) => item.enabled)) {
      const phone = normalizeJid(entry.jid);
      for (const [jid, name] of this.chats) {
        if (!jid.endsWith('@lid') || this.lids.has(jid)) continue;
        const sameName = name === entry.name || name.startsWith(`${entry.name} `) || name.startsWith(`${entry.name}|`);
        if (!sameName) continue;
        this.mapLid(jid, phone);
      }
    }
  }

  private lidForPhone(phone: string): string | undefined {
    const want = normalizeJid(phone);
    for (const [lid, mapped] of this.lids) {
      if (mapped === want) return lid;
    }
    return undefined;
  }

  private async requestCatchUp(): Promise<void> {
    const sock = this.sock;
    if (!sock || this.status.state !== 'connected') return;
    for (const entry of loadWhitelist().filter((item) => item.enabled)) {
      const phone = normalizeJid(entry.jid);
      const lid = this.lidForPhone(phone);
      const chatJid = lid ?? phone;
      const latest = db.latestMessage(chatJid) ?? db.latestMessage(phone) ?? (lid ? db.latestMessage(lid) : null);
      // ON_DEMAND blättert rückwärts. Für Chats mit bekannten Nachrichten bringt das
      // keine neuen (verpassten) Nachrichten, nur älteren Verlauf.
      if (latest) continue;
      try {
        await sock.fetchMessageHistory(
          40,
          {
            remoteJid: chatJid,
            fromMe: false,
            id: `3EB0${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
          },
          Date.now(),
        );
        log.info(`WhatsApp-Nachholung angefordert für ${entry.name} (${chatJid})`);
      } catch (err) {
        log.warn(`WhatsApp-Nachholung ${entry.name}: ${(err as Error).message}`);
      }
    }
  }

  private loadRememberedChats(): void {
    if (!existsSync(CHATS_FILE)) return;
    try {
      const parsed = JSON.parse(readFileSync(CHATS_FILE, 'utf8')) as { chats?: { jid: string; name: string }[]; lids?: Record<string, string> };
      for (const chat of parsed.chats ?? []) this.chats.set(normalizeJid(chat.jid), chat.name);
      for (const [lid, phone] of Object.entries(parsed.lids ?? {})) this.lids.set(lid, phone);
    } catch (err) {
      log.warn(`wa-chats.json unlesbar: ${(err as Error).message}`);
    }
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private persistRememberedChats(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeRememberedChats();
    }, 400);
    this.persistTimer.unref();
  }

  private writeRememberedChats(): void {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const allowed = new Set(
      loadWhitelist()
        .filter((entry) => entry.enabled)
        .flatMap((entry) => [normalizeJid(entry.jid), this.lidForPhone(entry.jid)].filter(Boolean) as string[]),
    );
    writeFileSync(
      CHATS_FILE,
      `${JSON.stringify(
        {
          chats: [...this.chats.entries()].map(([jid, name]) => ({ jid, name })),
          lids: Object.fromEntries([...this.lids].filter(([lid, phone]) => allowed.has(lid) || allowed.has(phone))),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  private enqueueIncoming(messages: WAMessage[], source: IncomingSource): void {
    if (messages.length === 0) return;
    this.incomingChain = this.incomingChain
      .then(() => this.processIncoming(messages, source))
      .catch((err) => {
        log.warn(`Nachrichtenverarbeitung (${source}): ${(err as Error).message}`);
      });
  }

  private async processIncoming(messages: WAMessage[], source: IncomingSource): Promise<void> {
    const maxAge = source === 'notify' ? Number.POSITIVE_INFINITY : CATCHUP_MAX_AGE_MS;
    let ingested = 0;
    let skippedOld = 0;
    let skippedOther = 0;
    for (const message of messages) {
      if (Date.now() - waTimestamp(message) > maxAge) {
        skippedOld += 1;
        continue;
      }
      if (await this.handleMessage(message)) ingested += 1;
      else skippedOther += 1;
    }
    if (source !== 'notify' && (ingested > 0 || skippedOld + skippedOther === 0 || messages.some((message) => this.shouldKeep(message)))) {
      log.info(
        `WhatsApp-Nachholung (${source}): ${ingested} übernommen` +
          (skippedOld > 0 ? `, ${skippedOld} älter als 14 Tage` : '') +
          (skippedOther > 0 ? `, ${skippedOther} übersprungen` : ''),
      );
      if (ingested === 0 && messages[0]) {
        const sample = messages[0];
        log.info(
          `Nachholung-Beispiel: jid=${sample.key.remoteJid} fromMe=${sample.key.fromMe} ts=${waTimestamp(sample)} inhalt=${Boolean(sample.message)}`,
        );
      }
    }
  }

  private shouldKeep(message: WAMessage): boolean {
    const chatJid = jidNormalizedUser(message.key.remoteJid ?? '');
    if (!chatJid || chatJid === 'status@broadcast' || chatJid.endsWith('@newsletter')) return false;
    if (message.key.fromMe) return this.isSelfChat(chatJid);
    return this.isAllowed(chatJid);
  }

  private async handleMessage(message: WAMessage): Promise<boolean> {
    if (!message.message) return false;
    const chatJid = jidNormalizedUser(message.key.remoteJid ?? '');
    if (!chatJid || chatJid === 'status@broadcast') return false;

    const fromMe = Boolean(message.key.fromMe);
    if (fromMe) {
      if (!this.isSelfChat(chatJid)) return false;
    } else if (!this.isAllowed(chatJid)) {
      return false;
    }

    const content = extractMessageContent(message.message);
    if (!content) return false;

    const senderName = fromMe
      ? loadWhitelist().find((entry) => entry.enabled && normalizeJid(entry.jid) === this.canonicalJid(chatJid))?.name ||
        message.pushName ||
        'Ich'
      : message.pushName || this.chats.get(this.canonicalJid(chatJid)) || this.chats.get(chatJid) || chatJid;
    this.rememberChat(chatJid, senderName);
    this.rememberChat(this.canonicalJid(chatJid), senderName);

    const audio = content.audioMessage;
    const text = inboxTextFromContent(content);

    if (audio) {
      return this.handleVoice(message, chatJid, senderName, audio.seconds ?? null);
    }
    if (!text.trim()) return false;

    try {
      const inserted = persistText(message, chatJid, senderName, text.trim());
      if (!inserted) return false;
      if (fromMe) log.info(`Notiz an mich selbst: ${text.trim().slice(0, 80)}`);
      this.emit('inboxPending');
      queue.notify(chatJid);
      return true;
    } catch (err) {
      log.warn(`Textnachricht nicht gespeichert: ${(err as Error).message}`);
      return false;
    }
  }

  private async handleVoice(
    message: WAMessage,
    chatJid: string,
    senderName: string,
    durationSeconds: number | null,
  ): Promise<boolean> {
    if (!this.sock) return false;
    const id = message.key.id || randomUUID();
    if (db.getMessage(id)) return false;
    mkdirSync(AUDIO_DIR, { recursive: true, mode: 0o700 });
    const audioPath = join(AUDIO_DIR, `${id}.ogg`);

    const buffer = await Promise.race([
      downloadMediaMessage(
        message,
        'buffer',
        {},
        { logger: silent, reuploadRequest: this.sock.updateMediaMessage },
      ),
      sleep(20_000).then(() => {
        throw new Error('Audio-Download Timeout');
      }),
    ]);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      log.warn(`Sprachnachricht ohne Audio: ${id}`);
      return false;
    }
    writeFileSync(audioPath, buffer);

    const record: InboxMessage = {
      id,
      chatJid,
      senderName,
      kind: 'voice',
      body: null,
      transcript: null,
      audioPath,
      durationSeconds,
      receivedAt: waTimestamp(message),
      evaluatedAt: null,
      isTask: null,
      confidence: null,
      llmRaw: null,
      retryCount: 0,
      lastAttemptAt: null,
      llmError: null,
    };
    try {
      if (!db.insertMessage(record)) return false;
      this.emit('inboxPending');
    } catch (err) {
      log.warn(`Sprachnachricht nicht gespeichert: ${(err as Error).message}`);
      return false;
    }

    try {
      const transcript = await transcribeAudio(buffer, `${id}.ogg`);
      db.updateMessage(id, { transcript });
      this.emit('voiceTranscribed', { id, chatJid, senderName, transcript, durationSeconds });
      this.emit('inboxPending');
      queue.notify(chatJid);
    } catch (err) {
      const error = (err as Error).message;
      log.error(`Transkription fehlgeschlagen: ${error}`);
      db.updateMessage(id, { llmError: `stt: ${error.slice(0, 300)}`, evaluatedAt: Date.now() });
      this.setStatus({ error: `Transkription fehlgeschlagen: ${error}` });
    }
    return true;
  }
}

function persistText(message: WAMessage, chatJid: string, senderName: string, text: string): boolean {
  return db.insertMessage({
    id: message.key.id || randomUUID(),
    chatJid,
    senderName,
    kind: 'text',
    body: text,
    transcript: null,
    audioPath: null,
    durationSeconds: null,
    receivedAt: waTimestamp(message),
    evaluatedAt: null,
    isTask: null,
    confidence: null,
    llmRaw: null,
    retryCount: 0,
    lastAttemptAt: null,
    llmError: null,
  });
}

function shouldSyncRecentHistory(notification: proto.Message.IHistorySyncNotification): boolean {
  const type = Number(notification.syncType);
  return (
    type === proto.Message.HistorySyncNotification.HistorySyncType.RECENT ||
    type === proto.Message.HistorySyncNotification.HistorySyncType.PUSH_NAME ||
    type === proto.Message.HistorySyncNotification.HistorySyncType.ON_DEMAND ||
    type === proto.Message.HistorySyncNotification.HistorySyncType.INITIAL_BOOTSTRAP
  );
}

function historySyncLabel(syncType: proto.HistorySync.HistorySyncType | undefined): string {
  if (syncType === undefined || syncType === null) return 'unbekannt';
  const named = proto.HistorySync.HistorySyncType[syncType as proto.HistorySync.HistorySyncType];
  return typeof named === 'string' ? named : String(syncType);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inboxTextFromContent(content: WAMessageContent): string {
  const parts: string[] = [];
  const quoted = quotedPlainText(content);
  if (quoted) parts.push(`[Antwort auf: ${quoted}]`);

  const caption = (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  ).trim();
  if (caption) parts.push(caption);

  if (content.documentMessage) {
    const name = content.documentMessage.fileName?.trim() || 'Datei';
    parts.push(`[Datei: ${name}]`);
  } else if (content.imageMessage) {
    parts.push('[Bild]');
  } else if (content.videoMessage) {
    parts.push('[Video]');
  }

  return parts.join('\n');
}

function quotedPlainText(content: WAMessageContent): string | null {
  const nested = [
    content.extendedTextMessage?.contextInfo?.quotedMessage,
    content.imageMessage?.contextInfo?.quotedMessage,
    content.videoMessage?.contextInfo?.quotedMessage,
    content.documentMessage?.contextInfo?.quotedMessage,
    content.audioMessage?.contextInfo?.quotedMessage,
  ];
  for (const quoted of nested) {
    if (!quoted) continue;
    const inner = extractMessageContent(quoted) ?? quoted;
    const caption = (
      inner.conversation ||
      inner.extendedTextMessage?.text ||
      inner.imageMessage?.caption ||
      inner.videoMessage?.caption ||
      inner.documentMessage?.caption ||
      inner.documentMessage?.fileName ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (caption) return caption.slice(0, 180);
  }
  return null;
}

function waTimestamp(message: WAMessage): number {
  const raw = Number(message.messageTimestamp);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : Date.now();
}

function loadWhitelist(): WhitelistEntry[] {
  if (!existsSync(WHITELIST_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(WHITELIST_FILE, 'utf8')) as { chats?: WhitelistEntry[] } | WhitelistEntry[];
    const chats = Array.isArray(parsed) ? parsed : (parsed.chats ?? []);
    return chats.map((entry) => ({
      jid: String(entry.jid),
      name: String(entry.name ?? entry.jid),
      enabled: entry.enabled !== false,
    }));
  } catch (err) {
    log.warn(`whitelist.json unlesbar: ${(err as Error).message}`);
    return [];
  }
}

function phoneToJid(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `49${digits.slice(1)}`;
  if (!digits) throw new Error('Telefonnummer fehlt');
  return `${digits}@s.whatsapp.net`;
}

function normalizeJid(jid: string): string {
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid.replace(/:\d+@/, '@');
  }
}

export const whatsapp = new WhatsAppBridge();
export { WHITELIST_FILE };
