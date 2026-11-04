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
export function testPackage(id) {
  const p = ctx.getPackageForTest(id);
  const items = p?.items ?? [];
  const actionName = items.find((i) => i.kind === 'action')?.name;
  if (actionName) {
    const a = (ctx.getBootstrap().actions ?? []).find((x) => x.name === actionName);
    testInMonitor((a?.triggers ?? [])[0] || actionName);
    return;
  }
  const fnName = items.find((i) => i.kind === 'function')?.name;
  const f = fnName ? (ctx.getBootstrap().functions ?? []).find((x) => x.name === fnName) : null;
  if (f) {
    ctx.showTab('functions');
    ctx.openFunctionEditor(f.id);
    ctx.previewFunction();
    return;
  }
  alert('Dieses Paket hat keinen direkt testbaren Vorgang/eine Funktion.');
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
