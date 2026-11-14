import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, isAvailable } from '../util/exec.ts';
import { CONFIG_DIR, loadConfig } from '../config.ts';
import { logger } from '../util/log.ts';
import * as gnomeLayout from './gnome-layout.ts';

const log = logger('display');

/**
 * Monitorsteuerung über DDC/CI.
 *
 * Zwei Verdunkelungsarten:
 *   brightness – VCP 0x10 auf 0. Der Monitor bleibt elektrisch an und damit
 *                über I2C erreichbar; das Zurückschalten ist garantiert.
 *   standby    – VCP 0xD6 auf 4. Spart mehr Strom, aber manche Monitore
 *                schalten im Standby den I2C-Kanal ab und nehmen dann keinen
 *                Einschaltbefehl mehr entgegen.
 *
 * Deshalb ist "brightness" der Standard. In beiden Fällen gibt es eine
 * ausdrückliche Gegenaktion – es wird nicht darauf vertraut, dass eine
 * Mausbewegung den Monitor aufweckt.
 */

const VCP_BRIGHTNESS = '10';
const VCP_POWER_MODE = 'D6';
const POWER_ON = '01';
const POWER_STANDBY = '04';

const STATE_FILE = join(CONFIG_DIR, 'display-state.json');

export type DisplayInfo = {
  bus: number;
  model: string;
  serial: string | null;
  drmConnector: string | null;
  gdctlConnector: string | null;
};

type SavedState = {
  blanked: boolean;
  mode: 'brightness' | 'standby' | 'mixed';
  /** Helligkeit je Bus vor dem Verdunkeln – nötig für das Wiederherstellen. */
  brightnessByBus: Record<string, number>;
  /** Anschlüsse, die über GNOME abgeschaltet wurden, weil DDC wirkungslos ist. */
  disabledConnectors: string[];
  savedLayout: gnomeLayout.LayoutMonitor[];
  changedAt: number;
};

/**
 * Der Zustand liegt auf der Platte, damit ein Neustart des Dienstes bei
 * dunklen Monitoren nicht die gespeicherte Helligkeit verliert.
 */
function loadState(): SavedState {
  const empty: SavedState = {
    blanked: false,
    mode: 'brightness',
    brightnessByBus: {},
    disabledConnectors: [],
    savedLayout: [],
    changedAt: 0,
  };
  if (existsSync(STATE_FILE)) {
    try {
      const stored = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<SavedState>;
      return {
        ...empty,
        ...stored,
        brightnessByBus: stored.brightnessByBus ?? {},
        disabledConnectors: stored.disabledConnectors ?? [],
        savedLayout: stored.savedLayout ?? [],
      };
    } catch (err) {
      log.warn(`display-state.json unlesbar: ${(err as Error).message}`);
    }
  }
  return empty;
}

function saveState(state: SavedState) {
  try {
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    log.error(`Zustand nicht speicherbar: ${(err as Error).message}`);
  }
}

let state = loadState();

// ---------------------------------------------------------------- Erkennung

let cachedDisplays: DisplayInfo[] | null = null;

/** Parst die Ausgabe von `ddcutil detect`. */
function parseDetect(output: string): DisplayInfo[] {
  const displays: DisplayInfo[] = [];
  // Blöcke beginnen mit "Display 1", Details sind eingerückt.
  for (const block of output.split(/\n(?=Display\s)/)) {
    const bus = block.match(/I2C bus:\s*\/dev\/i2c-(\d+)/)?.[1];
    if (!bus) continue;
    const drmConnector = block.match(/DRM(?:_connector| connector):\s*(\S+)/)?.[1] ?? null;
    displays.push({
      bus: Number(bus),
      model:
        block.match(/Model:\s*(.+)/)?.[1]?.trim() ||
        block.match(/Monitor:\s*(.+)/)?.[1]?.trim() ||
        'Unbekannt',
      serial: block.match(/Serial number:\s*(.+)/)?.[1]?.trim() || null,
      drmConnector,
      gdctlConnector: drmConnector ? gnomeLayout.toGdctlConnector(drmConnector) : null,
    });
  }
  return displays;
}

export async function detect(force = false): Promise<DisplayInfo[]> {
  if (cachedDisplays && !force) return cachedDisplays;
  if (!(await isAvailable('ddcutil'))) {
    log.warn('ddcutil nicht installiert – Monitorsteuerung deaktiviert');
    return [];
  }

  // Die Erkennung fragt alle I2C-Busse ab und braucht deshalb länger.
  const r = await run('ddcutil', ['detect', '--brief'], 25_000);
  if (!r.ok) {
    log.error(`ddcutil detect fehlgeschlagen: ${r.stderr.trim().split('\n')[0] ?? ''}`);
    return [];
  }

  cachedDisplays = parseDetect(r.stdout);
  log.info(`${cachedDisplays.length} Monitor(e) erkannt`, cachedDisplays.map((d) => `Bus ${d.bus}: ${d.model}`));
  return cachedDisplays;
}

async function getVcp(bus: number, code: string): Promise<number | null> {
  const r = await run('ddcutil', ['--bus', String(bus), 'getvcp', code, '--brief'], 8000);
  if (!r.ok) return null;
  // Kurzformat: "VCP 10 C 75 100" → aktueller Wert an Position 3
  const parts = r.stdout.trim().split(/\s+/);
  const value = Number(parts[3]);
  return Number.isFinite(value) ? value : null;
}

