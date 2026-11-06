// SSRF-Schutz: dynamische http()-URLs (args-kontaminiert) duerfen niemals ins
// private Netz zeigen. Literale URLs (Admin-Templates) sind vertrauenswuerdig
// und bleiben unangetastet (LAN-Dienste wie CGIs muessen funktionieren).
// Haertung: Der URL-Parser kanonisiert IPv4-Kurzformen (Dezimal/Oktal/Hex);
// danach werden private IPv4-/IPv6-Bereiche inkl. IPv4-Mapped geprueft.

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function ipv4ToInt(bytes: number[]): number {
  return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
}

const IPV4_PRIVATE_RANGES: Array<{ base: number; mask: number }> = (
  [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    // Multicast, reserviert und Broadcast duerfen ebenfalls nie Ziel eines
    // dynamischen http()-Aufrufs sein (F-11).
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
    ['255.255.255.255', 32],
  ] as Array<[string, number]>
).map(([base, bits]) => {
  const bytes = ipv4ToBytes(base)!;
  return {
    base: ipv4ToInt(bytes),
    mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0,
  };
});

function isPrivateIpv4(ip: string): boolean {
  const bytes = ipv4ToBytes(ip);
  if (!bytes) return false;
  const n = ipv4ToInt(bytes);
  return IPV4_PRIVATE_RANGES.some(({ base, mask }) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
}

function expandIpv6(input: string): number[] | null {
  let ip = input.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0]!;
  if (!ip.includes(':')) return null;
  const dotIdx = ip.lastIndexOf('.');
  if (dotIdx !== -1) {
    // Eingebettete IPv4-Schreibweise (z. B. ::ffff:127.0.0.1) -> zwei Hextets.
    const colonIdx = ip.lastIndexOf(':');
    const v4 = ipv4ToBytes(ip.slice(colonIdx + 1));
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    ip = `${ip.slice(0, colonIdx + 1)}${hi}:${lo}`;
  }
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : [];
  if (parts.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isPrivateIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  if ((g0! & 0xffc0) === 0xfe80) return true; // fe80::/10 Link-Local
  if ((g0! & 0xfe00) === 0xfc00) return true; // fc00::/7 Unique Local
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIpv4(`${(g6! >> 8) & 0xff}.${g6! & 0xff}.${(g7! >> 8) & 0xff}.${g7! & 0xff}`);
  }
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-Kurzformen (Dezimal/Oktal/Hex) ueber den URL-Parser kanonisieren.
  try {
    const canon = new URL(`http://${h}`).hostname.replace(/^\[|\]$/g, '');
    if (canon) h = canon;
  } catch {
    /* kein parsbarer Host - mit dem Rohwert weiterpruefen */
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (isPrivateIpv4(h)) return true;
  if (isPrivateIpv6(h)) return true;
  return false;
}

// Besonders sensible Ziele: Loopback, Link-Local (inkl. Cloud-Metadata
// 169.254.169.254), 0.0.0.0/8 und Broadcast. In Paketmanifesten sind sie
// ack-pflichtig; reine LAN-Ziele (RFC1918) bleiben nur ein Hinweis.
export function isSensitiveHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  try {
    const canon = new URL(`http://${h}`).hostname.replace(/^\[|\]$/g, '');
    if (canon) h = canon;
  } catch {
    /* kein parsbarer Host - mit dem Rohwert weiterpruefen */
  }
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1' || h === 'fe80' || h.startsWith('fe80:')) return true;
  const bytes = ipv4ToBytes(h);
  if (!bytes) return false;
  const n = ipv4ToInt(bytes);
  return (n >>> 24) === 127 || (n >>> 16) === 0xa9fe || (n >>> 24) === 0 || n === 0xffffffff;
}
