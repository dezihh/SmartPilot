// Header-Auth fuer http(): exakter Ziel-Match, kein Leck ueber Redirects,
// Allowlist fuer dynamische LAN-Ziele, Maskierung in der Admin-Ansicht.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN = 'http-headers-admin';
process.env.API_TOKEN = 'http-headers-api';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'http-headers-key';
process.env.LLM_MODEL = 'http-headers-model';

const { tmpDb } = await import('./_tmpdb.js');
const { initDb, closeDb } = await import('../src/db/schema.js');
const { setSetting, deleteSetting, getSettings, maskSettings, secretSettingFlags, stripSecretSettings } = await import(
  '../src/db.js'
);
const { fetchUrl } = await import('../src/core/http.js');
const { parseHttpHeaders, parsePrivateAllow, headersForUrl, isAllowedPrivateTarget } = await import(
  '../src/core/httpHeaders.js'
);
import type { TraceEvent } from '../src/types.js';

before(() => {
  closeDb();
  initDb(tmpDb('http-headers'));
});

after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
});

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
  deleteSetting('http_headers');
  deleteSetting('http_private_allow');
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

function stubFetch(
  handler: (url: string, call: number) => { status?: number; body?: unknown; location?: string } | Promise<unknown>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, init: init ?? {} });
    const result = await handler(target, calls.length - 1);
    if (result instanceof Response) return result;
    const r = result as { status?: number; body?: unknown; location?: string };
    const status = r.status ?? 200;
    const headers = new Map<string, string>();
    if (r.location) headers.set('location', r.location);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      body: null,
      text: async () => JSON.stringify(r.body ?? {}),
    } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

function trace(): TraceEvent[] {
  return [];
}

test('parseHttpHeaders: host und host:port, Header bleiben unveraendert', () => {
  const map = parseHttpHeaders('{"Example.ORG":{"X-Api-Key":"a"},"192.168.10.3:9000":{"X-API-Key":"b"}}');
  assert.deepEqual(headersForUrl(new URL('https://example.org/x'), map), { 'X-Api-Key': 'a' });
  assert.deepEqual(headersForUrl(new URL('http://192.168.10.3:9000/api'), map), { 'X-API-Key': 'b' });
  assert.deepEqual(headersForUrl(new URL('http://192.168.10.3:9001/api'), map), {});
});

test('parseHttpHeaders: lehnt kaputtes JSON, falsche Formen und Steuerzeichen ab', () => {
  assert.throws(() => parseHttpHeaders('{'), /ungueltiges JSON/);
  assert.throws(() => parseHttpHeaders('[]'), /JSON-Objekt/);
  assert.throws(() => parseHttpHeaders('{"bad host":{"X":"ok"}}'), /ungueltiger Host/);
  assert.throws(() => parseHttpHeaders('{"example.org":[]}'), /Header-Objekt/);
  assert.throws(() => parseHttpHeaders('{"example.org":{"Bad Name":"x"}}'), /Header-Name/);
  assert.throws(() => parseHttpHeaders('{"example.org":{"X":"a\\r\\nB"}}'), /Steuerzeichen/);
  assert.throws(() => parseHttpHeaders('{"example.org:0":{"X":"a"}}'), /Port/);
});

test('parsePrivateAllow: exakte Hosts, ungueltige Eintraege werden abgelehnt', () => {
  const allow = parsePrivateAllow('192.168.10.3, 192.168.10.3:9000\n');
  assert.ok(isAllowedPrivateTarget(new URL('http://192.168.10.3:9000/api'), allow));
  assert.ok(isAllowedPrivateTarget(new URL('http://192.168.10.3:9001/api'), allow));
  assert.ok(!isAllowedPrivateTarget(new URL('http://192.168.10.4/api'), allow));
  assert.throws(() => parsePrivateAllow('host:99999'), /Port/);
  assert.throws(() => parsePrivateAllow('host/pfad'), /ungueltiger Host/);
});

