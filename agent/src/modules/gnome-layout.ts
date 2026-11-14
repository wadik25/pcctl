import { run } from '../util/exec.ts';
import { logger } from '../util/log.ts';

const log = logger('gnome-layout');

/**
 * GNOME-Monitorlayout über gdctl.
 *
 * Manche Monitore (hier der HKC) werben mit DDC, ignorieren Helligkeit aber
 * und fallen bei Power-Mode (VCP D6) komplett vom Bus. Dann bleibt nur,
 * das Videosignal über den Compositor wegzunehmen – der Monitor zeigt
 * „kein Signal“ und kommt mit dem gespeicherten Layout wieder.
 */

export type LayoutMonitor = {
  connector: string;
  x: number;
  y: number;
  primary: boolean;
  mode: string | null;
};

/** card1-HDMI-A-1 → HDMI-1, card1-DP-2 → DP-2 */
export function toGdctlConnector(drm: string): string {
  return drm.replace(/^card\d+-/, '').replace(/^HDMI-A-/, 'HDMI-');
}

export async function readLayout(): Promise<LayoutMonitor[]> {
  const r = await run('gdctl', ['show'], 8000);
  if (!r.ok) {
    log.warn(`gdctl show fehlgeschlagen: ${r.stderr.trim().split('\n')[0] ?? ''}`);
    return [];
  }
  return parseShow(r.stdout);
}

function parseShow(text: string): LayoutMonitor[] {
  const logical = text.split('Logical monitors:')[1];
  if (!logical) return [];

  const blocks = logical.split(/Logical monitor #\d+/).slice(1);
  const result: LayoutMonitor[] = [];

  for (const block of blocks) {
    const pos = block.match(/Position:\s*\((-?\d+),\s*(-?\d+)\)/);
    const primary = /Primary:\s*yes/i.test(block);
    const connector = block.match(/Monitors:[\s\S]*?\n[^\n]*\b([A-Z]+-\d+)\b/)?.[1];
    if (!connector || !pos) continue;
    result.push({
      connector,
      x: Number(pos[1]),
      y: Number(pos[2]),
      primary,
      mode: null,
    });
  }

  return result;
}

export async function applyLayout(monitors: LayoutMonitor[]): Promise<boolean> {
  if (!monitors.length) return false;

  const ordered = [...monitors].sort((a, b) => Number(b.primary) - Number(a.primary));
  const args: string[] = [];
  for (const monitor of ordered) {
    args.push('--logical-monitor');
    if (monitor.primary) args.push('--primary');
    args.push('--monitor', monitor.connector, '--x', String(monitor.x), '--y', String(monitor.y));
    if (monitor.mode) args.push('--mode', monitor.mode);
  }

  const r = await run('gdctl', ['set', ...args], 12_000);
  if (!r.ok) {
    log.warn(`gdctl set fehlgeschlagen: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`);
    return false;
  }
  log.info(
    'Monitorlayout gesetzt',
    ordered.map((m) => `${m.connector}@${m.x},${m.y}${m.primary ? ' primary' : ''}`),
  );
  return true;
}

/** Nimmt die genannten Anschlüsse aus dem aktuellen Layout; ein Monitor bleibt immer an. */
export async function disableConnectors(connectors: string[]): Promise<boolean> {
  const current = await readLayout();
  if (!current.length) return false;

  const remaining = current.filter((m) => !connectors.includes(m.connector));
  if (!remaining.length) {
    log.warn('Compositor-Verdunkeln abgebrochen – sonst wäre kein Monitor mehr aktiv');
    return false;
  }

  if (!remaining.some((m) => m.primary)) remaining[0]!.primary = true;
  return applyLayout(remaining);
}
