import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, isAvailable } from '../util/exec.ts';
import { CONFIG_DIR, loadConfig } from '../config.ts';
import { logger } from '../util/log.ts';

const log = logger('rgb');

/**
 * RGB-Steuerung über OpenRGB.
 *
 * Was OpenRGB hier sieht, ist der ITE-Controller des Gigabyte-Boards
 * (Back-I/O, PCIe, 12V-Leiste, Digital-LED-Header).
 *
 * Der be-quiet-Hub aus dem Pure Base 500FX ist ein eigenes Steuergerät:
 * ohne 5V-ARGB-Kabel am D_LED-Header und ohne Umschalten (LED-Taste
 * am Gehäuse ca. 3 s halten) bleibt er auf seiner internen Animation
 * und taucht in OpenRGB nicht auf. Der Hub hat kein USB.
 */

const STATE_FILE = join(CONFIG_DIR, 'rgb-state.json');

type RgbState = { on: boolean; color: string; changedAt: number };

function loadState(): RgbState {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RgbState;
    } catch {
      /* Standard verwenden */
    }
  }
  return { on: true, color: 'FFFFFF', changedAt: 0 };
}

function saveState(next: RgbState) {
  try {
    writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    log.error(`Zustand nicht speicherbar: ${(err as Error).message}`);
  }
}

let state = loadState();

/** Akzeptiert "FF0000" oder "#FF0000" und liefert das von OpenRGB erwartete Format. */
function normalizeColor(input: string): string {
  const hex = input.replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(hex)) {
    throw new Error(`Ungültige Farbe "${input}" – erwartet wird ein Hex-Wert wie FF0000`);
  }
  return hex;
}

export async function available(): Promise<boolean> {
  return isAvailable('openrgb');
}

export async function listDevices() {
  if (!(await available())) return { available: false, devices: [] as string[] };

  const r = await run('openrgb', ['--list-devices'], 15_000);
  if (!r.ok) {
    log.warn('openrgb --list-devices fehlgeschlagen – ist acpi_enforce_resources=lax gesetzt?');
    return { available: true, devices: [], error: r.stderr.trim().split('\n')[0] };
  }

  // Geräte stehen als "0: Gigabyte B550 ..." am Zeilenanfang.
  const devices = r.stdout
    .split('\n')
    .filter((line) => /^\d+:\s/.test(line))
    .map((line) => line.trim());

  return { available: true, devices };
}

export async function setColor(color: string) {
  const hex = normalizeColor(color);
  if (!(await available())) throw new Error('OpenRGB ist nicht installiert');

  const { rgbZones, rgbLedCount } = loadConfig();
  const args: string[] = [];
  for (const zone of rgbZones) {
    args.push('--device', '0', '--zone', String(zone), '--size', String(rgbLedCount), '--color', hex, '--mode', 'direct');
  }
  // 12V-RGB-Stecker (Zone 5), falls der Hub dort hängt statt am ARGB-Header.
  args.push('--device', '0', '--zone', '5', '--color', hex, '--mode', 'static');

  const r = await run('openrgb', args, 20_000);
  if (!r.ok) {
    throw new Error(`OpenRGB konnte die Farbe nicht setzen: ${r.stderr.trim().split('\n')[0] ?? 'unbekannter Fehler'}`);
  }

  const isOff = hex === '000000';
  state = {
    on: !isOff,
    color: isOff ? state.color : hex,
    changedAt: Date.now(),
  };
  saveState(state);

  log.info(`RGB auf #${hex} gesetzt (Zonen ${rgbZones.join(',')}, ${rgbLedCount} LEDs)`);
  return { color: hex, on: state.on, zones: rgbZones, ledCount: rgbLedCount };
}

export async function off() {
  const result = await setColor('000000');
  log.info('RGB ausgeschaltet');
  return result;
}

/** Schaltet auf die zuletzt genutzte Farbe zurück. */
export async function on() {
  return setColor(state.color);
}

export async function toggle() {
  return state.on ? off() : on();
}

/** Zustand ohne Aufruf von OpenRGB – für den laufenden Rundruf. */
export function quickState() {
  return { on: state.on, color: state.color, changedAt: state.changedAt };
}

export async function status() {
  const devices = await listDevices();
  return {
    available: devices.available,
    deviceCount: devices.devices.length,
    devices: devices.devices,
    on: state.on,
    color: state.color,
    changedAt: state.changedAt,
    note: 'OpenRGB steuert nur die Mainboard-LEDs. Der be-quiet-Hub läuft eigenständig, bis das 5V-ARGB-Kabel am D_LED-Header hängt und die LED-Taste 3 s gehalten wird.',
  };
}
