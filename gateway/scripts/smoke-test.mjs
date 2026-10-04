// SmartPilot Gateway Smoke-Tests (End-to-End gegen laufendes Gateway)
// Ableitung aus README-Zielen: Schnelligkeit, Determinismus, MCP-Anbindung,
// Zwei-Modi-Flow, Token-Logging, Sicherheit.
//
// Nutzung:  GATEWAY=http://localhost:8331 ADMIN_TOKEN=... API_TOKEN=... node smoke-test.mjs
// Exit-Code 0 = alle Tests ok, 1 = mindestens ein Fehler.

const BASE = process.env.GATEWAY ?? 'http://localhost:8331';
const TOKEN = process.env.ADMIN_TOKEN ?? ''; // Admin
const QUERY = process.env.API_TOKEN ?? ''; // Adapter-API
const TTL = Number(process.env.TTL ?? 120000);
// Admin liegt optional unter BASE_PATH (Gateway-Konfiguration); die Adapter-API
// (/api/...) bleibt auf der Wurzel.
const BASE_PATH = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
const ADMIN = `${BASE_PATH}/admin`;

const results = [];
let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    results.push(`  ✓ ${name}`);
  } else {
    failed++;
    results.push(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TTL),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* unparsbar */
  }
  return { status: res.status, json };
}

