import { createSocket } from 'node:dgram';
import { readFileSync, readdirSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { logger } from '../util/log.ts';

const log = logger('wol');

/**
 * Wake-on-LAN.
 *
 * Wichtig für dieses System: Das Ethernet-Interface eno1 hat derzeit kein
 * Kabel (carrier=0), der Rechner hängt am WLAN. Über WLAN funktioniert WoL
 * praktisch nicht. Der Sendeweg ist hier vollständig umgesetzt, damit er
 * bereitsteht, sobald ein Kabel gesteckt und WoL im BIOS aktiviert ist.
 *
 * Das Magic Packet muss ohnehin von einem anderen Gerät kommen – das Handy
 * genügt, solange es im selben Netz ist. Dieser Endpunkt ist deshalb vor
 * allem für Tests und zum Wecken anderer Geräte gedacht.
 */

function macToBytes(mac: string): Buffer {
  const clean = mac.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length !== 12) throw new Error(`Ungültige MAC-Adresse: ${mac}`);
  return Buffer.from(clean, 'hex');
}

/** 6 Byte 0xFF, gefolgt von der MAC-Adresse 16-mal wiederholt. */
function buildMagicPacket(mac: string): Buffer {
  const macBytes = macToBytes(mac);
  const packet = Buffer.alloc(102);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    macBytes.copy(packet, 6 + i * 6);
  }
  return packet;
}

export async function wake(macOverride?: string, broadcastOverride?: string) {
  const config = loadConfig();
  const mac = macOverride ?? config.wolMac;
  const broadcast = broadcastOverride ?? config.wolBroadcast;
  const packet = buildMagicPacket(mac);

  // Port 9 ist der übliche Discard-Port für WoL; 7 wird von manchen NICs genutzt.
  const ports = [9, 7];

  await new Promise<void>((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      let remaining = ports.length;
      for (const port of ports) {
        socket.send(packet, port, broadcast, (err) => {
          if (err) log.warn(`Senden an Port ${port} fehlgeschlagen: ${err.message}`);
          if (--remaining === 0) {
            socket.close();
            resolve();
          }
        });
      }
    });
  });

  log.info(`Magic Packet an ${mac} über ${broadcast} gesendet`);
  return { mac, broadcast, ports, sent: true };
}

/**
 * Zeigt an, ob WoL auf diesem Rechner überhaupt greifen könnte. Der
 * Kabelstatus ist der entscheidende Punkt.
 */
export function readiness() {
  const interfaces: Array<{ name: string; carrier: boolean; mac: string | null; wired: boolean }> = [];

  for (const name of readdirSync('/sys/class/net')) {
    if (name === 'lo') continue;
    const read = (file: string) => {
      try {
        return readFileSync(`/sys/class/net/${name}/${file}`, 'utf8').trim();
      } catch {
        return null;
      }
    };
    // Wireless-Interfaces haben ein wireless-Unterverzeichnis.
    let wired = true;
    try {
      readdirSync(`/sys/class/net/${name}/wireless`);
      wired = false;
    } catch {
      /* kein wireless-Verzeichnis → kabelgebunden */
    }

    interfaces.push({
      name,
      carrier: read('carrier') === '1',
      mac: read('address'),
      wired,
    });
  }

  const wiredUp = interfaces.find((i) => i.wired && i.carrier);
  return {
    interfaces,
    ready: !!wiredUp,
    note: wiredUp
      ? `Kabelverbindung über ${wiredUp.name} vorhanden – WoL nutzbar, sofern im BIOS aktiviert`
      : 'Kein Netzwerkkabel verbunden. WoL funktioniert über WLAN nicht.',
  };
}
