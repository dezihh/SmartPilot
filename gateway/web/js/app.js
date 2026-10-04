// API-Basis relativ zur Admin-Seite: funktioniert auch unter einem Pfad-Prefix
// (BASE_PATH), z. B. /smartpilot/admin/.
const API = (() => {
  const src = document.currentScript && document.currentScript.src;
  return src ? new URL('../api', src).pathname : '/admin/api';
})();
let bootstrap = { settings: {}, actions: [], functions: [], servers: [], prompts: [] };

function token() {
  // Session-Cookie (va_session) authentifiziert via requireAdminAuth; nur bei
  // explizit eingetragenem Token im Token-Feld kommt ein Bearer mit.
  return document.body.dataset.token ?? '';
}

async function api(path, options = {}) {
  const body = options.body && typeof options.body === 'object' ? JSON.stringify(options.body) : options.body;
  const res = await fetch(`${API}${path}`, {
    ...options,
    body,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token()}`,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function loadBootstrap() {
  try {
    bootstrap = await api('/bootstrap');
    renderSettings();
    renderPromptKeys();
    renderActions();
    renderFunctions();
    renderIndexes();
    renderServers();
  } catch (e) {
    alert(`Bootstrap fehlgeschlagen: ${e.message}`);
  }
}

function showTab(name) {
  document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  const titles = { settings: 'Grundeinstellungen', monitor: 'Monitor / Test', actions: 'Vorgänge', functions: 'Funktionen', indexes: 'Index-Quellen', mcp: 'Tool-Registry', maintenance: 'Wartung und Pakete', logs: 'Logs' };
  $('tab-title').textContent = titles[name] ?? '';
  // Sicht beim Wechsel immer frisch aus dem Backend laden - sonst sind
  // Aenderungen (z. B. durch Pakete) erst nach manuellem Browser-Reload sichtbar.
  if (name === 'logs') loadLogs();
  else if (name === 'maintenance') loadMaintenance();
  else if (name !== 'monitor') loadBootstrap();
}

const SETTINGS_FIELDS = [
  {
    key: 'assistant_name',
    label: 'Assistenten-Name',
    type: 'text',
    help: 'So stellt sich der Agent im Gespräch vor (Standard: Dein SmartPilot). Gilt für Sprache und Text; die Überschrift auf dem Echo-Display wird separat unter „Display-Titel" gesetzt.',
  },
  {
    key: 'display_title',
    label: 'Display-Titel (APL)',
    type: 'text',
    help: 'Überschrift des APL-Displays auf Echo-Show-Geräten. Wirkt ab der nächsten Anfrage, kein Neustart nötig.',
  },
  {
    key: 'registry_language',
    label: 'Paket-Registry-Sprache',
    type: 'text',
    help: 'Sprachordner in der Paket-Registry (Standard: de). Die Installation sucht Pakete unter packages/<Sprache>/ im SmartPilot-Repo.',
  },
  {
    key: 'llm_model',
    label: 'LLM-Modell',
    type: 'text',
    help: 'Modell für alle LLM-Aufrufe (Agent, Hybrid-Formulierung, Index-Assistent). Leer = Default aus .env. Wirkt ab der nächsten Anfrage, kein Neustart. Muss Tool-/JSON-fähig sein, sonst scheitern Agent-Antworten.',
  },
  {
    key: 'tool_model',
    label: 'Tool-Modell (optional)',
    type: 'text',
    help: 'Eigenes Modell nur für die Tool-Runden des Agenten; die Formulierung läuft auf LLM-Modell. Leer = überall dasselbe Modell. Nützlich als gestufte A/B-Schleuse beim Modellwechsel: erst Tool-Runden auf dem Kandidaten testen, dann ganz umstellen. Muss Tool-fähig sein.',
  },
  {
    key: 'llm_max_tokens',
    label: 'LLM max. Tokens',
    type: 'number',
    help: 'Deckel für die Antwortlänge des LLM in Tokens. Leer = Default aus .env. Reasoner-Modelle brauchen >= 800, sonst leere Antworten. Zu klein schneidet lange Berichte ab.',
  },
  {
    key: 'llm_reasoning_effort',
    label: 'LLM Reasoning-Stufe',
    type: 'text',
    help: 'Nur für Reasoner-Modelle: low/medium/high. Leer = wie .env (meist ungesetzt). Bei Normalmodellen ohne Wirkung.',
  },
  {
    key: 'max_tool_iterations',
    label: 'Agent max. Tool-Runden',
    type: 'number',
    help: 'Wie viele Tool-Runden der Agent pro Frage maximal laufen lässt. Leer = Default (4). Jede Runde kostet LLM-Zeit; die letzte Runde formuliert zwingend (kein Budget-Tod).',
  },
  {
    key: 'tool_deadline_ms',
    label: 'Agent-Tool-Deadline (ms)',
    type: 'number',
    help: 'Deadline pro Tool-Runde des Agenten; das Gesamtbudget ist etwa das Doppelte. Leer = Default (12000). Muss in Amazons Antwortfenster (~8 s, HTTPS-Pfad) passen – der Warteton überbrückt die Wartezeit.',
  },
  {
    key: 'agent_tools',
    label: 'Agent-Tool-Allowlist',
    type: 'tools',
    span: true,
    help: 'Angehakt = das Tool kommt als Spec in den Agenten-Prompt. Keins angehakt = der Agent läuft ohne Tool-Specs. Die Buttons „Alle anhaken/abwählen" setzen die Auswahl auf einmal; gespeichert wird immer die explizite Liste („keine" bei leerer Auswahl).',
  },
  {
    key: 'fuzzy_global',
    label: 'Fuzzy-Trigger global',
    type: 'select',
    options: [['1', 'An'], ['0', 'Aus']],
    help: 'Trigger-Phrasen der Vorgänge müssen nicht wortwörtlich getroffen werden – kleine Abweichungen („wie ist der Hausstatus" statt „hausstatus abfragen") reichen. „Aus" = nur exakte Übereinstimmung. Feiner steuerbar über den Schwellwert im jeweiligen Vorgang.',
  },
  {
    key: 'session_followup',
    label: 'Nachfrage (Mikro offen halten)',
    type: 'select',
    options: [['llm', 'Wenn das LLM es vorschlägt'], ['keyword', 'Bei Session-Keyword'], ['beides', 'Beides'], ['0', 'Nie']],
    help: 'Nach der Antwort bleibt das Mikro offen und es folgt „Was kann ich noch für Sie tun?". „LLM-vorgeschlagen": das Modell meldet eine Rückfrage als sinnvoll (z. B. nach Berichten). „Bei Session-Keyword": sobald die Frage eines der Keywords unten enthält. „Nie": Session schließt immer. In einer laufenden Chat-Session bleibt das Mikro ohnehin offen.',
  },
  {
    key: 'debug_logging',
    label: 'Debug-Logging',
    type: 'select',
    options: [['0', 'Aus (Betrieb)'], ['1', 'An (Fehlersuche)']],
    help: 'Schreibt ausführliche Schritte (Tool-Aufrufe, Router-Entscheidungen) ins Gateway-Log (docker logs). Für den Alltag aus lassen – spart Lautstärke und macht Logs lesbar.',
  },
  {
    key: 'memory_turns',
    label: 'Kontext für Folgefragen (Turns)',
    type: 'number',
    help: 'Wie viele vorangegangene Frage-Antwort-Paare das LLM pro Frage zusätzlich sieht — im laufenden Gespräch und beim Wiedereinstieg über alte Log-Einträge (gleiche Zahl). Hoher Wert = bessere Anknüpfung, aber größerer Prompt (Rundenzeit). Leer = Default 4.',
  },
  {
    key: 'memory_minutes',
    label: 'Kontext-Rückblick (Minuten)',
    type: 'number',
    help: 'Wie weit beim Wiedereinstieg (neue Session, z. B. nach Pause oder Gateway-Neustart) aus dem Log zurückgelesen wird. Innerhalb der Zeit gilt die Frage-Antwort-Historie als „frühere Unterhaltung", danach nicht mehr. Leer = Default 30.',
  },
  {
    key: 'http_timeout_ms',
    label: 'http()-Timeout (ms)',
    type: 'number',
    help: 'Timeout für http()-Abrufe in Funktions-Templates. Leer = Default (5000). Kurz halten, damit Vorgänge rechtzeitig antworten; wirkt sofort.',
  },
  {
    key: 'http_body_cap',
    label: 'http()-Antwortgrenze (Zeichen)',
    type: 'number',
    help: 'Maximale Länge einer http()-Antwort, die ins Template/Trace geht. Leer = Default (100000). Schutz gegen riesige Antworten.',
  },
  {
    key: 'session_keywords',
    label: 'Session-Keywords',
    type: 'textarea',
    span: true,
    rows: 3,
    help: 'Komma-getrennte Liste (z. B. zusammenfassung, bericht, news). Enthält die gerade gestellte Frage eines dieser Wörter, bekommt DIESE Antwort ein Follow-up und das Mikro bleibt danach offen; die nächste Frage entscheidet erneut (Keyword oder LLM-Vorschlag). Der Schalter dafür steht in den GRUNDEINSTELLUNGEN im Feld „Nachfrage (Mikro offen halten)" weiter oben — dort „Bei Session-Keyword" oder „Beides" wählen.',
  },
];


function renderSettings() {
  const form = $('settings-form');
  form.innerHTML = '';
  const known = new Set(SETTINGS_FIELDS.map((f) => f.key));
  // Bekannte Felder immer zeigen (auch ohne DB-Zeile): leer = Default.
  for (const field of SETTINGS_FIELDS) {
    form.append(buildSettingField(field));
  }
  for (const key of Object.keys(bootstrap.settings)) {
    if (key === 'entity_index' || key.startsWith('entity_index_')) continue;
    if (!known.has(key)) form.append(buildSettingField({ key, label: key, type: 'text', help: '' }));
  }
  void loadSettingToolPickers();
}

function updateSettingToolsSummary(key, pickedCount, totalCount) {
  const sum = $(`settings-tools-summary-${key}`);
  if (!sum) return;
  sum.textContent = pickedCount
    ? `Ausgewählt (${pickedCount} von ${totalCount}) — nur diese Tools bekommt der Agent als Spec.`
    : 'Keins angehakt = KEINE Tools — der Agent läuft ohne Tool-Specs.';
}

async function loadSettingToolPickers() {
  for (const f of SETTINGS_FIELDS.filter((x) => x.type === 'tools')) {
    const listId = `settings-tools-${f.key}`;
    const list = $(listId);
    if (!list) continue;
    const current = String(bootstrap.settings[f.key] ?? '').trim();
    const sync = () => {
      const ctrl = document.querySelector(`#settings-form [data-key="${f.key}"]`);
      const picked = toolsFromList(listId);
      if (ctrl) ctrl.value = picked.join(', ');
      updateSettingToolsSummary(f.key, picked.length, list.querySelectorAll('input[type=checkbox]').length);
    };
    if (current.toLowerCase() === 'alle') {
      await loadToolPicker([], listId, sync);
      list.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = true; });
    } else {
      await loadToolPicker(current.split(',').map((x) => x.trim()).filter(Boolean), listId, sync);
    }
    sync();
  }
}

