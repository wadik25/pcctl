import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { logger } from '../util/log.ts';

const log = logger('stats');

/**
 * Alle Werte kommen direkt aus sysfs/procfs – lm_sensors wird nicht benötigt.
 * hwmon-Geräte werden über ihren Namen aufgelöst, weil sich die Nummerierung
 * (hwmon0, hwmon1, …) nach einem Neustart verschieben kann.
 */

const HWMON_ROOT = '/sys/class/hwmon';

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function readNumber(path: string): number | null {
  const raw = readText(path);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Liefert alle hwmon-Verzeichnisse zu einem Treibernamen (z. B. "amdgpu"). */
function hwmonPaths(name: string): string[] {
  try {
    return readdirSync(HWMON_ROOT)
      .map((entry) => `${HWMON_ROOT}/${entry}`)
      .filter((dir) => readText(`${dir}/name`) === name);
  } catch {
    return [];
  }
}

function firstHwmon(name: string): string | null {
  return hwmonPaths(name)[0] ?? null;
}

/** Findet den DRM-Gerätepfad der AMD-GPU (card0/card1/… ist nicht stabil). */
function findAmdGpuDevice(): string | null {
  try {
    for (const entry of readdirSync('/sys/class/drm')) {
      if (!/^card\d+$/.test(entry)) continue;
      const device = `/sys/class/drm/${entry}/device`;
      if (existsSync(`${device}/gpu_busy_percent`)) return device;
    }
  } catch {
    /* ignorieren */
  }
  return null;
}

// ---------------------------------------------------------------- CPU

type CpuSample = { idle: number; total: number };
let lastCpuSample: CpuSample | null = null;

function sampleCpu(): CpuSample | null {
  const stat = readText('/proc/stat');
  if (!stat) return null;
  const line = stat.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 5) return null;
  const idle = (values[3] ?? 0) + (values[4] ?? 0); // idle + iowait
  const total = values.reduce((sum, v) => sum + v, 0);
  return { idle, total };
}

/**
 * CPU-Auslastung als Differenz zum letzten Aufruf. Der erste Aufruf nach dem
 * Start hat keine Vergleichsbasis und liefert deshalb null.
 */
function cpuUsagePercent(): number | null {
  const current = sampleCpu();
  if (!current) return null;
  const previous = lastCpuSample;
  lastCpuSample = current;
  if (!previous) return null;

  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return round((1 - idleDelta / totalDelta) * 100, 1);
}

function cpuTemps() {
  const dir = firstHwmon('k10temp');
  if (!dir) return {};
  const result: Record<string, number> = {};
  for (let i = 1; i <= 8; i++) {
    const value = readNumber(`${dir}/temp${i}_input`);
    if (value === null) continue;
    const label = readText(`${dir}/temp${i}_label`) ?? `temp${i}`;
    result[label] = round(value / 1000, 1);
  }
  return result;
}

function cpuFrequencyMhz(): number | null {
  const info = readText('/proc/cpuinfo');
  if (!info) return null;
  const speeds = info
    .split('\n')
    .filter((l) => l.startsWith('cpu MHz'))
    .map((l) => Number(l.split(':')[1]))
    .filter((n) => Number.isFinite(n));
  if (!speeds.length) return null;
  return round(speeds.reduce((a, b) => a + b, 0) / speeds.length, 0);
}

// ---------------------------------------------------------------- GPU

function gpuStats() {
  const hwmon = firstHwmon('amdgpu');
  const device = findAmdGpuDevice();

  const vramUsed = device ? readNumber(`${device}/mem_info_vram_used`) : null;
  const vramTotal = device ? readNumber(`${device}/mem_info_vram_total`) : null;

  return {
    tempC: hwmon ? divideOrNull(readNumber(`${hwmon}/temp1_input`), 1000, 1) : null,
    // Manche Karten liefern nur power1_average, andere nur power1_input.
    powerW: hwmon
      ? divideOrNull(readNumber(`${hwmon}/power1_average`) ?? readNumber(`${hwmon}/power1_input`), 1_000_000, 1)
      : null,
    powerCapW: hwmon ? divideOrNull(readNumber(`${hwmon}/power1_cap`), 1_000_000, 0) : null,
    fanRpm: hwmon ? readNumber(`${hwmon}/fan1_input`) : null,
    usagePercent: device ? readNumber(`${device}/gpu_busy_percent`) : null,
    vramUsedBytes: vramUsed,
    vramTotalBytes: vramTotal,
    vramPercent: vramUsed !== null && vramTotal ? round((vramUsed / vramTotal) * 100, 1) : null,
    coreClockMhz: hwmon ? divideOrNull(readNumber(`${hwmon}/freq1_input`), 1_000_000, 0) : null,
    memClockMhz: hwmon ? divideOrNull(readNumber(`${hwmon}/freq2_input`), 1_000_000, 0) : null,
  };
}

// ---------------------------------------------------------------- Speicher

function memoryStats() {
  const info = readText('/proc/meminfo');
  if (!info) return null;

  const values = new Map<string, number>();
  for (const line of info.split('\n')) {
    const [key, rest] = line.split(':');
    if (!key || !rest) continue;
    const kb = Number(rest.trim().split(/\s+/)[0]);
    if (Number.isFinite(kb)) values.set(key, kb * 1024);
  }

  const total = values.get('MemTotal') ?? 0;
  const available = values.get('MemAvailable') ?? 0;
  const swapTotal = values.get('SwapTotal') ?? 0;
  const swapFree = values.get('SwapFree') ?? 0;
  const used = total - available;

  return {
    totalBytes: total,
    usedBytes: used,
    availableBytes: available,
    usagePercent: total ? round((used / total) * 100, 1) : null,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapTotal - swapFree,
  };
}

