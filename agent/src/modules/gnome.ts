import { run } from '../util/exec.ts';
import { logger } from '../util/log.ts';

const log = logger('gnome');

/**
 * Client für die Extension pcctl-bridge@wadik.
 *
 * Unter Wayland gibt es keine Möglichkeit, aus einem Hintergrundprozess das
 * fokussierte Fenster oder die Fensterliste zu erfragen: org.gnome.Shell.Eval
 * ist seit GNOME 41 gesperrt (liefert hier (false, '')). Die Extension stellt
 * deshalb ein eigenes, eng begrenztes D-Bus-Interface bereit.
 */

const DEST = 'org.gnome.Shell';
const OBJECT_PATH = '/org/pcctl/Bridge';
const INTERFACE = 'org.pcctl.Bridge';

export type WindowInfo = {
  id: number;
  pid: number;
  wmClass: string;
  title: string;
  focused: boolean;
  minimized: boolean;
  workspace: number;
};

/**
 * gdbus liefert Rückgabewerte als GVariant-Tupel, z. B. ('[{"id":1}]',).
 * Die Extension antwortet immer mit einer JSON-Zeichenkette.
 */
function parseVariantString(stdout: string): string | null {
  const trimmed = stdout.trim();
  const match = trimmed.match(/^\('(.*)',?\)$/s);
  if (!match) return null;
  // Escapes aus der GVariant-Darstellung zurücknehmen.
  return match[1]!.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

async function call<T>(method: string, args: string[] = [], fallback: T): Promise<T> {
  const r = await run(
    'gdbus',
    ['call', '--session', '--dest', DEST, '--object-path', OBJECT_PATH, '--method', `${INTERFACE}.${method}`, ...args],
    5000,
  );

  if (!r.ok) {
    log.debug(`${method} nicht erreichbar: ${r.stderr.trim().split('\n')[0] ?? ''}`);
    return fallback;
  }

  const payload = parseVariantString(r.stdout);
  if (payload === null) return fallback;

  try {
    return JSON.parse(payload) as T;
  } catch (err) {
    log.warn(`Antwort von ${method} ist kein gültiges JSON: ${(err as Error).message}`);
    return fallback;
  }
}

let availabilityChecked = false;
let available = false;

/** Prüft, ob die Extension geladen und erreichbar ist. */
export async function bridgeAvailable(recheck = false, quiet = false): Promise<boolean> {
  if (availabilityChecked && !recheck) return available;
  const r = await run(
    'gdbus',
    ['call', '--session', '--dest', DEST, '--object-path', OBJECT_PATH, '--method', `${INTERFACE}.Ping`],
    4000,
  );
  available = r.ok;
  availabilityChecked = true;
  if (!quiet) {
    if (!available) {
      log.warn('GNOME-Extension pcctl-bridge nicht erreichbar – Fensterfunktionen eingeschränkt');
    } else {
      log.info('GNOME-Extension pcctl-bridge erreichbar');
    }
  }
  return available;
}

/** Der Agent startet oft vor gnome-shell; nach dem Login noch einmal nachfassen. */
export function retryUntilAvailable(attempts = 8, delayMs = 5000) {
  const tick = async (left: number) => {
    const last = left <= 1;
    if (await bridgeAvailable(true, !last)) return;
    if (last) return;
    setTimeout(() => void tick(left - 1), delayMs).unref();
  };
  void tick(attempts);
}

export async function listWindows(): Promise<WindowInfo[]> {
  return call<WindowInfo[]>('ListWindows', [], []);
}

export async function focusedWindow(): Promise<WindowInfo | null> {
  return call<WindowInfo | null>('GetFocusedWindow', [], null);
}

export async function closeWindow(id: number): Promise<boolean> {
  return call<boolean>('CloseWindow', [String(id)], false);
}

export async function activateWindow(id: number): Promise<boolean> {
  return call<boolean>('ActivateWindow', [String(id)], false);
}

export async function status() {
  const ok = await bridgeAvailable(true);
  if (!ok) return { available: false, windowCount: 0, focused: null };
  const [windows, focused] = await Promise.all([listWindows(), focusedWindow()]);
  return { available: true, windowCount: windows.length, focused };
}
