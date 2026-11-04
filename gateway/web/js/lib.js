// Gemeinsame Frontend-Helfer fuer app.js und die Bereichsmodule.

// API-Basis relativ zum Modul: funktioniert auch unter einem Pfad-Prefix
// (BASE_PATH), z. B. /smartpilot/admin/.
export const API = new URL('../api', import.meta.url).pathname;

export function token() {
  // Session-Cookie (va_session) authentifiziert via requireAdminAuth; nur bei
  // explizit eingetragenem Token im Token-Feld kommt ein Bearer mit.
  return document.body.dataset.token ?? '';
}

export async function api(path, options = {}) {
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

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
