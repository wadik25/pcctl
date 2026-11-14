import { timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

/**
 * Prüft, ob eine IPv4-Adresse in einem CIDR-Bereich liegt.
 * IPv6-Adressen in der Form ::ffff:192.168.1.5 werden auf IPv4 zurückgeführt.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp) return false;

  const [range, bitsRaw] = cidr.split('/');
  if (!range) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const ipValue = ipToInt(normalizedIp);
  const rangeValue = ipToInt(range);
  if (ipValue === null || rangeValue === null) return false;

  if (bits === 0) return true;
  // Bitverschiebung um 32 ist in JavaScript nicht definiert, daher der Sonderfall oben.
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipValue & mask) === (rangeValue & mask);
}

function normalizeIp(ip: string): string | null {
  if (!ip) return null;
  // Von Node bei Dual-Stack-Sockets verwendete Schreibweise.
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (mapped === '::1') return '127.0.0.1';
  return mapped;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

export function isAllowedAddress(ip: string, networks: string[]): boolean {
  return networks.some((network) => ipInCidr(ip, network));
}

/**
 * Vergleicht Token in konstanter Zeit, damit sich der korrekte Wert nicht
 * über Laufzeitunterschiede erraten lässt.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Ermittelt die LAN-Adresse für die Anzeige in der Einrichtung. */
export function primaryLanAddress(): string | null {
  // networkInterfaces liefert auch virtuelle Adapter – die werden übersprungen.
  const candidates: string[] = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!addresses || name === 'lo' || name.startsWith('podman') || name.startsWith('veth')) continue;
    for (const address of addresses) {
      if (address.family === 'IPv4' && !address.internal) candidates.push(address.address);
    }
  }

  return candidates[0] ?? null;
}