// Globales Hilfe-Overlay: klick auf einen "?..."-Button zeigt den Hilfetext
// als schwebendes Popup am Button (statt Text unter der Zeile, der Layout
// verschiebt). Quelle: data-help am Button, sonst das .field-help-Element
// im selben Feld, sonst das title-Attribut.
const helpPop = document.createElement('div');
helpPop.className = 'help-pop hidden';
helpPop.setAttribute('role', 'tooltip');
document.body.append(helpPop);
let helpAnchor = null;

function hideHelpPop() {
  helpPop.classList.add('hidden');
  helpAnchor = null;
}

function showHelpPop(btn) {
  const scope = btn.closest('.field') || btn.parentElement;
  const text =
    btn.getAttribute('data-help') ||
    scope?.querySelector('.field-help')?.textContent ||
    btn.getAttribute('title') ||
    '';
  if (!text.trim()) return;
  helpPop.textContent = text.trim();
  helpPop.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const pw = helpPop.offsetWidth;
  const ph = helpPop.offsetHeight;
  const left = Math.min(Math.max(4, r.left), window.innerWidth - pw - 8);
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(4, r.top - ph - 6);
  helpPop.style.left = `${Math.round(left)}px`;
  helpPop.style.top = `${Math.round(top)}px`;
}

document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('button.help') : null;
  if (btn) {
    if (helpAnchor === btn && !helpPop.classList.contains('hidden')) {
      hideHelpPop();
    } else {
      helpAnchor = btn;
      showHelpPop(btn);
    }
    e.stopPropagation();
    return;
  }
  if (!helpPop.contains(e.target)) hideHelpPop();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideHelpPop();
});
window.addEventListener('scroll', hideHelpPop, true);
window.addEventListener('resize', hideHelpPop);

