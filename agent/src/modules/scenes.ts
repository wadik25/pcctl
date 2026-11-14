import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config.ts';
import * as audio from './audio.ts';
import * as display from './display.ts';
import * as rgb from './rgb.ts';
import * as power from './power.ts';
import { logger } from '../util/log.ts';

const log = logger('scenes');

/**
 * Szenen fassen mehrere Aktionen zu einem Knopfdruck zusammen – der eigentliche
 * Sinn der Homescreen-Widgets.
 *
 * Wichtig: Die Kette läuft weiter, wenn ein Schritt fehlschlägt. Wenn etwa
 * OpenRGB nicht erreichbar ist, sollen Mikrofon und Monitore trotzdem
 * geschaltet werden. Jeder Schritt wird einzeln zurückgemeldet.
 */

const SCENES_FILE = join(CONFIG_DIR, 'scenes.json');

export type Step =
  | { action: 'mic'; muted: boolean }
  | { action: 'micToggle' }
  | { action: 'outputMute'; muted: boolean }
  | { action: 'volume'; percent: number }
  | { action: 'display'; state: 'off' | 'on' }
  | { action: 'brightness'; percent: number }
  | { action: 'rgb'; state: 'off' | 'on'; color?: string }
  | { action: 'media'; command: 'PlayPause' | 'Pause' | 'Play' | 'Next' | 'Previous' }
  | { action: 'lock' }
  | { action: 'schedule'; powerAction: 'poweroff' | 'suspend' | 'reboot'; minutes: number }
  | { action: 'wait'; ms: number };

export type Scene = {
  id: string;
  name: string;
  icon: string;
  description?: string;
  steps: Step[];
};

const defaultScenes: Scene[] = [
  {
    id: 'feierabend',
    name: 'Feierabend',
    icon: 'moon',
    description: 'Mikrofon stumm, RGB aus, Monitore dunkel, Wiedergabe pausiert',
    steps: [
      { action: 'media', command: 'Pause' },
      { action: 'mic', muted: true },
      { action: 'rgb', state: 'off' },
      { action: 'display', state: 'off' },
    ],
  },
  {
    id: 'meeting',
    name: 'Meeting',
    icon: 'video',
    description: 'Mikrofon frei, Wiedergabe pausiert, Lautstärke auf ein angenehmes Maß',
    steps: [
      { action: 'media', command: 'Pause' },
      { action: 'mic', muted: false },
      { action: 'volume', percent: 40 },
    ],
  },
  {
    id: 'gaming',
    name: 'Gaming',
    icon: 'gamepad',
    description: 'RGB an, Monitore hell, Lautstärke hoch',
    steps: [
      { action: 'display', state: 'on' },
      { action: 'rgb', state: 'on' },
      { action: 'volume', percent: 70 },
    ],
  },
  {
    id: 'fokus',
    name: 'Fokus',
    icon: 'target',
    description: 'Mikrofon stumm, RGB gedämpft, Wiedergabe pausiert',
    steps: [
      { action: 'media', command: 'Pause' },
      { action: 'mic', muted: true },
      { action: 'rgb', state: 'on', color: '1A1A2E' },
    ],
  },
];

export function loadScenes(): Scene[] {
  if (existsSync(SCENES_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(SCENES_FILE, 'utf8')) as Scene[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (err) {
      log.warn(`scenes.json unlesbar, nutze Vorlagen: ${(err as Error).message}`);
    }
  }
  saveScenes(defaultScenes);
  return defaultScenes;
}

export function saveScenes(scenes: Scene[]) {
  writeFileSync(SCENES_FILE, `${JSON.stringify(scenes, null, 2)}\n`, { mode: 0o600 });
  return scenes;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runStep(step: Step): Promise<unknown> {
  switch (step.action) {
    case 'mic':
      return audio.setMicMuted(step.muted);
    case 'micToggle':
      return audio.toggleMicMute();
    case 'outputMute':
      return audio.setOutputMuted(step.muted);
    case 'volume':
      return audio.setVolume('output', step.percent);
    case 'display':
      return step.state === 'off' ? display.blank() : display.unblank();
    case 'brightness':
      return display.setBrightness(step.percent);
    case 'rgb':
      if (step.state === 'off') return rgb.off();
      return step.color ? rgb.setColor(step.color) : rgb.on();
    case 'media':
      return audio.mediaControl(step.command);
    case 'lock':
      return power.lockSession();
    case 'schedule':
      return power.scheduleAction(step.powerAction, step.minutes);
    case 'wait':
      await wait(Math.min(step.ms, 10_000));
      return { waited: step.ms };
    default: {
      // Erzwingt zur Übersetzungszeit, dass jede Aktion behandelt wird.
      const exhaustive: never = step;
      throw new Error(`Unbekannter Schritt: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export type StepResult = {
  step: Step;
  ok: boolean;
  result?: unknown;
  error?: string;
};

/**
 * Führt eine Szene aus. Fehlgeschlagene Schritte werden protokolliert,
 * brechen die Kette aber nicht ab.
 */
export async function runScene(id: string) {
  const scene = loadScenes().find((s) => s.id === id);
  if (!scene) throw new Error(`Szene "${id}" existiert nicht`);

  const results: StepResult[] = [];
  for (const step of scene.steps) {
    try {
      results.push({ step, ok: true, result: await runStep(step) });
    } catch (err) {
      const message = (err as Error).message;
      log.warn(`Schritt ${step.action} in Szene "${scene.name}" fehlgeschlagen: ${message}`);
      results.push({ step, ok: false, error: message });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  log.info(`Szene "${scene.name}" ausgeführt – ${results.length - failed}/${results.length} Schritte erfolgreich`);

  return {
    scene: { id: scene.id, name: scene.name },
    steps: results,
    allSucceeded: failed === 0,
  };
}
