import { readFileSync, readdirSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { listWindows, closeWindow, bridgeAvailable } from './gnome.ts';
import { logger } from '../util/log.ts';

const log = logger('apps');

/**
 * Anwendungen werden bevorzugt über ihre Fenster beendet (sauberes Schließen
 * per GNOME-Extension). Nur wenn kein Fenster zugeordnet werden kann, wird
 * auf Signale an den Prozess zurückgegriffen.
 */

export type AppEntry = {
  pid: number;
  name: string;
  /** Anzeigename aus dem Fenstertitel, falls vorhanden. */
  title: string | null;
  windowId: number | null;
  memoryBytes: number;
  cpuSeconds: number;
  protected: boolean;
};

function readProcName(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Resident Set Size in Bytes aus /proc/<pid>/statm. */
function readProcMemory(pid: number): number {
  try {
    const statm = readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/);
    const pages = Number(statm[1] ?? 0);
    return pages * 4096;
  } catch {
    return 0;
  }
}

function readProcCpuSeconds(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Der Prozessname kann Leerzeichen enthalten und steht in Klammern.
    const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
    const utime = Number(afterName[11] ?? 0);
    const stime = Number(afterName[12] ?? 0);
    return Math.round((utime + stime) / 100);
  } catch {
    return 0;
  }
}

function isProtected(name: string): boolean {
  const { protectedProcesses } = loadConfig();
  return protectedProcesses.some((entry) => entry === name);
}

/**
 * Listet beendbare Anwendungen. Grundlage sind – wenn verfügbar – die offenen
 * Fenster, weil eine reine Prozessliste unter GNOME hunderte Hintergrunddienste
 * enthält, die niemand aus einer Fernsteuerung heraus beenden will.
 */
export async function list(): Promise<{ source: 'windows' | 'processes'; apps: AppEntry[] }> {
  if (await bridgeAvailable()) {
    const windows = await listWindows();
    const seen = new Map<number, AppEntry>();

    for (const win of windows) {
      const existing = seen.get(win.pid);
      if (existing) continue;
      const name = readProcName(win.pid) ?? win.wmClass;
      seen.set(win.pid, {
        pid: win.pid,
        name,
        title: win.title,
        windowId: win.id,
        memoryBytes: readProcMemory(win.pid),
        cpuSeconds: readProcCpuSeconds(win.pid),
        protected: isProtected(name),
      });
    }

    return { source: 'windows', apps: [...seen.values()].sort((a, b) => b.memoryBytes - a.memoryBytes) };
  }

  // Ohne Extension: Prozesse mit nennenswertem Speicherverbrauch anzeigen.
  const apps: AppEntry[] = [];
  const minimumBytes = 50 * 1024 * 1024;

  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const name = readProcName(pid);
    if (!name) continue;
    const memoryBytes = readProcMemory(pid);
    if (memoryBytes < minimumBytes) continue;

    apps.push({
      pid,
      name,
      title: null,
      windowId: null,
      memoryBytes,
      cpuSeconds: readProcCpuSeconds(pid),
      protected: isProtected(name),
    });
  }

  return { source: 'processes', apps: apps.sort((a, b) => b.memoryBytes - a.memoryBytes).slice(0, 40) };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Beendet eine Anwendung in drei Stufen: Fenster schließen, dann SIGTERM,
 * zuletzt SIGKILL. Geschützte Prozesse werden abgelehnt, damit sich der
 * Desktop nicht aus Versehen selbst abschießt.
 */
export async function quit(pid: number, options: { force?: boolean } = {}) {
  const name = readProcName(pid);
  if (!name) throw new Error(`Prozess ${pid} existiert nicht`);

  if (isProtected(name)) {
    throw new Error(`"${name}" ist geschützt und wird nicht beendet`);
  }
  if (pid === process.pid) {
    throw new Error('Der Agent beendet sich nicht selbst');
  }

  // Stufe 1: Fenster regulär schließen lassen (ermöglicht Speichern-Dialoge).
  if (await bridgeAvailable()) {
    const windows = await listWindows();
    const own = windows.filter((w) => w.pid === pid);
    if (own.length) {
      for (const win of own) await closeWindow(win.id);
      await wait(1500);
      if (!processAlive(pid)) {
        log.info(`"${name}" (${pid}) über Fensterschließen beendet`);
        return { pid, name, method: 'window' as const, stopped: true };
      }
    }
  }

  // Stufe 2: höfliche Aufforderung.
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    throw new Error(`SIGTERM an ${pid} fehlgeschlagen: ${(err as Error).message}`);
  }

  for (let i = 0; i < 10 && processAlive(pid); i++) await wait(300);

  if (!processAlive(pid)) {
    log.info(`"${name}" (${pid}) per SIGTERM beendet`);
    return { pid, name, method: 'sigterm' as const, stopped: true };
  }

  // Stufe 3: nur auf ausdrückliche Anforderung.
  if (!options.force) {
    return { pid, name, method: 'sigterm' as const, stopped: false, hint: 'Reagiert nicht – force verwenden' };
  }

  process.kill(pid, 'SIGKILL');
  await wait(500);
  log.warn(`"${name}" (${pid}) per SIGKILL beendet`);
  return { pid, name, method: 'sigkill' as const, stopped: !processAlive(pid) };
}
