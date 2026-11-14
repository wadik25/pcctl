import { loadConfig, type ReasoningEffort } from '../../config.ts';
import { logger } from '../../util/log.ts';
import { EXTRACTION_SCHEMA, SYSTEM_PROMPT, userPrompt } from './prompt.ts';
import type { ExtractionItem, ExtractionResult } from './types.ts';

const log = logger('tasks/extractor');

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const SMALLTALK = new Set([
  'ok',
  'okay',
  'okey',
  'danke',
  'dankeschön',
  'dankesehr',
  'thanks',
  'thx',
  'bitte',
  'bitte schön',
  'ja',
  'nein',
  'jo',
  'yo',
  'hi',
  'hallo',
  'hey',
  'moin',
  'servus',
  'ciao',
  'bis gleich',
  'bis später',
  'bis dann',
  'gute nacht',
  'guten morgen',
  'alles gut',
  'alles klar',
  'passt',
  'super',
  'top',
  'lol',
  'haha',
  'hehe',
  'nice',
  'cool',
  '👍',
  '👌',
  '🙏',
  '😊',
]);

export function looksLikeSmalltalk(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return true;

  const emojiOnly = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/gu, '') === '';
  if (emojiOnly) return true;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length >= 4) return false;
  return words.every((word) => SMALLTALK.has(word) || SMALLTALK.has(words.join(' ')));
}

export async function extractTask(input: {
  senderName: string;
  chatJid: string;
  isVoice: boolean;
  text: string;
  openTasks: { id: string; title: string; context: string; steps: string[] }[];
  effort?: ReasoningEffort;
  timeoutMs?: number;
}): Promise<ExtractionResult> {
  const config = loadConfig();
  if (!config.nvidiaApiKey) throw new Error('nvidiaApiKey fehlt in der Konfiguration');

  const effort = input.effort ?? config.llmReasoningEffort;
  const timeoutMs = input.timeoutMs ?? timeoutForText(input.text, config.llmTimeoutMs);
  const body = {
    model: config.nvidiaModel,
    temperature: 0.2,
    max_tokens: 2048,
    reasoning_effort: effort,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(input) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'task_extraction', schema: EXTRACTION_SCHEMA, strict: true },
    },
  };

  let response = await callNvidia(config.nvidiaApiKey, body, timeoutMs);
  if (response.status === 400) {
    log.warn('json_schema abgelehnt, zweiter Versuch ohne Schema');
    const fallback = { ...body } as Record<string, unknown>;
    delete fallback.response_format;
    response = await callNvidia(config.nvidiaApiKey, fallback, timeoutMs);
  }
  if (!response.ok) {
    throw new Error(`Kimi-K3 HTTP ${response.status}: ${response.text.slice(0, 240)}`);
  }

  const parsed = parseCompletion(response.text);
  return normalize(parsed);
}

function timeoutForText(text: string, baseMs: number): number {
  const extra = Math.min(45_000, Math.floor(text.length / 8) * 100);
  return Math.min(90_000, baseMs + extra);
}

async function callNvidia(apiKey: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetch(NVIDIA_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

function parseCompletion(raw: string): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Antwort von Kimi-K3 ist kein JSON');
  }

  const choices = (payload as { choices?: { message?: { content?: unknown } }[] }).choices;
  const content = choices?.[0]?.message?.content;
  const text = extractText(content);
  if (!text) throw new Error('Kimi-K3 hat keinen Inhalt geliefert');
  return parseJsonPayload(text);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text);
        return '';
      })
      .join('\n');
  }
  return '';
}

function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Konnte kein JSON-Objekt aus der Modellantwort lesen');
  }
}

function normalize(value: unknown): ExtractionResult {
  if (!value || typeof value !== 'object') throw new Error('Extraktion lieferte kein Objekt');
  const raw = value as Record<string, unknown>;
  const confidence = clampNumber(raw.confidence, 0, 1, 0);

  if (Array.isArray(raw.items)) {
    return { confidence, items: raw.items.map(parseItem).filter((item): item is ExtractionItem => item !== null) };
  }

  if (raw.task && typeof raw.task === 'object') {
    const legacy = parseItem({ kind: 'create', match_id: '', ...(raw.task as object) });
    return { confidence, items: legacy ? [legacy] : [] };
  }

  return { confidence, items: [] };
}

function parseItem(value: unknown): ExtractionItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const title = String(raw.title ?? '').trim().slice(0, 80);
  if (!title) return null;
  const kind = raw.kind === 'update' ? 'update' : 'create';
  const steps = Array.isArray(raw.steps) ? raw.steps.map((step) => String(step).trim()).filter(Boolean) : [];
  return {
    kind,
    matchId: String(raw.match_id ?? raw.matchId ?? '').trim(),
    title,
    context: String(raw.context ?? '').trim(),
    steps,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