async function setVcp(bus: number, code: string, value: string): Promise<boolean> {
  const r = await run('ddcutil', ['--bus', String(bus), 'setvcp', code, value], 8000);
  if (!r.ok) log.warn(`setvcp ${code}=${value} auf Bus ${bus} fehlgeschlagen: ${r.stderr.trim().split('\n')[0] ?? ''}`);
  return r.ok;
}

/** Manche Monitore bestätigen setvcp, ändern den Wert aber nicht (HKC 24E4). */
async function setBrightnessVerified(bus: number, percent: number): Promise<boolean> {
  const wrote = await setVcp(bus, VCP_BRIGHTNESS, String(percent));
  if (!wrote) return false;
  const read = await getVcp(bus, VCP_BRIGHTNESS);
  if (read === null) return false;
  return Math.abs(read - percent) <= 2;
}

// ---------------------------------------------------------------- Verdunkeln

export async function blank(modeOverride?: 'brightness' | 'standby') {
  const mode = modeOverride ?? loadConfig().displayBlankMode;
  const displays = await detect();
  if (!displays.length) throw new Error('Keine per DDC/CI steuerbaren Monitore gefunden');

  const brightnessByBus: Record<string, number> = { ...state.brightnessByBus };
  const results: Array<{ bus: number; model: string; ok: boolean; method: string }> = [];
  const compositorTargets: string[] = [];
  const savedLayout = await gnomeLayout.readLayout();

  for (const display of displays) {
    if (mode === 'standby') {
      const ok = await setVcp(display.bus, VCP_POWER_MODE, POWER_STANDBY);
      results.push({ bus: display.bus, model: display.model, ok, method: 'standby' });
      continue;
    }

    const current = await getVcp(display.bus, VCP_BRIGHTNESS);
    if (current !== null && current > 0) brightnessByBus[String(display.bus)] = current;

    const dimmed = await setBrightnessVerified(display.bus, 0);
    if (dimmed) {
      results.push({ bus: display.bus, model: display.model, ok: true, method: 'brightness' });
      continue;
    }

    if (display.gdctlConnector) {
      compositorTargets.push(display.gdctlConnector);
      results.push({ bus: display.bus, model: display.model, ok: true, method: 'compositor' });
    } else {
      results.push({ bus: display.bus, model: display.model, ok: false, method: 'none' });
    }
  }

  let compositorOk = true;
  if (compositorTargets.length) {
    compositorOk = await gnomeLayout.disableConnectors(compositorTargets);
  }

  state = {
    blanked: true,
    mode: compositorTargets.length ? 'mixed' : mode,
    brightnessByBus,
    disabledConnectors: compositorOk ? compositorTargets : [],
    savedLayout,
    changedAt: Date.now(),
  };
  saveState(state);

  log.info('Monitore verdunkelt', results);
  return { mode: state.mode, displays: results, state: publicState() };
}

export async function unblank() {
  const displays = await detect(true);
  const results: Array<{ bus: number; model: string; ok: boolean; restoredTo?: number }> = [];

  if (state.savedLayout.length) {
    await gnomeLayout.applyLayout(state.savedLayout);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  for (const display of displays) {
    if (state.mode === 'standby') {
      const ok = await setVcp(display.bus, VCP_POWER_MODE, POWER_ON);
      results.push({ bus: display.bus, model: display.model, ok });
    } else {
      const target = state.brightnessByBus[String(display.bus)] ?? 75;
      const ok = await setBrightnessVerified(display.bus, target);
      results.push({ bus: display.bus, model: display.model, ok, restoredTo: target });
    }
  }

  state = {
    ...state,
    blanked: false,
    disabledConnectors: [],
    savedLayout: [],
    changedAt: Date.now(),
  };
  saveState(state);

  log.info('Monitore eingeschaltet', results);
  return { mode: state.mode, displays: results, state: publicState() };
}

export async function toggle() {
  return state.blanked ? unblank() : blank();
}

export async function setBrightness(percent: number) {
  const displays = await detect();
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const results = [];
  for (const display of displays) {
    results.push({
      bus: display.bus,
      model: display.model,
      ok: await setBrightnessVerified(display.bus, clamped),
    });
  }
  if (clamped > 0) {
    state = { ...state, blanked: false };
    saveState(state);
  }
  return { brightness: clamped, displays: results };
}

/**
 * Liest aus, welche VCP-Werte die Monitore tatsächlich beherrschen. Damit lässt
 * sich vor dem Umschalten auf "standby" prüfen, ob D6 unterstützt wird.
 */
export async function capabilities() {
  const displays = await detect();
  const result = [];
  for (const display of displays) {
    const r = await run('ddcutil', ['--bus', String(display.bus), 'capabilities'], 20_000);
    const features = r.ok ? [...r.stdout.matchAll(/Feature:\s*([0-9A-F]{2})/gi)].map((m) => m[1]!.toUpperCase()) : [];
    result.push({
      bus: display.bus,
      model: display.model,
      supportsBrightness: features.includes(VCP_BRIGHTNESS),
      supportsPowerMode: features.includes(VCP_POWER_MODE),
      features,
    });
  }
  return result;
}

function publicState() {
  return { blanked: state.blanked, mode: state.mode, disabledConnectors: state.disabledConnectors, changedAt: state.changedAt };
}

/**
 * Zustand ohne jeden externen Aufruf – für den laufenden Rundruf über
 * WebSocket, der alle zwei Sekunden erfolgt und deshalb nichts kosten darf.
 */
export function quickState() {
  return { available: cachedDisplays !== null && cachedDisplays.length > 0, ...publicState() };
}

export async function status() {
  const displays = await detect();
  return {
    available: displays.length > 0,
    displays,
    ...publicState(),
  };
}