test('fetchUrl: sendet Header nur an exakt passenden Host', async () => {
  setSetting('http_headers', '{"example.org":{"X-Api-Key":"geheim"}}');
  const calls = stubFetch(() => ({ body: { ok: true } }));
  assert.deepEqual(await fetchUrl('https://example.org/x', trace(), false), { ok: true });
  assert.deepEqual(calls[0]!.init.headers, { 'X-Api-Key': 'geheim' });
  assert.equal(calls[0]!.init.redirect, 'manual');
});

test('fetchUrl: fremder Host bekommt nach Redirect keinen Header', async () => {
  setSetting('http_headers', '{"example.org":{"X-Api-Key":"geheim"}}');
  const calls = stubFetch((_url, n) =>
    n === 0 ? { status: 302, location: 'https://other.example/x' } : { body: { ok: true } },
  );
  assert.deepEqual(await fetchUrl('https://example.org/start', trace(), false), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.init.headers, { 'X-Api-Key': 'geheim' });
  assert.equal(calls[1]!.init.headers, undefined);
});

test('fetchUrl: Redirect auf denselben Host behaelt den Header', async () => {
  setSetting('http_headers', '{"example.org":{"X-Api-Key":"geheim"}}');
  const calls = stubFetch((_url, n) => (n === 0 ? { status: 307, location: '/neu' } : { body: { ok: true } }));
  await fetchUrl('https://example.org/start', trace(), false);
  assert.equal(calls[1]!.url, 'https://example.org/neu');
  assert.deepEqual(calls[1]!.init.headers, { 'X-Api-Key': 'geheim' });
});

test('fetchUrl: kaputte Header-Konfiguration wird ignoriert und im Trace benannt', async () => {
  setSetting('http_headers', '{');
  const calls = stubFetch(() => ({ body: {} }));
  const t = trace();
  assert.deepEqual(await fetchUrl('https://example.org/x', t, false), {});
  assert.equal(calls[0]!.init.headers, undefined);
  assert.ok(t.some((e) => e.step === 'template.http.headers.invalid'));
});

test('fetchUrl: dynamische private URL ohne Allowlist wird blockiert', async () => {
  const calls = stubFetch(() => ({ body: {} }));
  const t = trace();
  assert.equal(await fetchUrl('http://192.168.10.3:9000/api/endpoints', t, true), null);
  assert.equal(calls.length, 0);
  assert.ok(t.some((e) => e.step === 'template.http.blocked'));
});

test('fetchUrl: Allowlist laesst exakten privaten Host mit Header zu', async () => {
  setSetting('http_private_allow', '192.168.10.3:9000');
  setSetting('http_headers', '{"192.168.10.3:9000":{"X-API-Key":"geheim"}}');
  const calls = stubFetch(() => ({ body: { endpoints: [] } }));
  assert.deepEqual(await fetchUrl('http://192.168.10.3:9000/api/endpoints', trace(), true), { endpoints: [] });
  assert.deepEqual(calls[0]!.init.headers, { 'X-API-Key': 'geheim' });
});

test('fetchUrl: Allowlist gilt nicht fuer einen anderen Port', async () => {
  setSetting('http_private_allow', '192.168.10.3:9000');
  const calls = stubFetch(() => ({ body: {} }));
  assert.equal(await fetchUrl('http://192.168.10.3:9001/api', trace(), true), null);
  assert.equal(calls.length, 0);
});

test('Admin-Ansicht maskiert http_headers, Backup ohne tokens entfernt sie', () => {
  setSetting('http_headers', '{"example.org":{"X-Api-Key":"geheim"}}');
  const raw = getSettings();
  assert.equal(maskSettings(raw).http_headers, '(gesetzt)');
  assert.deepEqual(secretSettingFlags(raw), { http_headers: true });
  assert.equal(stripSecretSettings(raw).http_headers, null);
  deleteSetting('http_headers');
  assert.equal(secretSettingFlags(getSettings()).http_headers, false);
});
