const form = document.getElementById('login-form');
const input = document.getElementById('token');
const btn = document.getElementById('login-send');
const err = document.getElementById('error');
// Relativ zur Login-Seite: funktioniert auch unter einem Pfad-Prefix (BASE_PATH).
const loginUrl = new URL('login', location.href);
const homeUrl = new URL('./', location.href);
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  btn.disabled = true;
  err.textContent = '';
  try {
    const res = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: input.value.trim() }),
    });
    if (!res.ok) throw new Error('Anmeldung fehlgeschlagen');
    // Kein Token im localStorage: die HttpOnly-Session-Cookie (Set-Cookie)
    // authentifiziert alle /admin/api-Aufrufe.
    location.href = homeUrl.href;
  } catch (ex) {
    err.textContent = ex.message || 'Fehler beim Anmelden';
  } finally {
    btn.disabled = false;
  }
});
  
