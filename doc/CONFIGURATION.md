# Gateway konfigurieren

## Ziel

Dieses Kapitel beschreibt die Reihenfolge der Parametrierung. Einzelne Felder
und Grenzen stehen in [Referenz](REFERENCE.md).

## Empfohlene Reihenfolge

1. Admin-Token im Browser speichern.
2. Grundeinstellungen (Assistentenname, Modell) prüfen.
3. **Optional:** unter **Wartung und Pakete** fertige Pakete installieren — sie
   legen Server, Index und Funktionen in einem Schritt an. Ohne Paket die
   Schritte 4–6 von Hand gehen.
4. Systeme in der **Tool-Registry** verbinden.
5. **Index-Quellen** einrichten.
6. Funktionen anlegen und mit **Ausführen** testen.
7. Vorgänge anlegen.
8. Den Gesamtweg unter **Monitor / Test** prüfen.
9. Erst danach Alexa anbinden.

## Grundeinstellungen

Beim ersten Start werden Standardwerte angelegt. Bestehende Datenbankwerte
werden dabei nicht überschrieben.

| Einstellung | Empfehlung für den Einstieg |
|---|---|
| Assistentenname (`assistant_name`) | kurz und aussprechbar; Grundlage von Begrüßung und Identität |
| Hauptmodell | tool- und JSON-fähiges Modell |
| Tool-Modell (`tool_model`) | zunächst leer; dann gilt das Hauptmodell |
| Tool-Runden | Standard beibehalten |
| Tool-Deadline | innerhalb des verfügbaren Antwortfensters halten |
| Agent-Tool-Auswahl | nur tatsächlich benötigte Werkzeuge erlauben |
| Paketsprache (`registry_language`) | Standard `de`; bestimmt die Sprache der Paket-Registry |

Ein separates kleines Tool-Modell ist eine spätere Optimierung. Zuerst sollte
der gesamte Ablauf mit einem Modell zuverlässig funktionieren.

## Agent-Prompts

### `agent_system`

Hier steht nur allgemeines Verhalten:

- finales Antwortformat
- Umgang mit aktuellen Daten
- Aktion ausführen, bevor sie bestätigt wird
- Rückfragen bei echter Mehrdeutigkeit
- Kürze und Sprechbarkeit

### `agent_inventory`

Dies ist der allgemeine Rahmen des Werkzeugkatalogs. Aktive Funktionen und
MCP-Systeme ergänzen ihn zur Laufzeit. Domänenspezifische Kaskaden gehören an
das jeweilige System oder die jeweilige Funktion.

## Tool-Registry

Ein Eintrag verbindet einen MCP-Server.

### Streamable HTTP

Benötigt Name, URL und gegebenenfalls Bearer-Token. **Tools abfragen** prüft
die Verbindung und zeigt die veröffentlichten Werkzeuge.

### stdio

Das Gateway startet einen lokalen Prozess. Befehl und Pakete müssen in der
tatsächlichen Gateway-Laufzeitumgebung vorhanden sein, bei Docker also im
Container.

### Agent-Inventory-Prompt

Beschreibe knapp:

- wann das System zuständig ist
- welche Aufrufreihenfolge gilt
- welche IDs ausschließlich aus Ergebnissen übernommen werden
- wann eine Rückfrage statt eines Aufrufs nötig ist

**Prüfung:** **Tools abfragen** zeigt die erwarteten Werkzeuge.

## Index-Quellen

Eine Index-Quelle definiert:

- MCP-Werkzeug und Argumente
- Extraktion oder Transformation ins Pipe-Format
- Cache-Zeit `ttlMs`
- optionale Aliase, Stopwörter und Domain-Hinweise

