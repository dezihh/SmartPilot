import { $, api, esc } from './lib.js';

const ctx = {
  showTab: () => {},
  openFunctionEditor: () => {},
  previewFunction: () => {},
  getBootstrap: () => ({ actions: [], functions: [] }),
  getPackageForTest: () => null,
};
export function initMonitor(next) { Object.assign(ctx, next); }

// Testbutton aus Vorgaengen/Paketen: Phrase im Monitor ausfuehren (Ergebnis+Trace).
export function testInMonitor(phrase) {
  ctx.showTab('monitor');
  $('test-text').value = phrase;
  sendTest();
}

// Paket: ersten Vorgang (sonst erste Funktion) des Pakets testen.
// Lesende Prüfung: MCP-Server des Pakets initialisieren und Werkzeuge listen.
// Funktionen und Vorgänge werden NICHT ausgeführt (das könnte schreiben).
export async function testPackage(id) {
  const p = ctx.getPackageForTest(id);
  const items = p?.items ?? [];
  const serverNames = items.filter((i) => i.kind === 'server').map((i) => i.name);
  if (!serverNames.length) {
    const fns = items.filter((i) => i.kind === 'function').length;
    const acts = items.filter((i) => i.kind === 'action').length;
    const hint = [
      fns ? `${fns} Funktion(en) — Vorschau im Tab „Funktionen" (lesend)` : '',
      acts ? `${acts} Vorgang(e) — im Monitor bewusst auslösen` : '',
    ].filter(Boolean).join('; ');
    alert(`Kein MCP-Server im Paket. ${hint || 'Nichts zu prüfen.'}`);
    return;
  }
  const servers = ctx.getBootstrap().servers ?? [];
  const lines = [];
  for (const name of serverNames) {
    const row = servers.find((s) => s.name === name);
    if (!row) { lines.push(`${name}: nicht gefunden`); continue; }
    try {
      const r = await api(`/mcp-servers/${encodeURIComponent(String(row.id))}/health`, { method: 'POST' });
      lines.push(r.ok ? `${name}: ok — ${(r.tools ?? []).length} Werkzeug(e)` : `${name}: Fehler — ${r.error ?? 'unbekannt'}`);
    } catch (e) {
      lines.push(`${name}: Fehler — ${e.message}`);
    }
  }
  alert(`MCP-Prüfung (lesend):\n${lines.join('\n')}`);
}

export async function sendTest() {
  const text = $('test-text').value.trim();
  if (!text) return;
  $('test-send').disabled = true;
  $('test-result').innerHTML = '<div class="test-meta">Verarbeite…</div>';
  $('test-trace').innerHTML = '';
  try {
    const res = await api('/query', { method: 'POST', body: JSON.stringify({ sessionId: 'monitor', text }) });
    const r = res.response;
    const badge = res.route === 'action' ? 'badge action' : 'badge agent';
    $('test-result').innerHTML = `
      <div class="test-answer">${esc(r.speech)}</div>
      <div class="test-meta">
        Route: <span class="${badge}">${esc(res.route)}</span>
        ${res.score ? `Score: ${Number(res.score).toFixed(2)}` : ''}
        Dauer: ${res.durationMs} ms
        ${r.followUp ? '· Rückfrage (Session offen)' : ''}
      </div>`;
    $('test-trace').innerHTML = (res.trace ?? [])
      .map((t) => `<li><span class="ts">${new Date(t.ts).toLocaleTimeString()}</span>${esc(t.step)} <pre>${esc(t.detail ? JSON.stringify(t.detail) : '')}</pre></li>`)
      .join('');
  } catch (e) {
    $('test-result').innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
  } finally {
    $('test-send').disabled = false;
  }
}
