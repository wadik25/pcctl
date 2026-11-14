import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../config.ts';
import { logger } from '../../util/log.ts';

const log = logger('tasks/transcribe');

export async function transcribeAudio(ogg: Buffer, filename = 'voice.ogg'): Promise<string> {
  const config = loadConfig();
  const wav = await toWav(ogg);

  if (config.sttProvider === 'groq') return transcribeGroq(wav, filename);
  if (config.sttProvider === 'openai') return transcribeOpenAi(wav, filename);
  throw new Error(`STT-Provider ${config.sttProvider} ist noch nicht angebunden`);
}

async function transcribeGroq(wav: Buffer, filename: string): Promise<string> {
  const config = loadConfig();
  if (!config.groqApiKey) throw new Error('groqApiKey fehlt in der Konfiguration');

  const blob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' });
  const body = new FormData();
  body.set('file', blob, filename.replace(/\.ogg$/i, '.wav'));
  body.set('model', config.sttModel);
  body.set('language', 'de');
  body.set('response_format', 'json');

  const response = await fetchWithRetry(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
      body,
      signal: AbortSignal.timeout(config.sttTimeoutMs),
    },
    config.sttTimeoutMs,
  );

  const payload = (await response.json()) as { text?: string; error?: { message?: string } };
  const text = payload.text?.trim();
  if (!text) throw new Error(payload.error?.message ?? 'Groq lieferte kein Transkript');
  log.info(`Transkription (${text.length} Zeichen)`);
  return text;
}

async function transcribeOpenAi(wav: Buffer, filename: string): Promise<string> {
  const config = loadConfig();
  if (!config.groqApiKey) throw new Error('API-Key für OpenAI-kompatible Transkription fehlt (groqApiKey)');
  const blob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' });
  const body = new FormData();
  body.set('file', blob, filename.replace(/\.ogg$/i, '.wav'));
  body.set('model', config.sttModel);
  body.set('language', 'de');

  const response = await fetchWithRetry(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
      body,
      signal: AbortSignal.timeout(config.sttTimeoutMs),
    },
    config.sttTimeoutMs,
  );
  const payload = (await response.json()) as { text?: string };
  const text = payload.text?.trim();
  if (!text) throw new Error('OpenAI lieferte kein Transkript');
  return text;
}

async function fetchWithRetry(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return response;
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(`STT HTTP ${response.status}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const detail = await response.text();
      throw new Error(`STT HTTP ${response.status}: ${detail.slice(0, 240)}`);
    } catch (err) {
      lastError = err;
      if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
        if (attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
      }
      if (attempt >= 2) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Transkription fehlgeschlagen');
}

function toWav(ogg: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const dir = join(tmpdir(), 'pcctl-stt');
    mkdirSync(dir, { recursive: true });
    const input = join(dir, `in-${Date.now()}.ogg`);
    const output = join(dir, `out-${Date.now()}.wav`);
    writeFileSync(input, ogg);

    const child = spawn('ffmpeg', ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-f', 'wav', output], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      cleanup(input, output);
      reject(new Error(`ffmpeg nicht startbar: ${err.message}`));
    });
    child.on('close', (code) => {
      try {
        if (code !== 0) throw new Error(stderr.trim().split('\n').at(-1) ?? `ffmpeg Code ${code}`);
        resolve(readFileSync(output));
      } catch (err) {
        reject(err);
      } finally {
        cleanup(input, output);
      }
    });
  });
}

function cleanup(...paths: string[]) {
  for (const path of paths) {
    try {
      rmSync(path, { force: true });
    } catch {
      // temporäre Dateien dürfen fehlen
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