`ttlMs` ist die Gültigkeitsdauer eines geladenen Snapshots, kein
Polling-Intervall. Ein neuer MCP-Aufruf entsteht erst beim nächsten Zugriff
nach Ablauf der TTL. Hinweise zur Wahl des Werts stehen unter
[Cache und Aktualität](CACHE.md#ttl-wählen).

Ein leerer Key ist der Standard-Index. Ein benannter Index wird als zweites
Argument angesprochen:

```jinja
{{ index.find('lautsprecher küche', 'ma') }}
```

Die Basis-Werkzeuge `fn_find_entities` / `fn_get_entity` akzeptieren optional
`args.index`, damit der Agent jede benannte Quelle durchsuchen kann. Liegt der
Key erst zur Renderzeit fest, werden alle konfigurierten Quellen vorgewärmt.

**Prüfung:** Die Probe-Abfrage liefert erwartbare IDs, Namen und Zustände.

## Funktionen

Lege zuerst Name, Beschreibung und Template an. Führe das Template aus, bevor
du es speicherst.

Parameter-Schema und Agent-Inventory-Zeile sind nur nötig, wenn der Agent die
Funktion gezielt als `fn_<name>` verwenden soll. Argumentierte Funktionen
brauchen ein JSON-Schema mit Pflichtfeldern.

## Vorgänge

### Trigger

Trage mehrere natürliche Nutzerfragen ein, je eine pro Zeile. Teste eine
wörtliche Phrase und mindestens eine leichte Abwandlung.

### Modus

- feste Ausgabe: `deterministic`
- feste Daten, flexible Sprache: `hybrid`
- offene Werkzeugwahl: `llm`

### Erlaubte Tools

Die Auswahl begrenzt die Tool-Schemas in LLM- und Hybrid-Vorgängen. Ein
deterministisches Funktionstemplate verwendet seine konfigurierten
Datenbausteine unabhängig davon. Angehakte Einträge bedeuten „freigegeben";
keine Auswahl bedeutet „keine". Budgets pro Werkzeug (Spalte `budget` der
Funktionen; die Basis-Lesetools sind fest auf 2 bzw. 3 gesetzt) verhindern
Schleifen.

### Funktion und PUT-Verhalten

- **Daten aus Funktion**: Pflicht bei `deterministic` und `hybrid`.
- **`function_args`**: feste Argumente für die zugewiesene Funktion (z. B.
  `{"road": "A24"}`); das Template liest sie als `args`.
- Ein `PUT` ist ein **Full-Replace** für die meisten Felder: ein fehlendes Feld
  wird geleert (System-Prompt, Trigger, Daten aus Funktion, `function_args`).
  Beim Bearbeiten den vollständigen Body senden.
- Sonderfall **erlaubte Tools**: `tools: []` heißt bewusst „ohne Tools"
  (z. B. Hilfe-Vorgang); fehlt das `tools`-Feld, bleibt es unverändert
  (Standard: alle).

**Prüfung:** Der Monitor-Trace zeigt den erwarteten Vorgang und nur die
beabsichtigten Werkzeugaufrufe.

## Modellwahl

Das Modell muss:

- Tool-Calling unterstützen
- zuverlässiges JSON erzeugen
- innerhalb des Zeitbudgets antworten
- deutsche gesprochene Anfragen robust verstehen

Reasoning-Modelle lösen komplexe Kaskaden oft besser, benötigen aber mehr Zeit
und ein ausreichend großes Ausgabe-Budget.

## Konfigurationsebenen

| Ebene | Inhalt | Beispiele |
|---|---|---|
| `.env` | Secrets und Start-Infrastruktur (vor dem Prozessstart fest) | `ADMIN_TOKEN`, `API_TOKEN`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` |
| Grundeinstellungen (Admin-UI) | Betriebs-Tuning zur Laufzeit | `llm_model`, `llm_max_tokens`, `tool_model`, `max_tool_iterations`, `tool_deadline_ms`, `agent_tools`, `http_timeout_ms`, `http_body_cap` |
| DB-Tabellen | Inhalte | Vorgänge, Funktionen, Prompts, MCP-Server, Logs |

Ein Setting mit leerem Wert fällt auf den `.env`- bzw. Code-Default zurück.

## Abnahme

- Tool-Registry zeigt die erwarteten Werkzeuge.
- Jede Index-Quelle besteht ihre Probe.
- Jede Funktion liefert über **Ausführen** ein Ergebnis.
- Jeder Vorgang nimmt im Monitor die erwartete Route.
- Der Agent sieht nur benötigte Werkzeuge.
- Fehler und Laufzeiten sind in Trace oder Logs sichtbar.
