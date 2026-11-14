import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './util/log.ts';

const log = logger('config');

export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'pcctl');
export const DATA_DIR = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'pcctl');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';
export type SttProvider = 'groq' | 'openai' | 'whisper-cpp';

export type Config = {
  /** Bearer-Token für alle API-Zugriffe. Wird beim ersten Start erzeugt. */
  token: string;
  port: number;
  /** Interface-Bindung. 0.0.0.0 ist in Ordnung, weil firewalld auf das Subnetz begrenzt. */
  host: string;
  /** Nur Anfragen aus diesen CIDR-Bereichen werden akzeptiert. */
  allowedNetworks: string[];
  /** Standardverhalten für "Monitore aus": brightness ist garantiert umkehrbar. */
  displayBlankMode: 'brightness' | 'standby';
  /**
   * OpenRGB-Zonen für den ARGB-Hub (Digital LED 1/2 am Mainboard).
   * Der be-quiet-Hub ist nur ein Verteiler, kein eigenes Gerät.
   */
  rgbZones: number[];
  /** LED-Anzahl je Digital-LED-Zone. Light Wings: 20 je Lüfter, Hub bis 6 Geräte. */
  rgbLedCount: number;
  /** Prozessnamen, die niemals beendet werden dürfen. */
  protectedProcesses: string[];
  /** MAC für Wake-on-LAN (Ethernet-Interface). */
  wolMac: string;
  wolBroadcast: string;
  /** NVIDIA NIM Key für Kimi-K3. Liegt nur in dieser Datei, nie im Quellcode. */
  nvidiaApiKey: string;
  nvidiaModel: string;
  llmReasoningEffort: ReasoningEffort;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  llmRetryDelayMs: number;
  groqApiKey: string;
  sttProvider: SttProvider;
  sttModel: string;
  sttTimeoutMs: number;
  taskConfidenceThreshold: number;
  messageDebounceMs: number;
};

const defaults: Config = {
  token: '',
  port: 8765,
  host: '0.0.0.0',
  allowedNetworks: ['192.168.1.0/24', '127.0.0.1/32'],
  displayBlankMode: 'brightness',
  rgbZones: [0, 1],
  rgbLedCount: 120,
  protectedProcesses: [
    'systemd',
    'gnome-shell',
    'gdm',
    'gnome-session-b',
    'pipewire',
    'pipewire-pulse',
    'wireplumber',
    'dbus-broker',
    'dbus-daemon',
    'Xwayland',
    'node',
    'ydotoold',
    'sshd',
    'kernel',
  ],
  // Platzhalter: eigene MAC-Adresse und Broadcast-Adresse in ~/.config/pcctl/config.json eintragen.
  wolMac: '00:00:00:00:00:00',
  wolBroadcast: '192.168.1.255',
  nvidiaApiKey: '',
  nvidiaModel: 'moonshotai/kimi-k3',
  llmReasoningEffort: 'low',
  llmTimeoutMs: 45_000,
  llmMaxRetries: 3,
  llmRetryDelayMs: 60_000,
  groqApiKey: '',
  sttProvider: 'groq',
  sttModel: 'whisper-large-v3-turbo',
  sttTimeoutMs: 30_000,
  taskConfidenceThreshold: 0.6,
  messageDebounceMs: 8_000,
};

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  let stored: Partial<Config> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      stored = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
    } catch (err) {
      log.error(`config.json unlesbar, nutze Standardwerte: ${(err as Error).message}`);
    }
  }

  const config: Config = { ...defaults, ...stored };

  const effort = config.llmReasoningEffort;
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'max') {
    config.llmReasoningEffort = 'low';
  }
  if (config.sttProvider !== 'groq' && config.sttProvider !== 'openai' && config.sttProvider !== 'whisper-cpp') {
    config.sttProvider = 'groq';
  }

  const debounceMigrated = stored.messageDebounceMs === 45_000;
  if (debounceMigrated) config.messageDebounceMs = defaults.messageDebounceMs;

  const timeoutMigrated = stored.llmTimeoutMs === 8_000;
  if (timeoutMigrated) config.llmTimeoutMs = defaults.llmTimeoutMs;

  const firstRun = !config.token;
  const schemaExtended = !('nvidiaApiKey' in stored) || !('groqApiKey' in stored);

  if (firstRun) {
    config.token = randomBytes(32).toString('base64url');
    log.info('Neues Zugriffs-Token erzeugt');
    persist(config);
  } else if (!existsSync(CONFIG_FILE) || schemaExtended || debounceMigrated || timeoutMigrated) {
    persist(config);
  }

  cached = config;
  return config;
}

function persist(config: Config) {
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
  log.info(`Konfiguration gespeichert: ${CONFIG_FILE}`);
}

export function saveConfig(patch: Partial<Config>): Config {
  const config = { ...loadConfig(), ...patch };
  cached = config;
  persist(config);
  return config;
}
