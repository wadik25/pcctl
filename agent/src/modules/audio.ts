import { run, runOrThrow } from '../util/exec.ts';
import { logger } from '../util/log.ts';

const log = logger('audio');

/**
 * Audio läuft über PipeWire/WirePlumber. wpctl arbeitet mit den Platzhaltern
 * @DEFAULT_AUDIO_SOURCE@ (Mikrofon) und @DEFAULT_AUDIO_SINK@ (Wiedergabe),
 * sodass ein Gerätewechsel keine Anpassung erfordert.
 */

const SOURCE = '@DEFAULT_AUDIO_SOURCE@';
const SINK = '@DEFAULT_AUDIO_SINK@';

/** wpctl gibt z. B. "Volume: 0.71 [MUTED]" aus. */
function parseVolume(output: string) {
  const volumeMatch = output.match(/Volume:\s*([\d.]+)/);
  return {
    volume: volumeMatch ? Math.round(Number(volumeMatch[1]) * 100) : null,
    muted: /\[MUTED\]/.test(output),
  };
}

async function readState(target: string) {
  const r = await run('wpctl', ['get-volume', target], 4000);
  if (!r.ok) return { volume: null, muted: null, available: false };
  return { ...parseVolume(r.stdout), available: true };
}

export async function status() {
  const [mic, output] = await Promise.all([readState(SOURCE), readState(SINK)]);
  return { microphone: mic, output };
}

export async function setMicMuted(muted: boolean) {
  await runOrThrow('wpctl', ['set-mute', SOURCE, muted ? '1' : '0']);
  log.info(`Mikrofon ${muted ? 'stumm' : 'aktiv'}`);
  return readState(SOURCE);
}

export async function toggleMicMute() {
  await runOrThrow('wpctl', ['set-mute', SOURCE, 'toggle']);
  const state = await readState(SOURCE);
  log.info(`Mikrofon umgeschaltet → ${state.muted ? 'stumm' : 'aktiv'}`);
  return state;
}

export async function setOutputMuted(muted: boolean) {
  await runOrThrow('wpctl', ['set-mute', SINK, muted ? '1' : '0']);
  return readState(SINK);
}

export async function toggleOutputMute() {
  await runOrThrow('wpctl', ['set-mute', SINK, 'toggle']);
  return readState(SINK);
}

/** Lautstärke in Prozent. Wird auf 0–100 begrenzt, um Übersteuerung zu vermeiden. */
export async function setVolume(target: 'output' | 'microphone', percent: number) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const node = target === 'output' ? SINK : SOURCE;
  await runOrThrow('wpctl', ['set-volume', node, `${clamped}%`]);
  return readState(node);
}

export async function adjustVolume(target: 'output' | 'microphone', deltaPercent: number) {
  const node = target === 'output' ? SINK : SOURCE;
  const direction = deltaPercent >= 0 ? '+' : '-';
  await runOrThrow('wpctl', ['set-volume', '-l', '1.0', node, `${Math.abs(deltaPercent)}%${direction}`]);
  return readState(node);
}

// ---------------------------------------------------------------- Medien (MPRIS)

/**
 * Mediensteuerung über MPRIS. playerctl ist auf diesem System nicht installiert,
 * deshalb wird direkt mit D-Bus gearbeitet.
 */
async function mprisPlayers(): Promise<string[]> {
  const r = await run('gdbus', [
    'call',
    '--session',
    '--dest',
    'org.freedesktop.DBus',
    '--object-path',
    '/org/freedesktop/DBus',
    '--method',
    'org.freedesktop.DBus.ListNames',
  ]);
  if (!r.ok) return [];
  return [...r.stdout.matchAll(/'(org\.mpris\.MediaPlayer2\.[^']+)'/g)].map((m) => m[1]!);
}

async function mprisCall(player: string, method: string) {
  return run('gdbus', [
    'call',
    '--session',
    '--dest',
    player,
    '--object-path',
    '/org/mpris/MediaPlayer2',
    '--method',
    `org.mpris.MediaPlayer2.Player.${method}`,
  ]);
}

/** Schickt einen Medienbefehl an alle laufenden Player. */
export async function mediaControl(action: 'PlayPause' | 'Next' | 'Previous' | 'Pause' | 'Play' | 'Stop') {
  const players = await mprisPlayers();
  if (!players.length) return { players: [], applied: false };

  await Promise.all(players.map((player) => mprisCall(player, action)));
  log.info(`Medienbefehl ${action} an ${players.length} Player`);
  return { players, applied: true };
}

export async function mediaStatus() {
  const players = await mprisPlayers();
  const details = await Promise.all(
    players.map(async (player) => {
      const r = await run('gdbus', [
        'call',
        '--session',
        '--dest',
        player,
        '--object-path',
        '/org/mpris/MediaPlayer2',
        '--method',
        'org.freedesktop.DBus.Properties.Get',
        'org.mpris.MediaPlayer2.Player',
        'PlaybackStatus',
      ]);
      const state = r.stdout.match(/'([^']+)'/)?.[1] ?? 'Unknown';
      return { player: player.replace('org.mpris.MediaPlayer2.', ''), state };
    }),
  );
  return { players: details };
}
