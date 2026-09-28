import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireAuth, requestAuthorized, bearerToken, createSession, sessionValid, cookieFor } from '../src/auth.js';
import { config } from '../src/config.js';

interface Captured {
  status?: number;
  body?: unknown;
  nextCalled: boolean;
}

function fakeRes(): { res: never; captured: Captured } {
  const captured: Captured = { nextCalled: false };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res: res as never, captured };
}

function authHeaders(authorization?: string, cookie?: string) {
  return { headers: { ...(authorization ? { authorization } : {}), ...(cookie ? { cookie } : {}) } };
}

beforeEach(() => {
  // Sessions-Map leeren: gueltige Session erzeugen und direkt wieder loeschen
  const id = createSession(config.authToken);
  if (id) sessionValid({ headers: { cookie: `va_session=${id}` } } as never);
});

test('requireAuth: ohne Bearer -> 401, next nicht gerufen', () => {
  const { res, captured } = fakeRes();
  requireAuth(authHeaders() as never, res, () => {
    captured.nextCalled = true;
  });
  assert.equal(captured.status, 401);
  assert.equal(captured.nextCalled, false);
});

test('requireAuth: falscher Bearer -> 401', () => {
  const { res, captured } = fakeRes();
  requireAuth(authHeaders('Bearer falsch') as never, res, () => {
    captured.nextCalled = true;
  });
  assert.equal(captured.status, 401);
});

test('requireAuth: kuerzerer Token (Laengen-Fall timingSafeEqual) -> 401, kein Wurf', () => {
  const { res, captured } = fakeRes();
  requireAuth(authHeaders('Bearer k') as never, res, () => {
    captured.nextCalled = true;
  });
  assert.equal(captured.status, 401);
  assert.equal(captured.nextCalled, false);
});

test('requireAuth: richtiger Bearer -> next gerufen', () => {
  const { res, captured } = fakeRes();
  requireAuth(authHeaders(`Bearer ${config.authToken}`) as never, res, () => {
    captured.nextCalled = true;
  });
  assert.equal(captured.status, undefined);
  assert.equal(captured.nextCalled, true);
});

test('requireAuth: Bearer-Praefix fehlt (rohes Token) -> 401', () => {
  const { res, captured } = fakeRes();
  requireAuth(authHeaders(config.authToken) as never, res, () => {
    captured.nextCalled = true;
  });
  assert.equal(captured.status, 401);
});

test('createSession: falsches Token -> null, richtiges -> Session-ID', () => {
  assert.equal(createSession('falsch'), null);
  const id = createSession(config.authToken);
  assert.match(id ?? '', /^[0-9a-f]{64}$/);
});

test('sessionValid: unbekannte Session -> false', () => {
  assert.equal(sessionValid({ headers: { cookie: 'va_session=unbekannt' } } as never), false);
});

test('sessionValid: gueltige Session -> true, Sliding-Refresh laesst zweiten Aufruf bestehen', () => {
  const id = createSession(config.authToken)!;
  const req = { headers: { cookie: `other=1; va_session=${id}; more=2` } } as never;
  assert.equal(sessionValid(req), true);
  assert.equal(sessionValid(req), true);
});

test('cookieFor: HttpOnly + SameSite=Lax + Path=/admin', () => {
  const cookie = cookieFor('abc');
  assert.ok(cookie.includes('va_session=abc'));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Lax'));
  assert.ok(cookie.includes('Path=/admin'));
});

test('requireAuth akzeptiert gueltigen Session-Cookie ohne Bearer', () => {
  const id = createSession(config.authToken)!;
  const { res, captured } = fakeRes();
  requireAuth(authHeaders(undefined, `va_session=${id}`) as never, res, () => {
    captured.nextCalled = true;
  });
  assert.equal(captured.status, undefined);
  assert.equal(captured.nextCalled, true);
});

test('requestAuthorized: Bearer ODER Session, sonst false (Issue #10)', () => {
  assert.equal(requestAuthorized(authHeaders(`Bearer ${config.authToken}`) as never), true);
  const id = createSession(config.authToken)!;
  assert.equal(requestAuthorized(authHeaders(undefined, `va_session=${id}`) as never), true);
  assert.equal(requestAuthorized(authHeaders() as never), false);
  assert.equal(requestAuthorized(authHeaders('Bearer falsch') as never), false);
});

test('bearerToken liest nur die Praefix-Form (F-D4)', () => {
  assert.equal(bearerToken(authHeaders('Bearer abc') as never), 'abc');
  assert.equal(bearerToken(authHeaders('abc') as never), '');
  assert.equal(bearerToken(authHeaders() as never), '');
});
