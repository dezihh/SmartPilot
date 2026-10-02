import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  // Gueltiger Session-Cookie reicht ebenso wie ein Bearer-Token (Admin-UI ohne
  // clientseitig geparktes ADMIN_TOKEN).
  if (requestAuthorized(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

// Bearer-Token aus dem Authorization-Header lesen (zentral, F-D4).
export function bearerToken(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

// Gemeinsamer Auth-Helper fuer UI und API: ein gueltiges Bearer-Token ODER ein
// gueltiger Session-Cookie autorisiert. So kann ein vorgelagerter Reverse-Proxy
// `Authorization: Bearer <ADMIN_TOKEN>` serverseitig injizieren, ohne dass das
// Token je in den Browser gelangt (kein doppelter App-Login, Issue #10).
export function requestAuthorized(req: Request): boolean {
  return tokenValid(bearerToken(req)) || sessionValid(req);
}

// Adapter-API (Alexa-Lambda): NUR das API_TOKEN als Bearer. Kein Admin-Token
// und keine Admin-Session - der Query-Zugang darf keine Admin-Rechte bedeuten.
export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  if (apiTokenValid(bearerToken(req))) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

export function apiTokenValid(token: string): boolean {
  return tokenMatches(config.apiToken, token);
}

function tokenValid(token: string): boolean {
  return tokenMatches(config.adminToken, token);
}

function tokenMatches(expectedToken: string, givenToken: string): boolean {
  const expected = Buffer.from(expectedToken);
  const given = Buffer.from(givenToken);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
// exp = Sliding-TTL, created = absolute Obergrenze (config.sessionMaxMs).
interface Session {
  exp: number;
  created: number;
}
const sessions = new Map<string, Session>();

// Abgelaufene Sessions entfernen; zusaetzlich eine Obergrenze halten, damit
// die In-Memory-Map nicht unbegrenzt waechst (Sliding-TTL laesst aktive
// Sessions sonst nie ablaufen).
function pruneSessions(now: number): void {
  for (const [id, s] of sessions) if (s.exp < now) sessions.delete(id);
}

export function createSession(token: string): string | null {
  if (!tokenValid(token)) return null;
  pruneSessions(Date.now());
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  const id = randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, { exp: now + SESSION_TTL_MS, created: now });
  return id;
}

export function sessionValid(req: Request): boolean {
  const raw = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)va_session=([^;]+)/.exec(raw);
  if (!match) return false;
  const id = match[1];
  if (!id) return false;
  const session = sessions.get(id);
  if (!session) return false;
  const now = Date.now();
  // Sliding-TTL abgelaufen ODER absolute Obergrenze ueberschritten.
  if (session.exp < now || now - session.created > config.sessionMaxMs) {
    sessions.delete(id);
    return false;
  }
  session.exp = now + SESSION_TTL_MS;
  return true;
}

// secure=true (Default) setzt das Secure-Flag; die Login-Route uebergibt
// secure=false fuer den direkten LAN-Zugriff ueber HTTP (sonst wuerde der
// Browser das Cookie dort verwerfen).
export function cookieFor(sessionId: string, secure = true): string {
  return `va_session=${sessionId}; HttpOnly; SameSite=Lax; Path=${config.basePath}/admin${secure ? '; Secure' : ''}; Max-Age=${SESSION_TTL_MS / 1000}`;
}
