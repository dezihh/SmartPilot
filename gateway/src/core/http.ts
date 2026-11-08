import { promises as dns } from 'node:dns';
import { Agent } from 'undici';
import { getSetting, getSettingNum } from '../db.js';
import type { TraceEvent } from '../types.js';
import { isPrivateHost } from './ssrf.js';
import { headersForUrl, isAllowedPrivateTarget, parseHttpHeaders, parsePrivateAllow, type HeaderMap } from './httpHeaders.js';
import { TEST_HOOKS_ENABLED } from './testEnv.js';

// HTTP-Baustein: generischer GET-Fetch fuer beliebige REST-Endpunkte.
// Absicherungen: Timeout + Groessencap; JSON wird automatisch geparst,
// damit Templates direkt auf Felder zugreifen koennen.
export const HTTP_TIMEOUT_MS = 5000;
export const HTTP_BODY_CAP = 100_000;

// Body streamend bis zum Cap lesen: eine riesige Antwort darf nicht erst
// komplett in den Speicher geladen werden (Body-Cap greift sonst zu spaet).
async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, cap);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= cap) break;
    }
    out += decoder.decode();
  } catch {
    /* abgebrochene Verbindung: bisher Gelesenes verwenden */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return out.slice(0, cap);
}

// Dynamische Hostnamen vorab aufloesen. Fail-closed: null = keine
// Aufloesung (NXDOMAIN/offline) -> der Aufrufer blockiert den Request.
async function resolveDynamicHost(hostname: string): Promise<{ address: string; family: number }[] | null> {
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.map((a) => ({ address: a.address, family: a.family }));
  } catch {
    return null;
  }
}

// Dispatcher-Factory fuer gepinnte dynamische Requests. Ausgelagert
// und injizierbar, damit Tests die tatsaechlich verwendete Ziel-IP (nicht nur
// die Praesenz) pruefen koennen. Default: undici-Agent mit gepinntem lookup.
// allowH2 bleibt aus: undici 8 verhandelt HTTP/2 sonst per ALPN selbst, was
// Zielserver mit halbem h2-Support und die IP-Pinnung unnoetig kompliziert.
interface PinnedDispatcher {
  close: () => Promise<void>;
}
type PinDispatcherFactory = (pin: { address: string; family: number }) => PinnedDispatcher;
const defaultPinDispatcher = (pin: { address: string; family: number }): PinnedDispatcher =>
  new Agent({ allowH2: false, connect: { lookup: (_h, _o, cb) => cb(null, [pin]) } });
let pinDispatcherFactory: PinDispatcherFactory = defaultPinDispatcher;
export function setPinDispatcherFactoryForTests(factory?: PinDispatcherFactory): void {
  if (!TEST_HOOKS_ENABLED) return;
  pinDispatcherFactory = factory ?? defaultPinDispatcher;
}

export async function fetchUrl(url: string, trace: TraceEvent[], dynamic: boolean): Promise<unknown | null> {
  const timeoutMs = getSettingNum('http_timeout_ms', HTTP_TIMEOUT_MS);
  const bodyCap = getSettingNum('http_body_cap', HTTP_BODY_CAP);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Header-Auth aus den Einstellungen. Fehlerhafte Konfiguration wird geloggt
  // (ohne Werte) und fail-closed ignoriert: ohne Header kein Zugriff.
  let headerMap: HeaderMap = new Map();
  let privateAllow = new Set<string>();
  try {
    headerMap = parseHttpHeaders(getSetting('http_headers'));
  } catch (e) {
    trace.push({ ts: Date.now(), step: 'template.http.headers.invalid', detail: { error: String(e) } });
  }
  try {
    privateAllow = parsePrivateAllow(getSetting('http_private_allow'));
  } catch (e) {
    trace.push({ ts: Date.now(), step: 'template.http.allow.invalid', detail: { error: String(e) } });
  }
  try {
    let target = url;
    // Bei gesetzten Headern (und bei dynamischen URLs) werden Redirects selbst
    // verfolgt: nur so laesst sich pro Etappe neu entscheiden, ob ein Header
    // mit Geheimnis an dieses Ziel darf.
    const manual = dynamic || Object.keys(headersForUrl(new URL(url), headerMap)).length > 0;
    // Dynamische URLs: jede Redirect-Etappe erneut pruefen statt blindem follow,
    // sonst umgeht ein Redirect die Host-Pruefung.
    for (let hop = 0; hop <= 3; hop++) {
      const u = new URL(target);
      const allowedPrivate = dynamic && isAllowedPrivateTarget(u, privateAllow);
      if (dynamic && isPrivateHost(u.hostname) && !allowedPrivate) {
        trace.push({ ts: Date.now(), step: 'template.http.blocked', detail: { url: target, reason: 'privates Netz' } });
        return null;
      }
      // DNS-Rebinding - oeffentlichen Hostnamen vorab aufloesen, private
      // Ziele blockieren UND die gepruefte IP im Request pinnen (dispatcher).
      // So ist ein Rebinding zwischen Pruefung und Verbindungsaufbau wirkungslos.
      let dispatcher: PinnedDispatcher | undefined;
      if (dynamic) {
        const addrs = await resolveDynamicHost(u.hostname);
        // Fail-closed: ohne aufloesbaren Host keine Verbindung, auch wenn
        // fetch spaeter selbst noch einmal aufloesen wuerde (Rebinding).
        if (!addrs || addrs.length === 0) {
          trace.push({ ts: Date.now(), step: 'template.http.blocked', detail: { url: target, reason: 'DNS nicht aufloesbar' } });
          return null;
        }
        if (!allowedPrivate && addrs.some((a) => isPrivateHost(a.address))) {
          trace.push({ ts: Date.now(), step: 'template.http.blocked', detail: { url: target, reason: 'DNS -> privates Netz' } });
          return null;
        }
        const pin = addrs[0];
        if (pin) dispatcher = pinDispatcherFactory(pin);
      }
      const headers = headersForUrl(u, headerMap);
      const init: RequestInit = {
        signal: controller.signal,
        redirect: manual ? 'manual' : 'follow',
        ...(Object.keys(headers).length ? { headers } : {}),
      };
      if (dispatcher) (init as { dispatcher?: unknown }).dispatcher = dispatcher;
      try {
        const res = await fetch(target, init);
        if (manual && res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) {
            trace.push({ ts: Date.now(), step: 'template.http.error', detail: { url: target, status: res.status, error: 'Redirect ohne Location' } });
            return null;
          }
          target = new URL(loc, target).toString();
          continue;
        }
        const raw = await readCapped(res, bodyCap);
        if (!res.ok) {
          trace.push({ ts: Date.now(), step: 'template.http.error', detail: { url: target, status: res.status, body: raw.slice(0, 200) } });
          return null;
        }
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return raw;
        }
      } finally {
        if (dispatcher) await dispatcher.close().catch(() => {});
      }
    }
    trace.push({ ts: Date.now(), step: 'template.http.error', detail: { url, error: 'zu viele Redirects' } });
    return null;
  } catch (e) {
    trace.push({ ts: Date.now(), step: 'template.http.error', detail: { url, error: String(e) } });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
