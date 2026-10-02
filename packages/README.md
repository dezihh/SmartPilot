# Paket-Registry

Fertige Installationspakete für den SmartPilot-Gateway: generische
Praxisrezepte, die überall laufen, wo die genannte Gegenseite vorhanden ist.
Die Sammlung wird gepflegt und wächst durch Beiträge — eigene generische
Pakete können per Issue oder Pull Request ins Repository kommen (siehe
unten).

## Der Gedanke dahinter

Eine Funktion von Hand anzulegen ist schwer zu erklären. Ein fertiges,
installierbares Beispiel zeigt stattdessen, wie eine Aktion zusammengesetzt
ist: welche Werkzeuge, welcher Index, welches Template. Daraus folgen drei
Grundsätze für alle Pakete:

- **Verständnis vor Vollständigkeit.** Ein Paket soll vor allem zeigen, wie
  etwas funktioniert — es muss nicht jeden Sonderfall abdecken. Nach dem
  Install ist jedes Artefakt im Editor frei anpassbar.
- **Generisch statt installationsspezifisch.** Pakete laufen überall, wo die
  genannte Gegenseite vorhanden ist (z. B. Home Assistant, SearXNG). Feste
  Hosts, Tokens oder Pfade gehören in Parameter; wo die Funktion aber
  Beispielwerte braucht, um überhaupt zu laufen, stehen sie klar als
  Beispiel markiert in der Paket-README (siehe unten).
- **Mitmachen erwünscht.** Eigene generische Rezepte können per Issue oder
  Pull Request beigetragen werden; die Basis soll mit den Nutzern wachsen.

## So funktioniert die Parametrierung

Ein Paket kann Eingabefelder definieren (`params`). Beim Install erscheint
ein Formular; die Werte ersetzen `${key}`-Platzhalter in Server-URLs,
Templates und Index-Konfiguration. Fehlt für einen Platzhalter der Wert,
schlägt der Install mit klarer Meldung fehl. Secrets (API-Keys, Token) sind
als solche markiert, landen nur in der jeweiligen Zielzeile und werden nie
geloggt.

Was bewusst kein Parameter ist (z. B. die Region im `autobahn`-Paket), wird
nach dem Install direkt im Editor angepasst — die Paket-README sagt, wo und
wie. Alternativ kann ein Manifest auch offline importiert werden; Vorschau
und Bestätigung gelten unverändert.

## Aufbau (sprachspezifisch)

```
packages/
  <lang>/                 z. B. de (BCP-47-Kuerzel)
    index.json            Liste der verfuegbaren Pakete dieser Sprache
    <id>/manifest.json    Installations-Manifest
    <id>/README.md        Einrichtungs-/Nutzungsdoku
```

Die aktive Sprache kommt aus dem Gateway-Setting `registry_language`
(Standard `de`). Das Gateway liest Manifest und Index unter
`packages/<lang>/...` — weitere Sprachen (`packages/en/...`) koennen so ohne
Umbau ergaenzt werden.

## Registry-Kanaele (stabil / community)

Das Gateway liest immer **einen** Kanal: `PACKAGES_REGISTRY_URL` + `/<lang>`
(Default: `main`). Ein Kanal ist kein Zusammenfuehren — zeigt die Variable auf
einen Branch, kommen die Pakete genau dieses Branches.

- **`main`** = stabiler, kuratierter Katalog (Default).
- **`packages/community`** = Vorschlags-/Testkanal. Von `main` abgezweigt;
  neue/Community-Pakete kommen zuerst hierhin (`packages/de/<id>/` **und**
  Eintrag in `packages/de/index.json`).
- **Testen**: `PACKAGES_REGISTRY_URL=https://raw.githubusercontent.com/dezihh/SmartPilot/packages/community/packages`
  setzen und den Gateway-Container neu erstellen. Die Registry wird live
  gelesen — kein Build und kein Release noetig.
- **Nach `main` uebernehmen**: Paketordner + Index-Eintrag per Pull Request
  mergen. Das ist ein reiner Datei-Merge und loest **kein** GitHub-Release aus
  (Releases haengen nur an `alexa/lambda/**` bzw. Tags). Nur wenn ein Paket
  eine neue Laufzeit-Abhaengigkeit braucht (z. B. ein neues stdio-Binary im
  Container), ist ein Gateway-Update noetig.

