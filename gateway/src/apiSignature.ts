import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Replay-Schutz fuer die Adapter-API (Issue #5): Die Lambda signiert
// Zeitstempel, Nonce und Body-Hash mit einem gemeinsamen Secret. Das Gateway
// akzeptiert eine Signatur nur innerhalb des Zeitfensters und nur einmal.
//
// Die kanonische Zeichenkette enthaelt bewusst weder Methode noch Pfad: die
// Lambda kann hinter einem Reverse-Proxy mit Prefix laufen, und ein Replay auf
// einen anderen Endpunkt scheitert ohnehin am Nonce-Cache.

export const DEFAULT_SIGNATURE_TTL_SECONDS = 300;
// Obergrenze: ein sehr grosses Fenster wuerde den Nonce-Cache und das
// Replay-Fenster unnoetig vergroessern.
export const MAX_SIGNATURE_TTL_SECONDS = 3600;
const MAX_NONCES = 10_000;
const NONCE_PATTERN = /^[a-f0-9]{16,128}$/i;

// nonce -> Ablaufzeitpunkt (ms). Nur innerhalb des Gueltigkeitsfensters
// relevant; danach ist die Signatur ohnehin zu alt.
const seenNonces = new Map<string, number>();

function bodyHash(rawBody: Buffer | string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

function canonicalString(timestamp: number, nonce: string, rawBody: Buffer | string): string {
  return `${timestamp}\n${nonce}\n${bodyHash(rawBody)}`;
}

export function signApiRequest(
  secret: string,
  timestamp: number,
  nonce: string,
  rawBody: Buffer | string,
): string {
  return createHmac('sha256', secret).update(canonicalString(timestamp, nonce, rawBody)).digest('hex');
}

export type SignatureCheck = 'ok' | 'missing' | 'stale' | 'bad-signature' | 'replayed' | 'cache-full';

export interface SignatureInput {
  signature: string | undefined;
  timestamp: string | undefined;
  nonce: string | undefined;
  rawBody: Buffer | string;
  secret: string;
  ttlSeconds: number;
  now?: number;
}

function pruneNonces(now: number): void {
  for (const [nonce, expires] of seenNonces) {
    if (expires < now) seenNonces.delete(nonce);
  }
}

export function checkApiSignature(input: SignatureInput): SignatureCheck {
  const { signature, timestamp, nonce } = input;
  if (!signature || !timestamp || !nonce) return 'missing';
  if (!NONCE_PATTERN.test(nonce)) return 'bad-signature';
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || ts <= 0) return 'bad-signature';
  const now = input.now ?? Date.now();
  if (Math.abs(now / 1000 - ts) > input.ttlSeconds) return 'stale';
  const expected = Buffer.from(signApiRequest(input.secret, ts, nonce, input.rawBody), 'utf8');
  const given = Buffer.from(signature.toLowerCase(), 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'bad-signature';
  pruneNonces(now);
  if (seenNonces.has(nonce)) return 'replayed';
  // Fail-closed: Ist der Cache voll, wird die Anfrage abgelehnt statt den
  // aeltesten Eintrag zu verdrängen. Verdrängen wuerde dessen Signatur
  // innerhalb des Gueltigkeitsfensters erneut verwendbar machen (Replay).
  if (seenNonces.size >= MAX_NONCES) return 'cache-full';
  // Doppeltes Zeitfenster: erst danach koennte dieselbe Nonce wieder greifen,
  // zu diesem Zeitpunkt ist die Signatur aber laengst abgelaufen.
  seenNonces.set(nonce, now + input.ttlSeconds * 2000);
  return 'ok';
}
