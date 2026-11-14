import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type RunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Führt ein Kommando ohne Shell aus. Argumente werden als Array übergeben,
 * damit Werte aus der API niemals als Shell-Syntax interpretiert werden können.
 */
/** PATH, den systemd-Benutzerdienste sonst nicht haben (claude, lokale Tools). */
export function userPath(): string {
  const home = homedir();
  const extras = [`${home}/.local/bin`, `${home}/.cargo/bin`, `${home}/.bun/bin`, `${home}/bin`];
  const current = process.env.PATH ?? '/usr/local/bin:/usr/bin';
  const missing = extras.filter((dir) => !current.split(':').includes(dir));
  return missing.length ? `${missing.join(':')}:${current}` : current;
}

function toolEnv(): NodeJS.ProcessEnv {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return {
    ...process.env,
    PATH: userPath(),
    YDOTOOL_SOCKET: process.env.YDOTOOL_SOCKET ?? join(runtime, '.ydotool_socket'),
  };
}

export function run(cmd: string, args: string[] = [], timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', env: toolEnv() }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolve({
        ok: !err,
        code,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
  });
}

/** Wie run(), wirft aber bei Fehlschlag – für Stellen, an denen ein Fehler die Aktion abbrechen soll. */
export async function runOrThrow(cmd: string, args: string[] = [], timeoutMs = 10_000): Promise<string> {
  const r = await run(cmd, args, timeoutMs);
  if (!r.ok) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n')[0] ?? '';
    throw new Error(`${cmd} ${args.join(' ')} fehlgeschlagen (Code ${r.code}): ${detail}`);
  }
  return r.stdout;
}

/** Prüft einmalig, ob ein Programm im PATH vorhanden ist. */
const availabilityCache = new Map<string, Promise<boolean>>();

export function isAvailable(cmd: string): Promise<boolean> {
  let cached = availabilityCache.get(cmd);
  if (!cached) {
    cached = run('sh', ['-c', `command -v ${JSON.stringify(cmd)}`], 3000).then((r) => r.ok);
    availabilityCache.set(cmd, cached);
  }
  return cached;
}