## Manifest-Felder

| Feld | Pflicht | Zweck |
| --- | --- | --- |
| `id`, `version` | ja | eindeutige Id, semver `x.y.z` |
| `name`, `summary`, `description` | ja | Anzeige und Kurzbeschreibung |
| `author`, `license`, `homepage` | empfohlen | Herkunft und Lizenz (Vertrauensmodell) |
| `language` | optional | Sprachkuerzel, Default `de` |
| `requires`, `setupDocs` | optional | benoetigte Gegenseite / Einrichtungshinweise |
| `minGatewayVersion` | optional | getestete Gateway-Mindestversion (wird **erzwungen**) |
| `changelog` | empfohlen | Versionshistorie und Upgrade-Hinweise |
| `params` | optional | Eingabefelder (Werte ersetzen `${key}` im Manifest) |
| `servers` / `functions` / `indexes` / `actions` | optional | die anzulegenden Artefakte |
| `allowTools` | optional | Agent-Tool-Allowlist (wird vereinigt) |

`servers`/`functions` koennen `sideEffect: read|write` setzen (Default
`write`): schreibende Aufrufe verwerfen den Entity-Index-Cache des Agenten,
rein lesende (`read`) nicht.

## Artefakt-Felder (servers / functions / actions / indexes)

Die Oberfelder stehen oben; die darin enthaltenen Artefakte haben diese
Felder:

**`servers[]`** — Eintrag in der MCP-Tool-Registry:

| Feld | Pflicht | Bedeutung |
| --- | --- | --- |
| `name` | ja | Anzeigename in der Tool-Registry |
| `transport` | ja | `http` oder `stdio` |
| `url` | bei `http` | Endpunkt, z. B. `http://<host>:<port>/mcp` |
| `command`, `args`, `env` | bei `stdio` | Befehl im Gateway-Container (z. B. `node_modules/.bin/mcp-searxng`), Argumente, Umgebungsvariablen |
| `auth_token` | nein | Bearer-Token (HTTP); `${key}` fuer Secrets |
| `inventory_prompt` | nein | Kaskaden-/Regeltext fuer den Agenten |
| `sideEffect` | nein | `read`/`write` (Default `write`) |
| `enabled` | nein | Default `true` |

**`functions[]`** — Funktion (Jinja-Template):

| Feld | Pflicht | Bedeutung |
| --- | --- | --- |
| `name` | ja | `a-z`, `0-9`, `_` |
| `template` | ja | Jinja/Nunjucks; Bausteine siehe `doc/REFERENCE.md` |
| `description` | nein | Anzeigetext |
| `parameters` | nein | JSON-Schema fuer Agentenargumente |
| `budget` | nein | max. Aufrufe pro Frage |
| `inventory_prompt` | nein | Faehigkeitszeile im Agent-Katalog |
| `sideEffect` | nein | `read`/`write` (Default `write`) |

**`actions[]`** — Vorgang (Trigger → Antwortweg):

| Feld | Pflicht | Bedeutung |
| --- | --- | --- |
| `name` | ja | `a-z`, `0-9`, `_`, `-` |
| `mode` | ja | `deterministic`, `llm` oder `hybrid` |
| `trigger_phrases` | nein | String-Array der Auslöser |
| `fuzzy_threshold` | nein | 0–1 (Ähnlichkeitsschwelle) |
| `function_ref` | nein | Name einer Funktion (deterministisch/hybrid) |
| `function_args` | nein | feste Argumente (Objekt oder JSON-String) |
| `system_prompt` | nein | Prompt für `llm`/`hybrid` |
| `template` | nein | Inline-Jinja (deterministisch ohne `function_ref`) |
| `tools` | nein | erlaubte Tools (Array; `[]` = keine) |
| `enabled` | nein | Default `true` |

**`indexes[]`** — Index-Quelle:

