import { $, api, esc } from './lib.js';

async function loadLogs() {
  try {
    const res = await api('/logs?limit=50');
    let usage = {};
    try { usage = await api('/usage'); } catch { /* Aeltere Gateway-Version ohne /usage */ }
    const u = usage.usage ?? {};
    const total = (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
    $('usage-summary').innerHTML = u.llmRequests
      ? `LLM-Requests: <b>${u.llmRequests}</b> | Tokens gesamt: <b>${total.toLocaleString('de-DE')}</b> (Prompt ${u.promptTokens.toLocaleString('de-DE')} + Completion ${u.completionTokens.toLocaleString('de-DE')}) | davon Cache-Hits: ${u.cachedRequests}`
      : 'Noch keine LLM-Tokens erfasst.';
    const tbody = $('logs-table').querySelector('tbody');
    tbody.innerHTML = '';
    for (const l of res.logs) {
      const tr = document.createElement('tr');
      const tok = (l.prompt_tokens ?? 0) + (l.completion_tokens ?? 0);
      tr.innerHTML = `
        <td>${esc(l.ts)}</td>
        <td><span class="badge ${l.route === 'action' ? 'action' : 'agent'}">${esc(l.route)}</span></td>
        <td>${esc(l.query)}</td>
        <td>${esc(String(l.response ?? '').slice(0, 120))}</td>
        <td>${l.duration_ms} ms</td>
        <td>${tok > 0 ? tok.toLocaleString('de-DE') + ' (' + esc(l.llm_model ?? '') + ')' : '—'}</td>`;
      tbody.append(tr);
    }
  } catch (e) {
    alert(`Logs fehlgeschlagen: ${e.message}`);
  }
}
