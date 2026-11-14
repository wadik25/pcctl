import { run, runOrThrow } from '../util/exec.ts';
import { logger } from '../util/log.ts';

const log = logger('power');

/**
 * Energieaktionen laufen über logind (org.freedesktop.login1) – das ist der
 * Weg, den auch GNOME nutzt. Für den angemeldeten Benutzer ist dafür kein
 * sudo nötig (CanPowerOff wurde auf diesem System mit "yes" bestätigt).
 */

const LOGIN1 = [
  '--system',
  '--dest',
  'org.freedesktop.login1',
  '--object-path',
  '/org/freedesktop/login1',
];

async function login1(method: string, ...args: string[]): Promise<void> {
  await runOrThrow('gdbus', ['call', ...LOGIN1, '--method', `org.freedesktop.login1.Manager.${method}`, ...args]);
}

/** Fragt logind, ob eine Aktion erlaubt ist ("yes" | "no" | "challenge"). */
async function canDo(method: string): Promise<string> {
  const r = await run('gdbus', ['call', ...LOGIN1, '--method', `org.freedesktop.login1.Manager.Can${method}`]);
  const match = r.stdout.match(/'([^']+)'/);
  return match?.[1] ?? 'no';
}

/**
 * Verzögertes Ausführen erlaubt es der API, noch eine Antwort zu senden,
 * bevor das System heruntergefahren wird.
 */
function deferred(action: () => Promise<void>, delayMs: number) {
  setTimeout(() => {
    action().catch((err) => log.error(`Aktion fehlgeschlagen: ${(err as Error).message}`));
  }, delayMs);
}

export async function powerOff(delayMs = 500) {
  log.warn('System wird heruntergefahren');
  deferred(() => login1('PowerOff', 'true'), delayMs);
  return { scheduled: true, action: 'poweroff' as const, delayMs };
}

export async function reboot(delayMs = 500) {
  log.warn('System wird neu gestartet');
  deferred(() => login1('Reboot', 'true'), delayMs);
  return { scheduled: true, action: 'reboot' as const, delayMs };
}

export async function suspend(delayMs = 500) {
  log.info('System wird in den Ruhezustand versetzt');
  deferred(() => login1('Suspend', 'true'), delayMs);
  return { scheduled: true, action: 'suspend' as const, delayMs };
}

export async function lockSession() {
  await runOrThrow('loginctl', ['lock-session']);
  log.info('Sitzung gesperrt');
  return { locked: true };
}

// ---------------------------------------------------------------- Sleep-Timer

type Timer = {
  id: string;
  action: 'poweroff' | 'reboot' | 'suspend';
  firesAt: number;
  handle: NodeJS.Timeout;
};

let activeTimer: Timer | null = null;

const actions = { poweroff: powerOff, reboot, suspend } as const;

/** Plant eine Energieaktion für später. Ein zweiter Aufruf ersetzt den alten Timer. */
export function scheduleAction(action: Timer['action'], minutes: number) {
  cancelScheduled();

  const delayMs = Math.round(minutes * 60_000);
  const firesAt = Date.now() + delayMs;
  const id = `${action}-${firesAt}`;

  const handle = setTimeout(() => {
    activeTimer = null;
    void actions[action](0);
  }, delayMs);

  activeTimer = { id, action, firesAt, handle };
  log.info(`Timer gesetzt: ${action} in ${minutes} Minuten`);
  return describeTimer(activeTimer);
}

export function cancelScheduled() {
  if (!activeTimer) return { cancelled: false };
  clearTimeout(activeTimer.handle);
  log.info(`Timer abgebrochen: ${activeTimer.action}`);
  activeTimer = null;
  return { cancelled: true };
}

export function scheduledAction() {
  return activeTimer ? describeTimer(activeTimer) : null;
}

function describeTimer(timer: Timer) {
  return {
    id: timer.id,
    action: timer.action,
    firesAt: timer.firesAt,
    remainingSeconds: Math.max(0, Math.round((timer.firesAt - Date.now()) / 1000)),
  };
}

export async function capabilities() {
  const [poweroff, rebootCap, suspendCap] = await Promise.all([
    canDo('PowerOff'),
    canDo('Reboot'),
    canDo('Suspend'),
  ]);
  return { poweroff, reboot: rebootCap, suspend: suspendCap };
}
