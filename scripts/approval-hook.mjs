#!/usr/bin/env node
/**
 * PreToolUse-Hook: leitet Genehmigungsfragen ans Handy weiter.
 *
 * Einbindung in ~/.claude/settings.json:
 *
 *   "hooks": {
 *     "PreToolUse": [
 *       {
 *         "matcher": "Bash|Write|Edit",
 *         "hooks": [
 *           { "type": "command", "command": "node $HOME/Projekte/pcctl/scripts/approval-hook.mjs" }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Der Hook erhält die Anfrage als JSON über stdin und antwortet auf stdout.
 *
 * Grundsatz: Im Zweifel nicht entscheiden. Wenn der Agent nicht läuft, das
 * Handy nicht antwortet oder irgendetwas schiefgeht, wird keine Entscheidung
 * zurückgegeben – dann fragt Claude Code wie gewohnt im Terminal nach. Der
 * Hook kann also nie dazu führen, dass etwas ungefragt zugelassen wird.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 90_000;

/** Leere Antwort = keine Entscheidung, Claude Code fragt normal nach. */
function passThrough(reason) {
  if (reason && process.env.PCCTL_HOOK_DEBUG) {
    process.stderr.write(`[pcctl-hook] ${reason}\n`);
  }
  process.stdout.write('{}');
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return passThrough('Eingabe war kein gültiges JSON');
  }

  let config;
  try {
    const configPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'pcctl', 'config.json');
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return passThrough('pcctl-Konfiguration nicht lesbar');
  }

  const controller = new AbortController();
  // Etwas mehr Zeit als der Server, damit dessen Rückfallwert zuerst greift.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS + 5000);

  let decision;
  try {
    const response = await fetch(`http://127.0.0.1:${config.port ?? 8765}/api/claude/approvals/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        sessionId: payload.session_id ?? '',
        toolName: payload.tool_name ?? 'unbekannt',
        toolInput: payload.tool_input ?? null,
        cwd: payload.cwd ?? '',
        timeoutMs: TIMEOUT_MS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return passThrough(`Agent antwortete mit ${response.status}`);
    decision = await response.json();
  } catch (err) {
    return passThrough(`Agent nicht erreichbar: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // "ask" bedeutet: keine Fernentscheidung, normal im Terminal nachfragen.
  if (!decision || decision.decision === 'ask') {
    return passThrough('Keine Fernentscheidung getroffen');
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.decision === 'allow' ? 'allow' : 'deny',
        permissionDecisionReason: decision.reason ?? 'Entscheidung vom Handy',
      },
    }),
  );
  process.exit(0);
}

main().catch((err) => passThrough(`Unerwarteter Fehler: ${err.message}`));