// Native Browser-Tooltips (title) an Hilfe-Buttons abschalten: Text wandert
// nach data-help, damit ausschliesslich das Overlay zeigt.
for (const btn of document.querySelectorAll('button.help[title]')) {
  btn.setAttribute('data-help', btn.getAttribute('title') ?? '');
  btn.removeAttribute('title');
}

function buildSettingField(field) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  if (field.span) wrap.classList.add('span-full');
  const head = document.createElement('div');
  head.className = 'field-head';
  const label = document.createElement('label');
  label.textContent = field.label;
  head.append(label);
  const controlValue = bootstrap.settings[field.key] ?? '';
  if (field.help) {
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'help';
    help.textContent = '?';
    help.setAttribute('aria-label', `Hilfe zu ${field.label}`);
    help.dataset.help = field.help;
    head.append(help);
  }
  let control;
  const placeholder = bootstrap.settingDefaults?.[field.key] ?? '';
  if (field.type === 'tools') {
    control = document.createElement('input');
    control.type = 'text';
    control.value = String(controlValue);
    control.style.display = 'none';
    const summary = document.createElement('div');
    summary.className = 'field-help';
    summary.id = `settings-tools-summary-${field.key}`;
    const picker = document.createElement('div');
    picker.id = `settings-tools-${field.key}`;
    picker.className = 'tool-group';
    picker.style.marginTop = '0.4rem';
    picker.dataset.sync = field.key;
    wrap.append(head, control, summary, picker);
    return wrap;
  }
  if (field.type === 'select') {
    control = document.createElement('select');
    const current = String(controlValue);
    for (const [value, text] of field.options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      if (value === current) opt.selected = true;
      control.append(opt);
    }
  } else if (field.type === 'textarea') {
    control = document.createElement('textarea');
    control.rows = field.rows ?? 8;
    control.value = controlValue;
    control.placeholder = placeholder ? `(leer = Default: ${placeholder})` : '';
  } else if (field.type === 'number') {
    control = document.createElement('input');
    control.type = 'number';
    control.value = controlValue;
    control.placeholder = placeholder;
  } else {
    control = document.createElement('input');
    control.type = 'text';
    control.value = controlValue;
    control.placeholder = placeholder ? `(leer = Default: ${placeholder})` : '';
  }
  control.dataset.key = field.key;
  wrap.append(head, control);
  if (field.help) {
    const helpText = document.createElement('div');
    helpText.className = 'field-help hidden';
    helpText.textContent = field.help;
    wrap.append(helpText);
  }
  return wrap;
}

