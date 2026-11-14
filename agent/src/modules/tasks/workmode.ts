import { EventEmitter } from 'node:events';
import { run } from '../../util/exec.ts';
import { logger } from '../../util/log.ts';
import * as db from './db.ts';
import type { WorkModeState } from './types.ts';

const log = logger('tasks/workmode');

class WorkMode extends EventEmitter {
  status(): WorkModeState {
    const raw = db.getSetting('workMode');
    if (!raw) return { enabled: false, changedAt: 0 };
    try {
      return JSON.parse(raw) as WorkModeState;
    } catch {
      return { enabled: false, changedAt: 0 };
    }
  }

  async set(enabled: boolean): Promise<WorkModeState> {
    const state: WorkModeState = { enabled, changedAt: Date.now() };
    db.setSetting('workMode', JSON.stringify(state));
    await applyGnome(enabled);
    log.info(enabled ? 'Work-Mode an' : 'Work-Mode aus');
    this.emit('changed', state);
    return state;
  }

  async toggle(): Promise<WorkModeState> {
    return this.set(!this.status().enabled);
  }
}

async function applyGnome(enabled: boolean): Promise<void> {
  const result = await run('gsettings', [
    'set',
    'org.gnome.desktop.notifications',
    'show-banners',
    enabled ? 'false' : 'true',
  ]);
  if (!result.ok) {
    log.warn(`GNOME-Benachrichtigungen ließen sich nicht umstellen: ${result.stderr.trim()}`);
  }
}

export const workmode = new WorkMode();

export function setEnabled(enabled: boolean): Promise<WorkModeState> {
  return workmode.set(enabled);
}
