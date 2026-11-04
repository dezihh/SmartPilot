import { API, $, api, esc } from './lib.js';

let testPackageHandler = () => {};
export function setTestPackageHandler(fn) { testPackageHandler = fn; }
export function getPackageForTest(id) { return (pkgState.installed ?? []).find((x) => x.id === id) ?? null; }

// ---- Wartung und Pakete ----

let pkgState = { registry: [], installed: [], selected: null, preview: null, language: 'de' };


// Diff-Status als Chip + Wert-Darstellung (leer/Objekt).
function statusChip(status) {
  const map = { new: ['chip ok', 'neu'], changed: ['chip update', 'geändert'], unchanged: ['chip', 'unverändert'], conflict: ['chip update', 'Konflikt (lokal)'] };
  const [cls, label] = map[status] ?? ['chip', String(status)];
  return `<span class="${cls}">${label}</span>`;
}
const KIND_LABELS = { server: 'Server', function: 'Funktion', action: 'Vorgang', index: 'Index' };
const FIELD_LABELS = {
  command: 'Kommando', args: 'Argumente', env: 'Umgebungsvariablen', npm_spec: 'Paket (npm)', url: 'URL',
  auth_token: 'Token', transport: 'Transport', inventory_prompt: 'Inventory-Prompt', side_effect: 'Wirkung auf Index',
  enabled: 'Aktiv', name: 'Name', description: 'Beschreibung', template: 'Vorlage/Template', parameters: 'Parameter',
  budget: 'Budget', mode: 'Modus', trigger_phrases: 'Trigger-Phrasen', fuzzy_threshold: 'Fuzzy-Schwelle',
  system_prompt: 'System-Prompt', function_ref: 'Funktion', function_args: 'Funktions-Args', tools: 'Tools',
};
function labelField(f) { return FIELD_LABELS[f] ?? f; }
function fmtVal(v) {
  if (v === null || v === undefined || v === '') return '(leer)';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
// Kurze Werte inline "alt → neu"; lange Werte einklappbar (Template/Prompt).
function diffValue(from, to) {
  const a = fmtVal(from);
  const b = fmtVal(to);
  const long = a.length > 80 || b.length > 80 || a.includes('\n') || b.includes('\n');
  if (!long) return `<code>${esc(a)}</code> → <code>${esc(b)}</code>`;
  const short = (s) => esc(s.length > 80 ? `${s.slice(0, 80)}…` : s);
  return `<details><summary>${short(a)} → ${short(b)} (${a.length}/${b.length} Zeichen)</summary><pre class="pkg-docs">alt:  ${esc(a)}\n\nneu:  ${esc(b)}</pre></details>`;
}

// Semantischer Versionsvergleich (nur Ziffernteile; robust gegen fehlende Teile).
function cmpVersion(a, b) {
  const pa = String(a ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export async function loadMaintenance() {
  try {
    const data = await api('/packages');
    pkgState.installed = data.installed ?? [];
    pkgState.language = data.language ?? 'de';
    pkgState.registry = data.registry ?? [];
    renderPackages();
  } catch (e) {
    $('pkg-available').innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
    $('pkg-installed').innerHTML = '';
  }
}

function renderPackages() {
  const installedById = new Map(pkgState.installed.map((p) => [p.id, p]));
  const avail = pkgState.registry.map((p) => {
    const inst = installedById.get(p.id);
    const update = inst && cmpVersion(inst.version, p.version) < 0;
    const chip = !inst
      ? ''
      : update
        ? `<span class="chip update">Update verfügbar: v${esc(p.version)}</span>`
        : '<span class="chip ok">installiert</span>';
    return `<div class="pkg-item"><div><strong>${esc(p.name)}</strong> <span class="pkg-version">v${esc(p.version)}</span> <span class="pkg-id">${esc(p.id)}</span> ${chip}<div class="field-help">${esc(p.summary)} <a href="https://github.com/dezihh/SmartPilot/blob/main/packages/${esc(pkgState.language ?? 'de')}/${esc(p.id)}/README.md" target="_blank" rel="noopener">Installations-Doku</a></div></div><button class="btn" data-install="${esc(p.id)}">${inst ? 'Neu installieren' : 'Installieren'}</button></div>`;
  });
  $('pkg-available').innerHTML = avail.length ? avail.join('') : '<div class="field-help">Registry leer oder nicht erreichbar — „Aktualisieren“ versucht es erneut.</div>';
  const instList = pkgState.installed.map((p) => {
    const reg = pkgState.registry.find((r) => r.id === p.id);
    const update = reg && cmpVersion(p.version, reg.version) < 0;
    const chip = update ? ` <span class="chip update">Update verfügbar: v${esc(reg.version)}</span>` : '';
    const itemRows = (p.items ?? []).map((i) => `<li><span class="kind">${esc(KIND_LABELS[i.kind] ?? i.kind)}</span> ${esc(i.name)}</li>`).join('');
    return `<div class="pkg-installed-item">
      <div class="pkg-card-head">
        <div class="pkg-card-title"><strong>${esc(p.id)}</strong> <span class="pkg-version">v${esc(p.version)}</span>${chip} <span class="pkg-version">${esc(p.source)}</span></div>
        <div class="pkg-actions">
          <button class="btn" data-testpkg="${esc(p.id)}" title="Ersten Vorgang des Pakets im Monitor ausführen">Testen</button>
          <button class="btn" data-reinstall="${esc(p.id)}">Neu installieren</button>
          <button class="btn danger" data-uninstall="${esc(p.id)}">Entfernen</button>
        </div>
      </div>
      <div class="field-help">${esc(p.installed_at)}</div>
      <details class="pkg-items"><summary>Enthält (${(p.items ?? []).length})</summary><ul>${itemRows}</ul></details>
    </div>`;
  });
  $('pkg-installed').innerHTML = instList.length ? instList.join('') : '<div class="field-help">Noch keine Pakete installiert.</div>';
  for (const b of document.querySelectorAll('#pkg-available [data-install]')) b.onclick = () => showInstallForm(b.dataset.install, false);
  for (const b of document.querySelectorAll('[data-reinstall]')) b.onclick = () => showInstallForm(b.dataset.reinstall, null);
  for (const b of document.querySelectorAll('[data-testpkg]')) b.onclick = () => testPackageHandler(b.dataset.testpkg);
  for (const b of document.querySelectorAll('[data-uninstall]')) b.onclick = async () => {
    if (!confirm(`Paket "${b.dataset.uninstall}" entfernen? Nur unveränderte Zeilen werden gelöscht.`)) return;
    try {
      const r = await api(`/packages/${encodeURIComponent(b.dataset.uninstall)}/uninstall`, { method: 'POST' });
      const parts = [];
      if (r.report?.removed?.length) parts.push('Entfernt: ' + r.report.removed.join(', '));
      if (r.report?.kept?.length) parts.push('Behalten: ' + r.report.kept.join(', '));
      alert(parts.join('\n') || 'Entfernt.');
      loadMaintenance();
    } catch (e) { alert(e.message); }
  };
}

function paramForm(manifest, current = {}) {
  return (manifest.params ?? []).map((p) => {
    const isSet = current[p.key] != null && current[p.key] !== '';
    if (p.secret) {
      const ph = isSet ? '(gesetzt – leer lassen zum Behalten)' : (p.placeholder ?? '');
      return `<label>${esc(p.label)}${p.required && !isSet ? ' *' : ''}</label><input data-param="${esc(p.key)}" type="password" placeholder="${esc(ph)}" value="">`;
    }
    const val = isSet ? current[p.key] : (p.default ?? '');
    return `<label>${esc(p.label)}${p.required ? ' *' : ''}</label><input data-param="${esc(p.key)}" type="text" placeholder="${esc(p.placeholder ?? p.default ?? '')}" value="${esc(val)}">`;
  }).join('');
}

async function showInstallForm(id, manifestFromImport) {
  try {
    let preview = manifestFromImport;
    if (!preview) preview = await api(`/packages/manifest/${encodeURIComponent(id)}`);
    pkgState.selected = { id, preview };
    const m = preview.manifest;
    const instRow = pkgState.installed.find((p) => p.id === id) ?? null;
    const installed = !!instRow;
    let currentParams = {};
    if (instRow && instRow.params) { try { currentParams = JSON.parse(instRow.params); } catch { currentParams = {}; } }
    // Diff-Vorschau (kein Schreiben): zeigt vor dem Speichern, was sich aendert.
    let diff = { diffs: [], restartRequired: false, npmServers: [] };
    try { diff = await api(`/packages/${encodeURIComponent(id)}/diff`, { method: 'POST', body: {} }); } catch { diff = { diffs: [], restartRequired: false, npmServers: [] }; }
    const allDiffs = diff.diffs ?? [];
    // Konflikte: bevorzugt mit Feld-Diffs aus der Vorschau, sonst aus /conflicts.
    let conflicts = allDiffs.filter((d) => d.status === 'conflict');
    if (!conflicts.length && installed) {
      let names = [];
      try { names = (await api(`/packages/${encodeURIComponent(id)}/conflicts`)).conflicts ?? []; } catch { names = []; }
      conflicts = names.map((k) => ({ key: k, kind: String(k).split(':')[0], name: String(k).split(':')[1], fields: [] }));
    }
    const changed = allDiffs.filter((d) => d.status !== 'unchanged' && d.status !== 'conflict');
    const diffItem = (d) => `<li class="diff-item"><div class="diff-item-head"><span class="kind">${esc(KIND_LABELS[d.kind] ?? d.kind)}</span> <strong>${esc(d.name)}</strong> ${statusChip(d.status)}</div>${d.fields?.length ? `<ul class="diff-fields">${d.fields.map((f) => `<li><span class="diff-field-name">${esc(labelField(f.field))}</span> ${diffValue(f.from, f.to)}</li>`).join('')}</ul>` : ''}</li>`;
    const diffHtml = changed.length
      ? `<div class="diff-block"><h4>Änderungen gegenüber installiert <span class="chip update">${changed.length}</span></h4><ul class="diff-list">${changed.map(diffItem).join('')}</ul></div>`
      : (installed ? '<div class="diff-block"><h4>Änderungen gegenüber installiert</h4><div class="field-help">Keine inhaltlichen Änderungen — bereits auf Registry-Stand.</div></div>' : '');
    const restartHtml = diff.restartRequired
      ? `<div class="error-text pkg-danger">⚠️ Container-Neustart erforderlich nach dem Speichern: npm-Paket${(diff.npmServers ?? []).length ? ` (${(diff.npmServers).map(esc).join(', ')})` : ''} wird erst beim nächsten Start provisioniert (z. B. <code>./compose.sh restart</code>).</div>`
      : '';
    const danger = preview.dangerous ? `<div class="error-text pkg-danger">⚠️ Gefährliche Aktion: ${(preview.dangerousItems ?? []).map((i) => esc(i)).join(' · ')}</div>` : '';
    const info = (preview.infoItems ?? []).length ? `<div class="field-help">${(preview.infoItems ?? []).map((i) => esc(i)).join(' · ')}</div>` : '';
    const items = (preview.items ?? []).map((i) => `<li>${esc(i.kind)}: ${esc(i.name)}</li>`).join('');
    const meta = [
      m.author ? `Autor: ${esc(m.author)}` : '',
      m.license ? `Lizenz: ${esc(m.license)}` : '',
      m.language ? `Sprache: ${esc(m.language)}` : '',
      m.minGatewayVersion ? `min. Gateway ${esc(m.minGatewayVersion)}` : '',
    ].filter(Boolean).join(' · ');
    const metaHtml = meta ? `<p class="field-help">${meta}</p>` : '';
    const securityHtml = `<p class="field-help">Sicherheit: ${preview.dangerous ? '⚠️ führt Shell-Befehle aus (Bestätigung nötig)' : (preview.infoItems ?? []).length ? 'ruft externe Dienste auf (Info)' : 'nur lesend / unkritisch'}</p>`;
    const changelogHtml = m.changelog ? `<details><summary>Changelog</summary><pre class="pkg-docs">${esc(m.changelog)}</pre></details>` : '';
    const conflictFields = (d) => d.fields?.length ? `<ul class="diff-fields">${d.fields.map((f) => `<li><span class="diff-field-name">${esc(labelField(f.field))}</span> lokal <code>${esc(fmtVal(f.from))}</code> → Paket <code>${esc(fmtVal(f.to))}</code></li>`).join('')}</ul>` : '';
    const conflictsHtml = conflicts.length ? `
      <div class="diff-block pkg-conflicts">
        <h4>Lokale Änderungen erkannt <span class="chip update">${conflicts.length}</span></h4>
        <p class="field-help">Standard: deine lokale Version behalten. Wähle „Paket-Version übernehmen", um sie durch das Paket zu ersetzen.</p>
        <ul class="diff-list">${conflicts.map((d) => `<li class="diff-item"><div class="diff-item-head"><span class="kind">${esc(KIND_LABELS[d.kind] ?? d.kind)}</span> <strong>${esc(d.name)}</strong></div>${conflictFields(d)}
          <select data-decision="${esc(d.key)}">
            <option value="keep">Lokale Änderung behalten</option>
            <option value="take">Paket-Version übernehmen</option>
          </select></li>`).join('')}</ul>
      </div>` : '';
    const formEl = $('pkg-install-form');
    formEl.classList.remove('hidden');
    formEl.innerHTML = `
      <h3>${esc(m.name)} <span class="pkg-version">v${esc(m.version)}</span></h3>
      <p class="field-help">${esc(m.description ?? '')}</p>
      ${metaHtml}
      ${securityHtml}
      ${m.requires ? `<p class="field-help"><strong>Benötigt:</strong> ${esc(m.requires)}</p>` : ''}
      ${danger}${info}
      ${conflictsHtml}
      ${restartHtml}${diffHtml}
      <div class="pkg-items"><strong>Enthält:</strong><ul>${items}</ul></div>
      ${preview.setupDocs ? `<details><summary>Einrichtung Gegenseite</summary><pre class="pkg-docs">${esc(preview.setupDocs)}</pre></details>` : ''}
      ${changelogHtml}
      <div class="form-grid">${paramForm(m, currentParams)}</div>
      <div class="toolbar">
        <button id="pkg-install-go" class="btn primary">${installed ? 'Aktualisieren' : 'Installieren'}</button>
        <button id="pkg-install-cancel" class="btn">Abbrechen</button>
      </div>`;
    // Formular in den Blick scrollen: „Neu installieren" aus der Liste
    // „Installierte Pakete" oeffnet es sonst im oberen Card ausserhalb des
    // sichtbaren Bereichs - das wirkt, als passiere nichts.
    formEl.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    $('pkg-install-go').onclick = async () => {
      const params = {};
      for (const input of $('pkg-install-form').querySelectorAll('[data-param]')) params[input.dataset.param] = input.value;
      const decisions = {};
      for (const sel of $('pkg-install-form').querySelectorAll('[data-decision]')) decisions[sel.dataset.decision] = sel.value;
      try {
        const body = { params, dangerousAck: !!preview.dangerous, decisions };
        if (manifestFromImport) body.manifest = manifestFromImport.manifest;
        const r = await api(`/packages/${encodeURIComponent(id)}/install`, { method: 'POST', body });
        const rep = r.report;
        let msg = `Angelegt: ${rep.created.length}\nAktualisiert: ${rep.updated.length}\nBehalten: ${rep.kept?.length ?? 0}`;
        if (rep.infoItems?.length) msg += `\nInfo: ${rep.infoItems.join(' · ')}`;
        if (rep.restartRequired) {
          msg += `\n\n⚠️ Container-Neustart erforderlich, damit das npm-Paket provisioniert wird${(rep.npmServers ?? []).length ? ` (${rep.npmServers.join(', ')})` : ''}. z. B. ./compose.sh restart`;
        }
        alert(msg);
        showInstallFormClose();
        loadMaintenance();
      } catch (e) { alert(e.message); }
    };
    $('pkg-install-cancel').onclick = showInstallFormClose;
  } catch (e) { alert(e.message); }
}

function showInstallFormClose() { $('pkg-install-form').classList.add('hidden'); $('pkg-install-form').innerHTML = ''; }

$('pkg-refresh').onclick = loadMaintenance;
$('pkg-import-preview').onclick = async () => {
  try {
    const manifest = JSON.parse($('pkg-import-manifest').value);
    const preview = await api('/packages/preview', { method: 'POST', body: { manifest } });
    await showInstallForm(preview.manifest.id, preview);
  } catch (e) { alert(e.message); }
};
$('backup-download').onclick = async () => {
  const tokens = $('backup-with-tokens').checked ? '1' : '0';
  const res = await fetch(`${API}/backup?tokens=${tokens}`, { headers: { Authorization: `Bearer ${$('token').value.trim()}` } });
  if (!res.ok) { alert(`Sicherung fehlgeschlagen (HTTP ${res.status})`); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `smartpilot-config-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  URL.revokeObjectURL(url);
};
$('backup-restore').onclick = async () => {
  const file = $('backup-file').files?.[0];
  if (!file) { alert('Bitte Sicherungsdatei wählen.'); return; }
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { alert('Keine gültige JSON-Datei.'); return; }
  if (!confirm('Achtung: Die aktuelle Konfiguration (Settings, Prompts, Server, Funktionen, Vorgänge, Paket-Provenienz) wird KOMPLETT ersetzt. Fortfahren?')) return;
  try {
    await api('/backup/restore', { method: 'POST', body: { backup, confirm: true } });
    alert('Rücksicherung abgeschlossen.');
    loadMaintenance();
  } catch (e) { alert(e.message); }
};