function growPromptTextarea() {
  const ta = $('prompt-content');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 4, 480)}px`;
}

function renderPromptKeys() {
  const select = $('prompt-key');
  const ta = $('prompt-content');
  select.innerHTML = '';
  for (const p of bootstrap.prompts) {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = p.key;
    select.append(opt);
  }
  select.onchange = () => {
    const p = bootstrap.prompts.find((x) => x.key === select.value);
    ta.value = p ? p.content : '';
    growPromptTextarea();
  };
  select.onchange();
  ta.addEventListener('input', growPromptTextarea);
}

function renderActions() {
  const tbody = $('actions-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const a of bootstrap.actions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(a.name)}</td>
      <td><span class="badge">${esc(a.mode)}</span></td>
      <td>${esc((a.triggers ?? []).join(', '))}</td>
      <td>${a.enabled ? '✔' : '✖'}</td>
      <td class="actions"><button class="btn small" data-test title="Ersten Trigger im Monitor ausführen">Testen</button><button class="btn small">Bearbeiten</button></td>`;
    const buttons = tr.querySelectorAll('button');
    buttons[0].onclick = () => testInMonitor((a.triggers ?? [])[0] || a.name);
    buttons[1].onclick = () => openActionEditor(a.id);
    tbody.append(tr);
  }
}

function toolsFromList(listId) {
  const checks = document.querySelectorAll(`#${listId} input[type=checkbox]:checked`);
  return Array.from(checks).map((c) => c.value);
}

function syncActionToolsInput() {
  const picked = toolsFromList('action-tools-list');
  $('action-tools').value = picked.join('\n');
  const sum = $('action-tools-summary');
  if (sum) {
    sum.textContent = picked.length
      ? `Ausgewählt (${picked.length}) — diese Tools dürfen die LLM-Modi des Vorgangs nutzen.`
      : 'Nichts angehakt = KEINE Tool-Specs (Vorgang läuft ohne Tools, z. B. reine Formulierung).';
  }
}

async function loadToolPicker(selected, listId = 'action-tools-list', syncFn = syncActionToolsInput) {
  const list = $(listId);
  list.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  bar.style.gap = '0.4rem';
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'btn small';
  allBtn.textContent = 'Alle anhaken';
  allBtn.onclick = () => { list.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = true; }); syncFn(); };
  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.className = 'btn small';
  noneBtn.textContent = 'Alle abwählen';
  noneBtn.onclick = () => { list.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = false; }); syncFn(); };
  bar.append(allBtn, noneBtn);
  list.append(bar);
  const sel = new Set(selected ?? []);
  function group(label, names) {
    if (!names.length) return;
    const det = document.createElement('details');
    det.className = 'tool-group';
    const sum = document.createElement('summary');
    sum.textContent = `${label} (${names.length})`;
    det.append(sum);
    for (const name of names) {
      const lab = document.createElement('label');
      lab.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = name;
      cb.checked = sel.has(name);
      cb.addEventListener('change', syncFn);
      lab.append(cb, ' ', name);
      det.append(lab);
    }
    list.append(det);
  }
  try {
    const info = await api('/tools');
    group('Funktionen (als LLM-Tools)', info.functions ?? []);
    for (const srv of info.mcp ?? []) group(`${srv.server} (MCP)`, srv.tools ?? []);
  } catch {
    // Tools nicht ladbar: Editor trotzdem nutzbar (dann manuell)
  }
}

function renderFunctions() {
  const tbody = $('functions-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const f of bootstrap.functions ?? []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code title="Einbettung in Templates: {{ fn('${esc(f.name)}') }}">${esc(f.name)}</code></td>
      <td>${esc(f.description)}</td>
      <td>${f.enabled ? '✔' : '✖'}</td>
      <td class="actions"><button class="btn small">Bearbeiten</button></td>`;
    tr.querySelector('button').onclick = () => openFunctionEditor(f.id);
    tbody.append(tr);
  }
}

function openFunctionEditor(id) {
  const f = id ? (bootstrap.functions ?? []).find((x) => x.id === id) : null;
  $('fn-editor').classList.remove('hidden');
  $('fn-preview-out').classList.add('hidden');
  $('fn-editor-title').textContent = f ? `Funktion: ${f.name}` : 'Neue Funktion';
  $('fn-id').value = f?.id ?? '';
  $('fn-name').value = f?.name ?? '';
  $('fn-description').value = f?.description ?? '';
  $('fn-inventory-prompt').value = f?.inventory_prompt ?? '';
  $('fn-side-effect').value = f?.side_effect ?? 'write';
  $('fn-template').value = f?.template ?? '';
  $('fn-enabled').checked = f ? !!f.enabled : true;
}

function functionPayload() {
  return {
    name: $('fn-name').value.trim(),
    description: $('fn-description').value.trim() || null,
    template: $('fn-template').value.trim(),
    inventory_prompt: $('fn-inventory-prompt').value.trim() || null,
    side_effect: $('fn-side-effect').value === 'read' ? 'read' : 'write',
    enabled: $('fn-enabled').checked,
  };
}

async function saveFunction() {
  try {
    const payload = functionPayload();
    const id = $('fn-id').value;
    if (id) await api(`/functions/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/functions', { method: 'POST', body: JSON.stringify(payload) });
    await loadBootstrap();
    $('fn-editor').classList.add('hidden');
  } catch (e) {
    alert(`Speichern fehlgeschlagen: ${e.message}`);
  }
}

