import { $, api, esc } from './lib.js';

let indexesCache = [];

function parseIndexConfig(raw) {
  try {
  return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function renderIndexes() {
  const tbody = $('indexes-table').querySelector('tbody');
  tbody.innerHTML = '';
  try {
    const d = await api('/indexes');
    indexesCache = d.indexes ?? [];
  } catch {
    indexesCache = [];
  }
  for (const ix of indexesCache) {
    const cfg = parseIndexConfig(ix.config) ?? {};
    const desc = typeof cfg.desc === 'string' ? cfg.desc : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${ix.key ? esc(ix.key) : '(Standard)'}</code></td>
      <td>${esc(String(cfg.tool ?? ''))}</td>
      <td>${esc(String(cfg.ttlMs ?? ''))}</td>
      <td>${esc(desc)}</td>
      <td class="actions"><button class="btn small">Bearbeiten</button></td>`;
    tr.querySelector('button').onclick = () => openIndexEditor(ix.key);
    tbody.append(tr);
  }
}

function openIndexEditor(key) {
  const ix = indexesCache.find((x) => x.key === key) ?? null;
  const cfg = ix ? (parseIndexConfig(ix.config) ?? {}) : { tool: '', args: {}, ttlMs: 60000 };
  const { desc, ...rest } = cfg;
  $('idx-editor').classList.remove('hidden');
  $('idx-preview-out').classList.add('hidden');
  $('idx-editor-title').textContent = ix ? (ix.key ? `Index-Quelle: ${ix.key}` : 'Index-Quelle: Standard') : 'Neue Index-Quelle';
  $('idx-key').value = ix?.key ?? '';
  $('idx-key').disabled = false;
  $('idx-desc').value = typeof desc === 'string' ? desc : '';
  $('idx-config').value = JSON.stringify(rest, null, 2);
  $('idx-probe').value = '';
}

function indexPayload() {
  let cfg = {};
  try {
    cfg = JSON.parse($('idx-config'.value));
  } catch {
    throw new Error('Config ist kein gültiges JSON');
  }
  if (!cfg.tool || !String(cfg.tool).trim()) throw new Error('Config braucht ein "tool"');
  cfg.desc = $('idx-desc').value.trim();
  return cfg;
}

export async function saveIndexUi() {
  try {
    const cfg = indexPayload();
    const key = $('idx-key').value.trim().toLowerCase();
    if (key && !/^[a-z0-9_]{1,30}$/.test(key)) throw new Error('Key: a-z 0-9 _, max. 30');
    await api(`/indexes/${key}`, { method: 'PUT', body: JSON.stringify({ config: JSON.stringify(cfg) }) });
    $('idx-editor').classList.add('hidden');
    await renderIndexes();
  } catch (e) {
    alert(`Speichern fehlgeschlagen: ${e.message}`);
  }
}

export async function deleteIndexUi() {
  const key = $('idx-key').value.trim().toLowerCase();
  if (!key) {
    alert('Der Standard-Index kann nicht gelöscht werden — leere das Config-JSON statt dessen (per Speichern) oder lösche über die Settings-API.');
    return;
  }
  if (!confirm(`Index-Quelle "${key}" löschen?`)) return;
  try {
    await api(`/indexes/${key}`, { method: 'DELETE' });
    $('idx-editor').classList.add('hidden');
    await renderIndexes();
  } catch (e) {
    alert(`Löschen fehlgeschlagen: ${e.message}`);
  }
}

export async function previewIndex() {
  const out = $('idx-preview-out');
  out.classList.remove('hidden');
  out.textContent = 'Rendere …';
  const probe = ($('idx-probe').value || '').replace(/['\\]/g, '').trim();
  const key = $('idx-key').value.trim().toLowerCase();
  const tpl = key
    ? `{{ index.find('${probe}', '${key}') }}`
    : `{{ index.find('${probe}') }}`;
  try {
    const d = await api('/functions/preview', {
      method: 'POST',
      body: JSON.stringify({ template: tpl }),
    });
    const steps = (d.trace ?? []).map((t) => `${t.step}${t.detail ? ' ' + JSON.stringify(t.detail).slice(0, 60) : ''}`).join(' → ');
    out.textContent = `${d.rendered?.speech ?? ''}\n\n[trace] ${steps || '(keine Datenabrufe)'}`;
  } catch (e) {
    out.textContent = `Fehler: ${e.message}`;
  }
}