// ---------------------------------------------------------------- Datenträger

function diskTemps() {
  const drives: Array<{ name: string; tempC: number }> = [];
  for (const dir of hwmonPaths('nvme')) {
    const temp = readNumber(`${dir}/temp1_input`);
    if (temp === null) continue;
    const model = readText(`${dir}/device/model`) ?? 'NVMe';
    drives.push({ name: model.trim(), tempC: round(temp / 1000, 1) });
  }
  return drives;
}

/** Board-Sensoren des Gigabyte-Boards. Die Kanäle sind unbeschriftet. */
function boardTemps() {
  const dir = firstHwmon('gigabyte_wmi');
  if (!dir) return [];
  const temps: Array<{ channel: number; tempC: number }> = [];
  for (let i = 1; i <= 8; i++) {
    const value = readNumber(`${dir}/temp${i}_input`);
    if (value === null) continue;
    temps.push({ channel: i, tempC: round(value / 1000, 1) });
  }
  return temps;
}

// ---------------------------------------------------------------- Netzwerk

type NetSample = { rx: number; tx: number; at: number };
const lastNetSamples = new Map<string, NetSample>();

function networkStats() {
  const raw = readText('/proc/net/dev');
  if (!raw) return [];

  const now = Date.now();
  const interfaces: Array<{
    name: string;
    rxBytes: number;
    txBytes: number;
    rxRateBps: number | null;
    txRateBps: number | null;
    up: boolean;
  }> = [];

  for (const line of raw.split('\n').slice(2)) {
    const [namePart, dataPart] = line.split(':');
    if (!namePart || !dataPart) continue;
    const name = namePart.trim();
    if (name === 'lo') continue;

    const fields = dataPart.trim().split(/\s+/).map(Number);
    const rx = fields[0] ?? 0;
    const tx = fields[8] ?? 0;

    const previous = lastNetSamples.get(name);
    lastNetSamples.set(name, { rx, tx, at: now });

    const elapsedSec = previous ? (now - previous.at) / 1000 : 0;
    const rxRate = previous && elapsedSec > 0 ? Math.max(0, (rx - previous.rx) / elapsedSec) : null;
    const txRate = previous && elapsedSec > 0 ? Math.max(0, (tx - previous.tx) / elapsedSec) : null;

    interfaces.push({
      name,
      rxBytes: rx,
      txBytes: tx,
      rxRateBps: rxRate === null ? null : Math.round(rxRate),
      txRateBps: txRate === null ? null : Math.round(txRate),
      up: readText(`/sys/class/net/${name}/operstate`) === 'up',
    });
  }

  return interfaces;
}

// ---------------------------------------------------------------- Hilfsfunktionen

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function divideOrNull(value: number | null, divisor: number, digits: number): number | null {
  return value === null ? null : round(value / divisor, digits);
}

// ---------------------------------------------------------------- Öffentliche API

export type Snapshot = ReturnType<typeof snapshot>;

export function snapshot() {
  const uptimeRaw = readText('/proc/uptime');
  const loadRaw = readText('/proc/loadavg');

  return {
    timestamp: Date.now(),
    cpu: {
      usagePercent: cpuUsagePercent(),
      temps: cpuTemps(),
      frequencyMhz: cpuFrequencyMhz(),
      cores: readdirSync('/sys/devices/system/cpu').filter((e) => /^cpu\d+$/.test(e)).length,
    },
    gpu: gpuStats(),
    memory: memoryStats(),
    disks: diskTemps(),
    board: boardTemps(),
    network: networkStats(),
    uptimeSeconds: uptimeRaw ? Math.round(Number(uptimeRaw.split(' ')[0])) : null,
    loadAverage: loadRaw ? loadRaw.split(' ').slice(0, 3).map(Number) : null,
  };
}

/** Kompakte Fassung für Widgets – bewusst klein gehalten. */
export function compactSnapshot() {
  const full = snapshot();
  const cpuTemp = full.cpu.temps['Tctl'] ?? Object.values(full.cpu.temps)[0] ?? null;
  return {
    timestamp: full.timestamp,
    cpuTempC: cpuTemp,
    cpuUsagePercent: full.cpu.usagePercent,
    gpuTempC: full.gpu.tempC,
    gpuUsagePercent: full.gpu.usagePercent,
    memoryUsagePercent: full.memory?.usagePercent ?? null,
    uptimeSeconds: full.uptimeSeconds,
  };
}

/** Einmaliges Aufwärmen, damit der erste CPU-Wert nicht null ist. */
export function warmUp() {
  // cpuUsagePercent() legt die Vergleichsbasis an – sampleCpu() allein liest nur.
  cpuUsagePercent();
  networkStats();
  const found = {
    k10temp: !!firstHwmon('k10temp'),
    amdgpu: !!firstHwmon('amdgpu'),
    gigabyte_wmi: !!firstHwmon('gigabyte_wmi'),
    nvme: hwmonPaths('nvme').length,
  };
  log.info('Sensoren erkannt', found);
}