async function deleteFunctionUi() {
  const id = $('fn-id').value;
  if (!id || !confirm('Funktion löschen?')) return;
  await api(`/functions/${id}`, { method: 'DELETE' });
  await loadBootstrap();
  $('fn-editor').classList.add('hidden');
}

async function previewFunction() {
  const out = $('fn-preview-out');
  out.classList.remove('hidden');
  out.textContent = 'Rendere …';
  try {
    const d = await api('/functions/preview', {
      method: 'POST',
      body: JSON.stringify({ template: $('fn-template').value.trim() }),
    });
    const steps = (d.trace ?? []).map((t) => t.step).join(' → ');
    out.textContent = `${d.rendered?.speech ?? ''}\n\n[trace] ${steps || '(keine Datenabrufe)'}`;
  } catch (e) {
    out.textContent = `Fehler: ${e.message}`;
  }
}

function fillFunctionSelect(selected) {
  const sel = $('action-function');
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— Inline-Template verwenden —';
  sel.append(none);
  for (const f of bootstrap.functions ?? []) {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = f.name;
    if (f.name === selected) opt.selected = true;
    sel.append(opt);
  }
}

let indexesCache = [];

function parseIndexConfig(raw) {
  try {
  return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function renderIndexes() {
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

async function saveIndexUi() {
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

async function deleteIndexUi() {
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

async function previewIndex() {
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

function openActionEditor(id) {
  const a = id ? bootstrap.actions.find((x) => x.id === id) : null;
  $('action-editor').classList.remove('hidden');
  $('action-editor-title').textContent = a ? `Vorgang: ${a.name}` : 'Neuer Vorgang';
  $('action-id').value = a?.id ?? '';
  $('action-name').value = a?.name ?? '';
  $('action-mode').value = a?.mode ?? 'llm';
  $('action-triggers').value = (a?.triggers ?? []).join('\n');
  $('action-threshold').value = a?.fuzzy_threshold ?? '';
  $('action-system').value = a?.system_prompt ?? '';
  fillFunctionSelect(a?.function_ref ?? '');
  $('action-tools-list').innerHTML = '';
  void loadToolPicker(a?.toolList ?? []).then(syncActionToolsInput);
  $('action-enabled').checked = a ? !!a.enabled : true;
  updateFunctionFieldVisibility();
}

function updateFunctionFieldVisibility() {
  $('action-function-field').classList.toggle('hidden', $('action-mode').value === 'llm');
}

function actionPayload() {
  const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
  const threshold = $('action-threshold').value.trim();
  return {
    name: $('action-name').value.trim(),
    mode: $('action-mode').value,
    trigger_phrases: lines($('action-triggers').value),
    fuzzy_threshold: threshold === '' ? null : Number(threshold),
    system_prompt: $('action-system').value.trim() || null,
    function_ref: $('action-function').value || null,
    template: null,
    tools: lines($('action-tools').value),
    enabled: $('action-enabled').checked,
  };
}

async function saveAction() {
  const mode = $('action-mode').value;
  if (mode !== 'llm' && !$('action-function').value) {
    alert(`Im ${mode === 'hybrid' ? 'hybriden' : 'deterministischen'} Modus muss eine Funktion gewählt sein (Funktionen-Tab zum Anlegen).`);
    return;
  }
  syncActionToolsInput();
  const payload = actionPayload();
  const id = $('action-id').value;
  if (id) await api(`/actions/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  else await api('/actions', { method: 'POST', body: JSON.stringify(payload) });
  await loadBootstrap();
  $('action-editor').classList.add('hidden');
}

async function deleteActionUi() {
  const id = $('action-id').value;
  if (!id || !confirm('Vorgang wirklich löschen?')) return;
  await api(`/actions/${id}`, { method: 'DELETE' });
  await loadBootstrap();
  $('action-editor').classList.add('hidden');
}

function renderServers() {
  const tbody = $('mcp-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const s of bootstrap.servers) {
    const tr = document.createElement('tr');
    const target = s.transport === 'stdio' ? `[stdio] ${s.command ?? ''}` : s.url;
    tr.innerHTML = `
      <td>${esc(s.name)}</td>
      <td>${esc(target)}</td>
      <td>${s.enabled ? '✔' : '✖'}</td>
      <td class="actions"><button class="btn small">Bearbeiten</button></td>`;
    tr.querySelector('button').onclick = () => openServerEditor(s.id);
    tbody.append(tr);
  }
}

function toggleMcpTransportFields(transport) {
  const stdio = transport === 'stdio';
  for (const id of ['mcp-url-label', 'mcp-url', 'mcp-token-label', 'mcp-token']) {
    $(id).classList.toggle('hidden', stdio);
  }
  for (const id of ['mcp-command-label', 'mcp-command', 'mcp-args-label', 'mcp-args', 'mcp-env-label', 'mcp-env', 'mcp-npm-spec-label', 'mcp-npm-spec']) {
    $(id).classList.toggle('hidden', !stdio);
  }
  $('mcp-stdio-hint').classList.toggle('hidden', !stdio);
}

function openServerEditor(id) {
  const s = id ? bootstrap.servers.find((x) => x.id === id) : null;
  $('mcp-editor').classList.remove('hidden');
  $('mcp-editor-title').textContent = s ? `MCP-Server: ${s.name}` : 'Neuer MCP-Server';
  $('mcp-id').value = s?.id ?? '';
  $('mcp-name').value = s?.name ?? '';
  $('mcp-transport').value = s?.transport ?? 'http';
  $('mcp-url').value = s?.url ?? '';
  $('mcp-token').value = '';
  $('mcp-command').value = s?.command ?? '';
  let argsText = '';
  let envText = '';
  try { argsText = s?.args ? JSON.parse(s.args).join(', ') : ''; } catch { argsText = ''; }
  try {
    if (s?.env) {
      envText = Object.entries(JSON.parse(s.env)).map(([k, v]) => `${k}=${v}`).join('\n');
    }
  } catch { envText = ''; }
  $('mcp-args').value = argsText;
  $('mcp-env').value = envText;
  $('mcp-npm-spec').value = s?.npm_spec ?? '';
  $('mcp-inventory-prompt').value = s?.inventory_prompt ?? '';
  $('mcp-side-effect').value = s?.side_effect ?? 'write';
  $('mcp-enabled').checked = s ? !!s.enabled : true;
  $('mcp-tools').innerHTML = '';
  toggleMcpTransportFields($('mcp-transport').value);
}

async function saveServer() {
  const transport = $('mcp-transport').value;
  const payload = {
    name: $('mcp-name').value.trim(),
    transport,
    inventory_prompt: $('mcp-inventory-prompt').value.trim() || null,
    side_effect: $('mcp-side-effect').value === 'read' ? 'read' : 'write',
    enabled: $('mcp-enabled').checked,
  };
  if (transport === 'stdio') {
    payload.command = $('mcp-command').value.trim();
    payload.args = $('mcp-args').value;
    payload.env = $('mcp-env').value;
    payload.npm_spec = $('mcp-npm-spec').value.trim();
    payload.url = '';
  } else {
    payload.url = $('mcp-url').value.trim();
    if ($('mcp-token').value) payload.auth_token = $('mcp-token').value;
  }
  const id = $('mcp-id').value;
  if (id) await api(`/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  else await api('/mcp-servers', { method: 'POST', body: JSON.stringify(payload) });
  await loadBootstrap();
  $('mcp-editor').classList.add('hidden');
}

async function healthServer() {
  const id = $('mcp-id').value;
  if (!id) {
    alert('Bitte zuerst speichern.');
    return;
  }
  $('mcp-tools').textContent = 'Abfrage läuft…';
  try {
    const res = await api(`/mcp-servers/${id}/health`, { method: 'POST' });
    $('mcp-tools').innerHTML = res.ok
      ? res.tools.map((t) => `<div>${esc(t)}</div>`).join('')
      : `<div class="error-text">${esc(res.error)}</div>`;
  } catch (e) {
    $('mcp-tools').innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
  }
}

async function deleteServer() {
  const id = $('mcp-id').value;
  if (!id || !confirm('MCP-Server wirklich löschen?')) return;
  await api(`/mcp-servers/${id}`, { method: 'DELETE' });
  await loadBootstrap();
  $('mcp-editor').classList.add('hidden');
}

// Testbutton aus Vorgaengen/Paketen: Phrase im Monitor ausfuehren (Ergebnis+Trace).
function testInMonitor(phrase) {
  showTab('monitor');
  $('test-text').value = phrase;
  sendTest();
}

// Paket: ersten Vorgang (sonst erste Funktion) des Pakets testen.
function testPackage(id) {
  const p = (pkgState.installed ?? []).find((x) => x.id === id);
  const items = p?.items ?? [];
  const actionName = items.find((i) => i.kind === 'action')?.name;
  if (actionName) {
    const a = (bootstrap.actions ?? []).find((x) => x.name === actionName);
    testInMonitor((a?.triggers ?? [])[0] || actionName);
    return;
  }
  const fnName = items.find((i) => i.kind === 'function')?.name;
  const f = fnName ? (bootstrap.functions ?? []).find((x) => x.name === fnName) : null;
  if (f) {
    showTab('functions');
    openFunctionEditor(f.id);
    previewFunction();
    return;
  }
  alert('Dieses Paket hat keinen direkt testbaren Vorgang/eine Funktion.');
}

async function sendTest() {
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

function init() {
  document.querySelectorAll('.sidebar nav a').forEach((a) => (a.onclick = () => showTab(a.dataset.tab)));
  $('token').value = token();
  $('token-save').onclick = () => {
    document.body.dataset.token = $('token').value;
    loadBootstrap();
  };
  $('settings-save').onclick = async () => {
    const settings = {};
    for (const f of SETTINGS_FIELDS) {
      const ctrl = $('settings-form').querySelector(`[data-key="${f.key}"]`);
      if (!ctrl) continue;
      if (f.type === 'tools') {
        const picked = toolsFromList(`settings-tools-${f.key}`);
        settings[f.key] = picked.length ? picked.join(', ') : 'keine';
        continue;
      }
      settings[f.key] = ctrl.value;
    }
    $('settings-form').querySelectorAll('input[data-key], select[data-key]').forEach((i) => {
      if (settings[i.dataset.key] === undefined) settings[i.dataset.key] = i.value;
    });
    await api('/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
    await loadBootstrap();
  };
  $('prompt-save').onclick = async () => {
    await api(`/prompts/${$('prompt-key').value}`, {
      method: 'PUT',
      body: JSON.stringify({ content: $('prompt-content').value }),
    });
    await loadBootstrap();
  };
  $('settings-restore').onclick = async () => {
    if (!confirm('Alle Grundeinstellungen auf die Defaults der Installation zuruecksetzen? (Index-Konfiguration bleibt unangetastet)')) return;
    const res = await api('/settings/restore-defaults', { method: 'POST' });
    bootstrap.settings = res.settings;
    renderSettings();
    alert('Grundeinstellungen auf Defaults zurueckgesetzt.');
  };
  $('prompt-restore').onclick = () => {
    const seed = bootstrap.seedPrompts?.[$('prompt-key').value];
    if (!seed) return;
    $('prompt-content').value = seed;
    alert('Original-Text geladen - noch nicht gespeichert.');
  };
  $('test-send').onclick = sendTest;
  $('test-text').onkeydown = (e) => { if (e.key === 'Enter') sendTest(); };
$('action-new').onclick = () => openActionEditor(null);
$('action-save').onclick = saveAction;
$('action-delete').onclick = deleteActionUi;
$('fn-new').onclick = () => openFunctionEditor(null);
$('fn-save').onclick = saveFunction;
$('fn-delete').onclick = deleteFunctionUi;
$('fn-preview').onclick = previewFunction;
$('fn-editor').onclick = (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest('button.help');
  if (!btn) return;
  const fieldEl = btn.closest('.field');
  const helpText = fieldEl?.querySelector('.field-help');
  if (helpText) helpText.classList.toggle('hidden');
};
$('idx-new').onclick = () => openIndexEditor(null);
$('idx-save').onclick = saveIndexUi;
$('idx-delete').onclick = deleteIndexUi;
$('idx-preview').onclick = previewIndex;
$('idx-editor').onclick = (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest('button.help');
  if (!btn) return;
  const fieldEl = btn.closest('.field');
  const helpText = fieldEl?.querySelector('.field-help');
  if (helpText) helpText.classList.toggle('hidden');
};
$('action-editor').onclick = (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest('button.help');
  if (!btn) return;
  const fieldEl = btn.closest('.field');
  const helpText = fieldEl?.querySelector('.field-help');
  if (helpText) helpText.classList.toggle('hidden');
};
$('action-mode').addEventListener('change', updateFunctionFieldVisibility);

$('mcp-new').onclick = () => openServerEditor(null);
$('mcp-save').onclick = saveServer;
$('mcp-health').onclick = healthServer;
$('mcp-delete').onclick = deleteServer;
$('mcp-transport').onchange = () => toggleMcpTransportFields($('mcp-transport').value);
  $('logs-refresh').onclick = loadLogs;
  loadBootstrap();
}

init();

// ---- Wartung und Pakete ----

let pkgState = { registry: [], installed: [], selected: null, preview: null, language: 'de' };

function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function loadMaintenance() {
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
  const installedIds = new Set(pkgState.installed.map((p) => p.id));
  const avail = pkgState.registry.map((p) => {
    const inst = installedIds.has(p.id) ? '<span class="chip ok">installiert</span>' : '';
    return `<div class="pkg-item"><div><strong>${escHtml(p.name)}</strong> <span class="pkg-version">v${escHtml(p.version)}</span> <span class="pkg-id">${escHtml(p.id)}</span><div class="field-help">${escHtml(p.summary)} <a href="https://github.com/dezihh/SmartPilot/blob/main/packages/${escHtml(pkgState.language ?? 'de')}/${escHtml(p.id)}/README.md" target="_blank" rel="noopener">Installations-Doku</a></div></div><button class="btn" data-install="${escHtml(p.id)}">${installedIds.has(p.id) ? 'Neu installieren' : 'Installieren'}</button></div>`;
  });
  $('pkg-available').innerHTML = avail.length ? avail.join('') : '<div class="field-help">Registry leer oder nicht erreichbar — „Aktualisieren“ versucht es erneut.</div>';
  const inst = pkgState.installed.map((p) => {
    const items = (p.items ?? []).map((i) => `<li>${escHtml(i.kind)}: ${escHtml(i.name)}</li>`).join('');
    return `<div class="pkg-installed-item"><div><strong>${escHtml(p.id)}</strong> v${escHtml(p.version)} <span class="pkg-version">${escHtml(p.source)}</span><div class="field-help">${escHtml(p.installed_at)}</div></div><div class="toolbar"><button class="btn" data-testpkg="${escHtml(p.id)}" title="Ersten Vorgang des Pakets im Monitor ausführen">Testen</button><button class="btn" data-reinstall="${escHtml(p.id)}">Neu installieren</button><button class="btn danger" data-uninstall="${escHtml(p.id)}">Entfernen</button></div><details><summary>Enthält</summary><ul>${items}</ul></details></div>`;
  });
  $('pkg-installed').innerHTML = inst.length ? inst.join('') : '<div class="field-help">Noch keine Pakete installiert.</div>';
  for (const b of document.querySelectorAll('#pkg-available [data-install]')) b.onclick = () => showInstallForm(b.dataset.install, false);
  for (const b of document.querySelectorAll('[data-reinstall]')) b.onclick = () => showInstallForm(b.dataset.reinstall, null);
  for (const b of document.querySelectorAll('[data-testpkg]')) b.onclick = () => testPackage(b.dataset.testpkg);
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

function paramForm(manifest) {
  const fields = (manifest.params ?? []).map((p) => {
    const type = p.secret ? 'password' : 'text';
    return `<label>${escHtml(p.label)}${p.required ? ' *' : ''}</label><input data-param="${escHtml(p.key)}" type="text" placeholder="${escHtml(p.placeholder ?? p.default ?? '')}" value="${escHtml(p.default && !p.secret ? p.default : '')}">`;
  }).join('');
  return fields;
}

async function showInstallForm(id, manifestFromImport) {
  try {
    let preview = manifestFromImport;
    if (!preview) preview = await api(`/packages/manifest/${encodeURIComponent(id)}`);
    pkgState.selected = { id, preview };
    const m = preview.manifest;
    // Bei bereits installierten Paketen: lokal geaenderte Zeilen zum Entscheiden anzeigen.
    const installed = pkgState.installed.some((p) => p.id === id);
    let conflicts = [];
    if (installed) {
      try { conflicts = (await api(`/packages/${encodeURIComponent(id)}/conflicts`)).conflicts ?? []; } catch { conflicts = []; }
    }
    const danger = preview.dangerous ? `<div class="error-text pkg-danger">⚠️ Gefährliche Aktion: ${(preview.dangerousItems ?? []).map((i) => escHtml(i)).join(' · ')}</div>` : '';
    const info = (preview.infoItems ?? []).length ? `<div class="field-help">${(preview.infoItems ?? []).map((i) => escHtml(i)).join(' · ')}</div>` : '';
    const items = (preview.items ?? []).map((i) => `<li>${escHtml(i.kind)}: ${escHtml(i.name)}</li>`).join('');
    const meta = [
      m.author ? `Autor: ${escHtml(m.author)}` : '',
      m.license ? `Lizenz: ${escHtml(m.license)}` : '',
      m.language ? `Sprache: ${escHtml(m.language)}` : '',
      m.minGatewayVersion ? `min. Gateway ${escHtml(m.minGatewayVersion)}` : '',
    ].filter(Boolean).join(' · ');
    const metaHtml = meta ? `<p class="field-help">${meta}</p>` : '';
    const securityHtml = `<p class="field-help">Sicherheit: ${preview.dangerous ? '⚠️ führt Shell-Befehle aus (Bestätigung nötig)' : (preview.infoItems ?? []).length ? 'ruft externe Dienste auf (Info)' : 'nur lesend / unkritisch'}</p>`;
    const changelogHtml = m.changelog ? `<details><summary>Changelog</summary><pre class="pkg-docs">${escHtml(m.changelog)}</pre></details>` : '';
    const conflictsHtml = conflicts.length ? `
      <div class="pkg-items pkg-conflicts">
        <strong>Lokale Änderungen erkannt:</strong>
        <p class="field-help">Diese Zeilen hast du nach der Installation bearbeitet. Standard ist, deine lokale Version zu behalten; wähle „Paket-Version übernehmen", um sie durch das Paket zu ersetzen.</p>
        <ul>${conflicts.map((c) => `<li>${escHtml(c)}
          <select data-decision="${escHtml(c)}">
            <option value="keep">Lokale Änderung behalten</option>
            <option value="take">Paket-Version übernehmen</option>
          </select></li>`).join('')}</ul>
      </div>` : '';
    $('pkg-install-form').classList.remove('hidden');
    $('pkg-install-form').innerHTML = `
      <h3>${escHtml(m.name)} <span class="pkg-version">v${escHtml(m.version)}</span></h3>
      <p class="field-help">${escHtml(m.description ?? '')}</p>
      ${metaHtml}
      ${securityHtml}
      ${m.requires ? `<p class="field-help"><strong>Benötigt:</strong> ${escHtml(m.requires)}</p>` : ''}
      ${danger}${info}
      ${conflictsHtml}
      <div class="pkg-items"><strong>Enthält:</strong><ul>${items}</ul></div>
      ${preview.setupDocs ? `<details><summary>Einrichtung Gegenseite</summary><pre class="pkg-docs">${escHtml(preview.setupDocs)}</pre></details>` : ''}
      ${changelogHtml}
      <div class="form-grid">${paramForm(m)}</div>
      <div class="toolbar">
        <button id="pkg-install-go" class="btn primary">${installed ? 'Aktualisieren' : 'Installieren'}</button>
        <button id="pkg-install-cancel" class="btn">Abbrechen</button>
      </div>`;
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
        alert(`Angelegt: ${rep.created.length}\nAktualisiert: ${rep.updated.length}\nBehalten: ${rep.kept?.length ?? 0}\n${rep.infoItems?.length ? 'Info: ' + rep.infoItems.join(' · ') : ''}`);
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
