import { $, api, esc } from './lib.js';
import { state } from './state.js';

let reloadBootstrap = async () => {};
export function setServerContext({ reload }) { reloadBootstrap = reload; }

export function renderServers() {
  const tbody = $('mcp-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const s of state.bootstrap.servers) {
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

export function toggleMcpTransportFields(transport) {
  const stdio = transport === 'stdio';
  for (const id of ['mcp-url-label', 'mcp-url', 'mcp-token-label', 'mcp-token', 'mcp-headers-label', 'mcp-headers']) {
    $(id).classList.toggle('hidden', stdio);
  }
  for (const id of ['mcp-command-label', 'mcp-command', 'mcp-args-label', 'mcp-args', 'mcp-env-label', 'mcp-env', 'mcp-npm-spec-label', 'mcp-npm-spec']) {
    $(id).classList.toggle('hidden', !stdio);
  }
  $('mcp-stdio-hint').classList.toggle('hidden', !stdio);
}

export function openServerEditor(id) {
  const s = id ? state.bootstrap.servers.find((x) => x.id === id) : null;
  $('mcp-editor').classList.remove('hidden');
  $('mcp-editor-title').textContent = s ? `MCP-Server: ${s.name}` : 'Neuer MCP-Server';
  $('mcp-id').value = s?.id ?? '';
  $('mcp-name').value = s?.name ?? '';
  $('mcp-transport').value = s?.transport ?? 'http';
  $('mcp-url').value = s?.url ?? '';
  $('mcp-token').value = '';
  $('mcp-headers').value = '';
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

export async function saveServer() {
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
    payload.headers = $('mcp-headers').value;
  }
  const id = $('mcp-id').value;
  if (id) await api(`/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  else await api('/mcp-servers', { method: 'POST', body: JSON.stringify(payload) });
  await reloadBootstrap();
  $('mcp-editor').classList.add('hidden');
}

export async function healthServer() {
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

export async function deleteServer() {
  const id = $('mcp-id').value;
  if (!id || !confirm('MCP-Server wirklich löschen?')) return;
  await api(`/mcp-servers/${id}`, { method: 'DELETE' });
  await reloadBootstrap();
  $('mcp-editor').classList.add('hidden');
}