| Feld | Pflicht | Bedeutung |
| --- | --- | --- |
| `key` | ja | `''` = Standard-Index, sonst `a-z`, `0-9`, `_` |
| `config` | ja | Objekt mit mindestens `tool` (MCP-Toolname); optional `args`, `transform`, `ttlMs`, `aliases` … |

## Validierungsregeln

Das Gateway prueft das Manifest bei der Vorschau und beim Install und meldet
Verstoesse im Klartext:

- `id`: `a-z`, `0-9`, `_`, `-` (1–40 Zeichen); `version`: `x.y.z`.
- Funktionsname: `a-z`, `0-9`, `_` (1–60) — direkt als `fn_<name>` nutzbar.
- Action-Name: `a-z`, `0-9`, `_`, `-` (1–60); `mode` aus `deterministic`/`llm`/`hybrid`; `fuzzy_threshold` 0–1.
- Index-Key: `a-z`, `0-9`, `_` (0–30); `config.tool` erforderlich.
- `allowTools`: Tool-Namen aus `a-z`, `0-9`, `_`, `*`.
- Param-Key: `a-z`, `0-9`, `_` (1–40) mit `label`.
- `sideEffect`: nur `read` oder `write`.
- `language`: z. B. `de`; `minGatewayVersion`: `x.y.z`.

Ein Manifest laesst sich ohne Registry ueber den **Offline-Import** (Admin →
„Wartung und Pakete") vorab pruefen und installieren — der praktische Weg,
ein neues Paket lokal zu testen.

## Manifest und Vertrauen

Die Tabelle oben ist die Feld-Referenz. Warum man einem Paket vertrauen
kann, ergibt sich aus genau diesen Feldern — plus zwei UI-Mechanismen beim
Install:

- **Herkunft/Lizenz**: `author`, `homepage`, `license`.
- **Kompatibilitaet**: `minGatewayVersion` wird beim Installationsversuch
  geprueft; zu alte Gateways lehnen das Paket mit klarer Meldung ab.
- **Nachvollziehbarkeit**: `changelog` (Upgrade-Hinweise).
- **Sicherheit** (in der UI sichtbar):
  - `shell()`-Templates und **jeder `stdio`-Server** (startet einen Prozess im
    Gateway-Container) gelten als **gefaehrlich** und verlangen beim Install
    eine ausdrueckliche Bestaetigung (`dangerousAck`) — unabhaengig vom Befehl.
  - `http()`-Templates werden als Info ausgewiesen (externe Aufrufe).
  - Pakete ohne `shell()`/`http()`/`stdio` gelten als nur lesend/unkritisch.
- **Updates**: „Neu installieren" ist ein Upsert. Lokal geaenderte Zeilen
  werden erkannt und pro Element zum Entscheiden angezeigt
  („Paket-Version uebernehmen" / „lokale Aenderung behalten" / abbrechen).

## Eigene Pakete beitragen

Neue Pakete folgen demselben Muster wie die bestehenden — am besten vor dem
eigenen Paket eines davon nebenbei lesen: `autobahn` als schlankes Beispiel
(Funktion + Parameter + Anpasshinweis), `home-assistant` als vollständigstes
(Server + Index + Allowlist).

- **Generisch halten, Beispiele erlauben**: Installations-spezifische Werte
  (Hosts, Tokens, Pfade) gehoeren in Parameter (`params` + `${key}`). Wo
  die Funktion aber Beispielwerte braucht, um ueberhaupt zu laufen (etwa
  die Referenz-Region im Autobahn-Paket), duerfen sie drinstehen — dann
  aber klar als Beispiel markiert („bitte anpassen!") und mit
  Anpasshinweis in der Paket-README.
- **README-Struktur**: „Was es braucht (Gegenseite)“ → „Parameter beim
  Install“ → „Nach der Installation“ (mit Pruefschritt).
- **Meta pflegen**: `author`, `license`, `changelog`; bei Shell- oder
  HTTP-Nutzung ist das ohnehin Teil des Vertrauensmodells.

Beitrag per Issue oder Pull Request gegen `packages/de/<id>/` — inklusive
Eintrag in `packages/de/index.json`.

Signaturen oder eine gesonderte, geprüfte Registry sind als spaeterer
Ausbau vorgesehen.
