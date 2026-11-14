import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, isAvailable } from '../../util/exec.ts';
import { focusedWindow, bridgeAvailable, activateWindow, listWindows } from '../gnome.ts';
import { logger } from '../../util/log.ts';

const log = logger('claude/input');

/**
 * Text in eine laufende Editor-Sitzung tippen.
 *
 * Das ist der fragilste Baustein des gesamten Projekts und ausdrücklich der
 * letzte Ausweg: Unter Wayland gibt es keine Möglichkeit, Text gezielt an ein
 * bestimmtes Fenster zu schicken – ydotool erzeugt Eingaben auf Kernel-Ebene,
 * die immer im gerade fokussierten Fenster landen.
 *
 * Deshalb wird vor jedem Tippen über die GNOME-Extension geprüft, welches
 * Fenster den Fokus hat. Passt es nicht, wird abgebrochen statt blind zu
 * tippen – ein Prompt, der versehentlich in einem Terminal oder Browser
 * landet, wäre deutlich schlimmer als eine abgelehnte Anfrage.
 */

/** Fensterklassen, die als Editor mit Claude-Sitzung gelten. */
const EDITOR_WM_CLASSES = ['cursor', 'code', 'codium', 'code-oss', 'windsurf'];

function looksLikeEditor(wmClass: string): boolean {
  const normalized = wmClass.toLowerCase();
  return EDITOR_WM_CLASSES.some((candidate) => normalized.includes(candidate));
}

export type TypeResult =
  | { ok: true; typed: string; target: { wmClass: string; title: string } }
  | { ok: false; reason: string; focused?: { wmClass: string; title: string } | null };

function ydotoolSocket(): string {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return process.env.YDOTOOL_SOCKET ?? join(runtime, '.ydotool_socket');
}

async function preflight(): Promise<string | null> {
  if (!(await isAvailable('ydotool'))) {
    return 'ydotool ist nicht installiert';
  }
  if (!existsSync(ydotoolSocket())) {
    return 'ydotoold läuft nicht – der Eingabedienst muss aktiv sein';
  }
  if (!(await bridgeAvailable())) {
    return 'GNOME-Extension pcctl-bridge nicht erreichbar – ohne Fokusprüfung wird nicht getippt';
  }
  return null;
}

/**
 * Tippt Text in das fokussierte Fenster, sofern es ein Editor ist.
 *
 * @param options.activateWindowId Fenster vorher in den Vordergrund holen.
 * @param options.submit Nach dem Text Enter senden.
 */
export async function typeIntoEditor(
  text: string,
  options: { activateWindowId?: number; submit?: boolean } = {},
): Promise<TypeResult> {
  if (!text.trim()) return { ok: false, reason: 'Kein Text übergeben' };

  const problem = await preflight();
  if (problem) return { ok: false, reason: problem };

  // Auf Wunsch das Zielfenster zuerst aktivieren und kurz warten,
  // bis der Compositor den Fokuswechsel vollzogen hat.
  if (options.activateWindowId !== undefined) {
    await activateWindow(options.activateWindowId);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const focused = await focusedWindow();
  if (!focused) {
    return { ok: false, reason: 'Kein Fenster im Fokus', focused: null };
  }

  if (!looksLikeEditor(focused.wmClass)) {
    log.warn(`Tippen abgelehnt – Fokus liegt auf "${focused.wmClass}"`);
    return {
      ok: false,
      reason: `Abgebrochen: Im Fokus ist "${focused.wmClass}", kein Editor. Es wurde nichts getippt.`,
      focused: { wmClass: focused.wmClass, title: focused.title },
    };
  }

  // --key-delay hält die Eingabe langsam genug, dass der Editor sie
  // vollständig verarbeitet; zu schnelles Tippen verschluckt Zeichen.
  const typeResult = await run('ydotool', ['type', '--key-delay', '12', '--', text], 30_000);
  if (!typeResult.ok) {
    return {
      ok: false,
      reason: `ydotool konnte nicht tippen: ${typeResult.stderr.trim().split('\n')[0] ?? 'unbekannter Fehler'}`,
    };
  }

  if (options.submit) {
    // Vor dem Absenden erneut prüfen – der Fokus kann während des
    // Tippens gewechselt haben.
    const stillFocused = await focusedWindow();
    if (!stillFocused || !looksLikeEditor(stillFocused.wmClass)) {
      return {
        ok: false,
        reason: 'Text wurde getippt, aber der Fokus hat gewechselt – nicht abgeschickt',
        focused: stillFocused ? { wmClass: stillFocused.wmClass, title: stillFocused.title } : null,
      };
    }
    // 28 ist der Tastencode für Enter (KEY_ENTER).
    await run('ydotool', ['key', '28:1', '28:0'], 5000);
  }

  log.info(`${text.length} Zeichen in "${focused.wmClass}" getippt`);
  return { ok: true, typed: text, target: { wmClass: focused.wmClass, title: focused.title } };
}

/** Listet Editor-Fenster, damit die App ein Ziel anbieten kann. */
export async function editorWindows() {
  if (!(await bridgeAvailable())) return [];
  const windows = await listWindows();
  return windows.filter((w) => looksLikeEditor(w.wmClass));
}

export async function readiness() {
  const [ydotoolPresent, bridge] = await Promise.all([isAvailable('ydotool'), bridgeAvailable(true)]);
  const daemon = existsSync(ydotoolSocket());
  const editors = bridge ? await editorWindows() : [];

  return {
    ydotool: ydotoolPresent && daemon,
    bridge,
    editorWindows: editors.map((w) => ({ id: w.id, wmClass: w.wmClass, title: w.title, focused: w.focused })),
    usable: ydotoolPresent && daemon && bridge && editors.length > 0,
  };
}