async function get(path, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(TTL) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = () => `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function query(text, sessionId) {
  return post('/api/query', { sessionId, text }, QUERY);
}

async function main() {
  console.log(`SmartPilot Smoke-Tests gegen ${BASE}`);
  console.log('');

  if (!TOKEN) {
    check('ADMIN_TOKEN gesetzt', false, 'ADMIN_TOKEN env fehlt');
  }
  if (!QUERY) {
    check('API_TOKEN gesetzt', false, 'API_TOKEN env fehlt');
  }

  // ---- 1. Sicherheit -----------------------------------------------------
  {
    console.log('Sicherheit:');
    const noAuth = await post('/api/query', { text: 'test' }, '');
    check('  /api/query ohne Bearer → 401', noAuth.status === 401, `HTTP ${noAuth.status}`);
    const wrongAuth = await post('/api/query', { text: 'test' }, 'falscher-token');
    check('  /api/query mit falschem Bearer → 401', wrongAuth.status === 401, `HTTP ${wrongAuth.status}`);
    const adminOnQuery = await post('/api/query', { text: 'test' }, TOKEN);
    check('  /api/query mit ADMIN_TOKEN → 401 (Split)', adminOnQuery.status === 401, `HTTP ${adminOnQuery.status}`);
    const adminNoCookie = await get(`${ADMIN}/`, TOKEN);
    check('  /admin ohne Session → 4xx', adminNoCookie.status >= 400, `HTTP ${adminNoCookie.status}`);
    const loginWrong = await post(`${ADMIN}/login`, { token: 'falsch' }, '');
    check('  /admin/login falscher Token → 401', loginWrong.status === 401, `HTTP ${loginWrong.status}`);
    const loginOk = await post(`${ADMIN}/login`, { token: TOKEN }, '');
    check('  /admin/login korrekter Token → 200', loginOk.status === 200, `HTTP ${loginOk.status}`);
    console.log('');
  }

  // ---- 2. Deterministische Actions (schnell, stabil) ----------------------
  {
    console.log('Deterministische Actions:');
    const t0 = Date.now();
    const status = await query('wie ist der hausstatus', sid());
    const t1 = Date.now();
    const statusDur = t1 - t0;
    check('Hausstatus → Route action', status.json.route === 'action', `route=${status.json.route}`);
    check('  Hausstatus antwortet', !!status.json.response?.speech, status.json.response?.speech?.slice(0, 60));
    check(`  Hausstatus schnell (< 5000ms)`, statusDur < 5000, `${statusDur}ms`);
    if (status.json.response?.speech) {
      check(
        `  Hausstatus ohne KI-Lotterie (konstant)`,
        /status|temperatur|zimmer|haus|grad|°c|prozent|voll|halb/i.test(status.json.response.speech),
        status.json.response.speech.slice(0, 80)
      );
    }
    const t2 = Date.now();
    const fuel = await query('benzinpreis', sid());
    const t3 = Date.now();
    const fuelDur = t3 - t2;
    check('Benzinpreis → Route action', fuel.json.route === 'action', `route=${fuel.json.route}`);
    check('  Benzinpreis antwortet', !!fuel.json.response?.speech, fuel.json.response?.speech?.slice(0, 60));
    check(`  Benzinpreis schnell (< 5000ms)`, fuelDur < 5000, `${fuelDur}ms`);
    console.log('');
  }

  // ---- 3. LLM/Agent (offene Fragen) ----------------------------------------
  {
    console.log('LLM / Agent:');
    const a = await query('was ist ein black hole', sid());
    check('Offene Frage → Route agent', a.json.route === 'agent', `route=${a.json.route}`);
    check('  Agent antwortet', !!a.json.response?.speech, a.json.response?.speech?.slice(0, 60));
    console.log('');
  }

  // ---- 4. Zwei Modi --------------------------------------------------------
  {
    console.log('Zwei Modi (OneShot vs Chat):');
    const oneshot = await query('wie ist das wetter heute', sid());
    check('OneShot → followUp falsch', !oneshot.json.response?.followUp, JSON.stringify(oneshot.json.response?.followUp));
    const sChat = sid();
    const chatQ = await query('Smart Pilot, Chat-Modus', sChat);
    check('Chat-Modus Request → Route action/agent', !!chatQ.json.response, 'keine Antwort');
    const chat = await query('erzähl mir was über berlin', sChat);
    check('Chat-Modus → followUp (Session offen)', chat.json.response?.followUp === true, `followUp=${chat.json.response?.followUp}`);
    console.log('');
  }

  // ---- 5. Token-Logging & Kontext ------------------------------------------
  {
    console.log('Token-Logging & Kontext:');
    const usage = await get(`${ADMIN}/api/usage`, TOKEN);
    check('  /admin/api/usage liefert Daten', usage.status === 200 && typeof usage.json.usage === 'object', `HTTP ${usage.status}`);
    if (usage.json?.usage) {
      const u = usage.json.usage;
      check('    Tokens gesamt > 0', (u.totalTokens ?? 0) > 0, `totalTokens=${u.totalTokens}`);
      check('    prompt+completion erfasst', (u.promptTokens ?? 0) > 0 && (u.completionTokens ?? 0) > 0, `p=${u.promptTokens} c=${u.completionTokens}`);
    }
    const logs = await get(`${ADMIN}/api/logs?limit=5`, TOKEN);
    const hasTokens = (logs.json.logs ?? []).some((l) => (l.prompt_tokens ?? 0) + (l.completion_tokens ?? 0) > 0);
    check('  Logs enthalten Token-Spalten', hasTokens, 'kein Eintrag mit Tokens in letzten 5');
    console.log('');
  }

  // ---- 6. Kontext / Follow-up (gleiche Session) -----------------------------
  {
    console.log('Kontext / Follow-up:');
    const s = sid();
    const first = await query('neuigkeiten', s);
    const second = await query('mehr dazu', s);
    check('Folgefrage in gleicher Session liefert Antwort', !!second.json.response?.speech, second.json.response?.speech?.slice(0, 60));
    const s3 = sid();
    const ha = await query('temperatur im schlafzimmer', s3);
    check('MCP-HA Temperatur antwortet', !!ha.json.response?.speech, ha.json.response?.speech?.slice(0, 80));
    console.log('');
  }

  // ---- Zusammenfassung ------------------------------------------------------
  console.log('----------------------------------------');
  console.log(`Ergebnis: ${passed} ok, ${failed} fehlgeschlagen`);
  console.log('');
  results.forEach((r) => console.log(r));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});