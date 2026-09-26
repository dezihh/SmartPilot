# Architektur

> Zentrale Architekturregeln von smartpilot. Festgehalten nach Review 2026-09-06
> (Improvement-Issues #3–#6).
>
> **Hinweis zur Aktualität:** Dieses Dokument ist ein Design-Archiv. Einzelne
> Beispiele und Details sind überholt — aktuell sind die Template-Bausteine
> `index.*` / `mcp.call` / `http` / `shell` / `fn` (nicht mehr `ha.*`), der
> Modus `search_summary` wurde entfernt, das LLM wird über einen eigenen
> OpenAI-kompatiblen Client angebunden (kein litellm), und die frühere
> Gateway-Route `/alexa` samt Alexa-Signaturprüfung wurde entfernt (Alexa
> läuft jetzt über AWS Lambda und `POST /api/query`). Bei Widersprüchen
> gilt der Code und die Nutzer-Doku in `helpdoc/`.

## Zentrale Architekturregel: Adapter-Muster

Der Core kennt **kein Alexa**. Alexa-spezifisches (Requests, JSON-Strukturen,
Response Cards, APL) liegt ausschließlich im Adapter:

```text
Alexa Adapter ──▶ VoiceQuery ──▶ SmartPilot Core ──▶ AssistantResponse ──▶ Alexa Adapter
```

```typescript
interface VoiceQuery {
  sessionId: string;
  userId?: string;
  text: string;
}

interface AssistantResponse {
  speech: string;            // für Sprachausgabe immer gesetzt
  ssml?: boolean;            // true: speech enthält fertiges SSML (Passthrough)
  display?: DisplayPayload;  // optional, siehe CONCEPTS.md
  followUp?: boolean;        // true: Session offen halten (Rückfrage)
}
```

Damit sind weitere Adapter möglich, ohne den Core anzufassen:
**Alexa Adapter** (MVP), später Web Adapter, API Adapter, Home-Assistant-Voice-Adapter.

Der Core kennt: Query, Session, User, Response, MCP, LLM, Actions –
aber keine Alexa-Requests, Alexa-JSON-Strukturen oder Response Cards.

## SSML: Verantwortung liegt beim Adapter

Die Sprachausgabe braucht SSML (Erfahrung aus dem Vorgängerprojekt: ohne
`<break>`-Pausen und `<say-as>`/`<sub>` für Einheiten und Zahlen klingt die
Ausgabe schlecht bzw. wird falsch ausgesprochen). Der Grundsatz:

- **Der Core arbeitet sprachneutral.** `AssistantResponse.speech` ist standardmäßig
  Klartext. Enthält eine Quelle (z. B. HA-Skript) fertiges SSML, setzt der Core
  `ssml: true` und reicht es unverändert durch – er strippt es nicht mehr.
- **Der Adapter erzeugt bzw. validiert SSML.** Der Alexa-Adapter wrappt Klartext
  selbst (inkl. XML-Escaping) zu `<speak>…</speak>`; bei `ssml: true` wird das
  vorhandene SSML unverändert übernommen und maximal auf genau einen
  `<speak>`-Wrapper normalisiert. **Kein Doppel-Wrapping, kein Escaping von
  gültigem SSML** – beides führt zu Invalid-SSML-Fehlern auf Alexa-Seite.
- **Envelopes werden unwrappt, nicht zerstört.** Alte HA-Skripte antworten mit
  `{"speech": {"ssml": {"speech": "<speak>…"}}}` – der Template-Kontext extrahiert
  das innere SSML und markiert es als solches. Für die Card (Display) wird SSML
  zu Klartext bereinigt.

Damit kann jede Quelle (Skript, Template, LLM) selbst entscheiden, ob sie
Prosodie-Kontrolle über SSML braucht – ohne dass der Core Alexa-Details kennt.

## Pipeline

```text
VoiceQuery
  ▼
Router: Action-Route > Agent-Query (Default)
  ▼               ▼
  deterministisch  LLM frei mit MCP-Tools
  (Handler:       (System-Prompt, Tool-Allowlist,
   template /      Clarification-Budget)
   llm/hybrid)                 │
                               ▼
  └────────────────┬──────────┘
                   ▼
        AssistantResponse { speech, ssml?, display?, followUp?, keepOpen? }
```

Laufzeit-Hinweise stehen in `TROUBLESHOOTING.md`.

## Authentifizierung: zwei getrennte Ebenen

| Ebene | Stand (Implementierung) | Später (Improvement) |
|---|---|---|
| **Client-Auth** (Alexa → Lambda) | `applicationId`-Vergleich gegen `ALEXA_SKILL_ID` in der AWS-Lambda (eingebauter ask-sdk-Verifier, `alexa_skill_id`); das Gateway hat keinen direkten Alexa-Endpunkt mehr | — |
| **API-/Admin-Auth** (`/api/*`, `/admin/*`) | Bearer-Token (`AUTH_TOKEN`), constant-time über `timingSafeEqual`; Admin-UI zusätzlich mit Session-Login | Replay-Schutz via HMAC (Timestamp + Nonce) → Issue #5 |
| **MCP-Server-Auth** (Gateway → MCP-Server) | je nach Server: ohne Token (LAN-intern) oder Bearer-Token in der MCP-Registry | falls später exponiert: Bearer-Token in der MCP-Registry |

- Verbindliche Architektur: Alexa Skill → AWS Lambda → `POST /api/query` → Gateway.
- Zweck der Client-Auth in der Lambda: „Der Request kommt von meinem Alexa-Skill (applicationId)."
- Die frühere Gateway-Route `/alexa` samt Alexa-Signaturprüfung (`ALEXA_VERIFY_MODE`, Zertifikatskette) wurde entfernt; Alexa erreicht das Gateway ausschließlich über die Lambda und `POST /api/query`.
- Eine spätere Trennung zwischen Client-Authentifizierung und User-Identität bleibt möglich
- Beide Ebenen bewusst nicht vermischt und nicht verkompliziert

## Berechtigungen: zwei getrennte Ebenen

```text
Home Assistant
└── Welche Entities darf MCP sehen?          (HA-eigene Steuerung)

SmartPilot
└── Welche MCP-Tools darf das LLM verwenden? (später pro Action, Issues #3/#4)
```

SmartPilot baut **keine zweite Entity-Berechtigungsschicht** nach.

## Funktionen: kontrollierter Kontext

Jinja2 erhält **keinen direkten MCP-Zugriff**, sondern feste, freigegebene
Bausteine (vollständige Liste: `REFERENCE.md`):

- `index.find` / `index.state` / `index.get` – lokale, gecachte Lesesicht
- `mcp.call(tool, args)` – gezielter Aufruf eines MCP-Werkzeugs
- `http(url, ttlMs?)` / `shell(command)` – Dienste ohne MCP-Fassade
- `fn(name)`, `args`, `now` – Einbettung, Argumente, Gateway-Zeit

Beispiel:

```jinja
{% set temp = index.state("sensor.living_room_temperature") %}
Im Wohnzimmer sind {{ temp }} Grad.
```

Damit behalten wir die Kontrolle darüber, was eine Funktion ausführen darf
(POC: sehr einfach gehalten).

## Datenmodell (POC)

SQLite, bewusst klein:

| Tabelle | Inhalt |
|---|---|
| `mcp_servers` | MCP-Server-Registry (URL, Auth-Vermerk, Aktiv-Status) |
| `actions` | Vorgänge inkl. Trigger, Templates, `mode` (deterministic/llm/hybrid), `handler_config` (JSON), Flags |
| `prompts` | System-/Agent-Prompte |
| `settings` | Laufzeit-Einstellungen (Warteton, Timeouts, Fuzzy global, Session-Followup) |
| `logs` | Request-Log inkl. Route, Latenz, Trace (Tool-Calls, LLM-Schritte) |

Credentials pragmatisch (`.env`/Env-Vars) – kein ausgefeiltes Secret-Management
als POC-Blocker.

## Schnittstellen: vollständig MCP, Code ohne Systembezug

Fähigkeiten externer Systeme (z. B. Smart Home) laufen **ausschließlich** über
deren **MCP-Server**. Der Gateway-Code enthält **keinen** Systembezug mehr:
weder REST (`/api/states`, `/api/template` wurden entfernt) noch HA-Toolnamen
oder HA-Fuzzy-Logik. Zwei generische Muster decken alles ab:

1. **`mcp.call(tool, args)`** — Weiterleitung an ein beliebiges MCP-Tool aus
   Templates (deterministische Vorgänge); der Agent ruft MCP-Tools direkt im
   Toolloop auf.
2. **Parametrierter Entity-Index** — Fuzzy-Suche/Lookups im RAM (< 1 ms) gegen
   einen Index, der per **einem** MCP-Call pro TTL-Fenster gefüllt wird
   (gemessen ~0,6 s für ~1200 Einträge). Tool, freies Argument-Objekt
  (Datenvertrag `id|area|state|unit|name|key=value;...`), Aliase,
   Domain-Hints und Stopwords stehen als JSON-Setting `entity_index`
   (Code-Default leer; HA wird z. B. ueber das Installationspaket mit
   `ha_eval_template` gebunden) — ein anderes System wird durch ein
   anderes Setting angebunden, nicht durch Code. Begründung: Serverseitige
   Fuzzy-Suche (z. B. `ha_search`) bleibt für deutsche Mehrwort-Voice-Queries
   klar schwächer (BM25-AND-Gating, kein Umlaut-Folding, keine Aliase, im
   Test 0 Treffer auf existierende Entities) — Treffersicherheit und
   Performance leben daher lokal, Universalität in der Parametrisierung.
3. **Index-Assistent** (`POST /admin/api/index/assist` + `/index/apply`) —
   LLM entwirft das Index-Binding, ein deterministischer Validator prüft es
   live gegen den Datenvertrag (nur lesende Tools, max. 3 Self-Correction-
   Iterationen), das Speichern erfolgt erst nach Admin-Bestaetigung.

### Tool-Vertrag: Was wir von MCP-Tools erwarten

Damit Agent, Template-Bausteine und Funktions-Registry ein MCP-Tool **ohne
Sondercode** nutzen können:

| Anforderung | Warum |
|---|---|
| Discovery via `tools/list` mit vollständigem JSON-Schema (Parameternamen, Typen, Pflichtfelder) | Agent und Admin-UI leiten Aufruf und Prompt-Beschreibung automatisch daraus ab |
| Ziele in **Nutzersprache** (Name, Raum, Etage), nicht interne IDs | Sprachclient und LLM kennen keine internen IDs; IDs sind Implementierungsdetail des Zielsystems |
| Typsichere Parameter inkl. Validierung (z. B. Ganzzahl 0–100 statt Float 0.0–1.0) | Falsche Typen/Einheiten sollen beim Aufruf abgelehnt werden, nicht falsch ausgeführt |
| Deterministische, maschinenlesbare Fehler **mit Trefferliste** (z. B. `DUPLICATE_NAME`, `MULTIPLE_TARGETS`) | Mehrdeutigkeiten übersetzt der Agent in eine Rückfrage (Clarification) statt zu raten |
| Lesende und schreibende Tools am Naming/der Beschreibung erkennbar | Grundlage für spätere Tool-Allowlists und Berechtigungen (#3/#4) |

Beispielhafte Erfahrung aus dem HA-MCP: Namensauflösung ohne Raumbezug scheitert
schnell an Duplikaten — Aufrufe so spezifisch wie möglich formulieren (Raum +
Domain mitgeben) und Doppel-/Geister-Entities im Quellsystem ausräumen.

### MCP-Einsatz

- Alle Systemzugriffe (Index, Lookups, Aufrufe) laufen über MCP-Tools der in
  der MCP-Registry eingetragenen Server.
- Die generischen Template-Bausteine (`http`, `shell`) bleiben für Dienste
  **ohne** MCP-Fassade (z. B. externe Web-APIs).
- Neue Index-Quellen werden über den Index-Assistenten eingebunden (siehe
  `REFERENCE.md`); die generischen Lesetools heißen
  systemneutral `fn_find_entities` / `fn_get_entity`.
- Konkrete Rezepte (nur Beispiele) leben in [Praxisrezepte](RECIPES.md),
  nicht hier.

### Gateway-eigene REST-API (Angebot)

| Endpoint | Zweck |
|---|---|
| `POST /api/query` | Einstieg für Adapter (Text/Session → AssistantResponse), Bearer-Token |
| `/admin/api/*` | Admin-UI: Vorgänge, Funktionen-Registry, MCP-Registry, Logs, Einstellungen |

## Externe Dienste

| Dienst | Endpoint (konfigurierbar via `.env`) |
|---|---|
| LLM | eigener OpenAI-kompatibler Client (`chat/completions`; Base-URL via Env `LLM_BASE_URL`, Modell via `LLM_MODEL`, API-Key via Env) |
| MCP (HA) | HA-MCP-Server (Streamable HTTP, Bearer; URL/Token in der MCP-Registry) |

Weitere fachliche Dienste werden bewusst **nur allgemein** hier geführt: sie
werden generisch über die Template-Bausteine angebunden und sind austauschbar.
Konkrete Endpunkte und Rezepte sind Beispiele und gehören in
[Praxisrezepte](RECIPES.md), nicht in die Architektur-Doku.

## Conversation State

Die API kennt `sessionId`:

```json
{"sessionId": "…", "query": "Mach es auf 21 Grad"}
```

Implementiert (2026-09): Kurzzeitgedächtnis pro Session (`rememberTurn`/`priorTurns`,
in-memory + Rückgriff auf die letzten Agent-Logs), steuerbar über das Setting
`session_followup` (llm/keyword/beides) — eine offene Session erlaubt Folgefragen
ohne erneute Invocation. Ausbaubar zu:

```text
session
├── conversation history
├── previous action
├── clarification
└── context
```

## Trace & Logging

Jeder Tool-Call wird geloggt (inkl. Szenario und Latenz) – Basis für spätere
Permissions (#3/#4) und Betriebsauswertung (Phase-2-Trigger, siehe
  `TROUBLESHOOTING.md`).
