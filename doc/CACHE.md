# Cache und Aktualität

SmartPilot verwendet mehrere voneinander unabhängige Caches. Sie sparen
Netzwerkverkehr und Antwortzeit. Wichtig: Eine TTL ist nur eine
**Gültigkeitsdauer**. Sie startet keinen periodischen Abruf.

Keiner der hier beschriebenen Caches pollt selbstständig. Netzwerkverkehr
entsteht erst, wenn nach Ablauf einer Frist erneut auf die betreffenden Daten
zugegriffen wird oder eine konkrete Konfigurationsänderung den Cache verwirft.

Alle Caches leben nur im Gateway-Prozess. Nach einem Neustart sind sie leer;
die zugrunde liegende Konfiguration bleibt in SQLite erhalten.

## Überblick

| Cache | Inhalt | Netzwerkverkehr | Aktualisierung |
|---|---|---|---|
| Entity-Index | Snapshot externer Einträge | erster Zugriff, Zugriff nach TTL oder nach Invalidierung | bedarfsgesteuert |
| HTTP-Cache | Antwort einer URL | nur bei `http()` und fehlendem gültigem Eintrag | bedarfsgesteuert |
| MCP-Katalog | Clients und Tool-Definitionen | Kaltstart oder Zugriff nach Frischegrenze | bedarfsgesteuert, im Hintergrund |
| Paket-Registry | Liste verfügbarer Pakete | Öffnen/Aktualisieren der Paketansicht | bedarfsgesteuert |
| LLM-Provider-Cache | gegebenenfalls Promptdaten beim Anbieter | vom Anbieter bestimmt | kein Gateway-Cache |

## Entity-Index

### Was wird gespeichert?

Ein konfiguriertes MCP-Werkzeug liefert viele Einträge als Snapshot. Das
Gateway speichert die geparsten Einträge pro Index-Key im Arbeitsspeicher.
`index.find`, `index.state`, `index.get`, `fn_find_entities` und
`fn_get_entity` lesen anschließend lokal daraus.

### Wann entsteht Netzwerkverkehr?

Ein MCP-Snapshot wird geladen:

1. beim ersten Zugriff auf einen noch kalten Index,
2. beim ersten Zugriff nach Ablauf von `ttlMs`,
3. beim ersten Zugriff nach einer Invalidierung.

Es gibt keinen Abruf allein deshalb, weil `ttlMs` abgelaufen ist. Ohne neue
Indexabfrage entsteht kein Netzwerkverkehr.

Beispiel: Bei `ttlMs: 60000` und zehn Fragen innerhalb einer Minute wird der
Snapshot normalerweise einmal geladen und neunmal lokal verwendet.

### Wann wird invalidiert?

Der aktuelle Stand verwirft den gesamten Entity-Index unter anderem:

- nach **schreibenden** MCP- oder Funktionsaufrufen im Agenten-Toolloop
  (`sideEffect: write`, der Default),
- beim Speichern oder Löschen einer Index-Quelle,
- beim Anwenden eines Entwurfs aus dem Index-Assistenten,
- bei Paketinstallation, Paketentfernung und Rücksicherung.

Rein lesende Aufrufe (`sideEffect: read`) invalidieren den Index nicht —
so bleibt z. B. eine reine Suchfrage ohne unnötigen Snapshot-Neuaufbau. Die
Eingabe `sideEffect` steht Funktionen und Paket-Servern als Feld zur
Verfügung; der Default `write` ist konservativ.

Die eingebauten reinen Lesewerkzeuge `fn_find_entities` und `fn_get_entity`
invalidieren den Index nicht.

Nach einer geänderten Index-Konfiguration ist ein Gateway-Neustart der
eindeutige Fallback.

### TTL wählen

| Datenart | Orientierung | Abwägung |
|---|---:|---|
| häufig wechselnde Zustände | 15–60 Sekunden | aktueller, aber mehr Snapshot-Aufrufe |
| normale Smart-Home-Zustände | etwa 60 Sekunden | guter Ausgangspunkt |
| selten wechselnde Katalogdaten | mehrere Minuten | weniger Traffic, ältere Lesesicht |

Die passende TTL hängt von Größe und Kosten des Snapshots ab. Eine kurze TTL
ist nicht automatisch besser, weil ein großer Snapshot erheblich teurer sein
kann als eine lokale Suche.

## HTTP-Cache in Funktionen

Der HTTP-Cache ist nur aktiv, wenn das Template eine positive TTL angibt:

```jinja
{{ http('https://api.example.org/status', 300000) }}
```

Hier wird dieselbe URL fünf Minuten lang lokal beantwortet. Ohne zweites
Argument beziehungsweise mit TTL `0` wird bei jedem Rendern neu abgerufen.

Eigenschaften:

- Schlüssel ist die aufgelöste URL.
- Dynamische URLs werden nach ihrer tatsächlichen Ergebnis-URL gecacht.
- Der Cache enthält maximal 200 Einträge; alte oder abgelaufene Einträge
  werden entfernt.
- Es gibt keinen Hintergrundabruf und kein stale-while-revalidate.
- Normale MCP-Tool-Aufrufe werden dadurch nicht gecacht.

Für Paketautoren gilt: Eine API-TTL gehört in das Funktionstemplate und sollte
zur Änderungsrate der Quelle passen. Wettervorhersagen können meist länger,
Verkehrs- oder Preisdaten eher kürzer gecacht werden.

## MCP-Katalog

Der MCP-Katalog speichert pro aktivem Server den Client und dessen
Tool-Definitionen. Dadurch muss das Gateway nicht bei jeder Frage erneut
`initialize` und `tools/list` ausführen.

- Frischegrenze: fünf Minuten.
- Beim ersten Zugriff wird ein kalter Server blockierend initialisiert.
- Beim ersten Zugriff nach fünf Minuten werden die bisherigen Tools sofort
  verwendet und im Hintergrund aktualisiert.
- Ohne Zugriff gibt es keinen Refresh.
- Änderungen in der Tool-Registry sowie Paketinstallation und -entfernung
  verwerfen den Katalog unmittelbar.
- Bei einem fehlgeschlagenen Hintergrund-Refresh bleibt der alte Katalog
  verfügbar.

Bei stdio-Servern bedeutet ein Refresh einen neuen lokalen Prozess. Die relativ
lange Frischegrenze verhindert unnötigen Prozess- und Netzwerkverkehr.

## Paket-Registry

Die Paket-Registry speichert das kleine `packages/index.json` für 60 Sekunden.
Das bedeutet nicht, dass sie alle 60 Sekunden abgefragt wird.

Netzwerkverkehr entsteht:

- beim Laden oder Aktualisieren der Paketverwaltung, wenn kein gültiger
  Registry-Cache vorliegt,
- beim Öffnen der Vorschau eines Pakets für dessen `manifest.json`,
- bei der Installation, wenn das Manifest erneut geladen wird.

Der Button **Aktualisieren** lädt die Ansicht neu, verwendet innerhalb der
60 Sekunden aber weiterhin den gültigen Registry-Cache. Er ist daher kein
erzwungener Netzwerk-Refresh.

Agent, Vorgänge und normale Sprachfragen greifen nicht auf die Paket-Registry
zu. Für den üblichen Betrieb ist dieser Traffic vernachlässigbar.

## LLM-Provider-Cache

Das Gateway besitzt keinen eigenen Cache für LLM-Antworten. Der verwendete
Provider kann Teile eines Prompts intern cachen und dies über Nutzungsdaten wie
`cached_tokens` melden. Das Gateway erfasst diese Information für die
Verbrauchsanzeige, steuert aber weder Lebensdauer noch Netzwerkverkehr dieses
Provider-Caches.

## Was nicht gecacht wird

- normale MCP-Tool-Ergebnisse
- finale Antworten des Agenten
- Ergebnisse von `shell()`
- HTTP-Aufrufe ohne positive TTL

Innerhalb eines einzelnen Funktionsrenders werden identische vorbereitete
Aufrufe allerdings dedupliziert. Das verhindert Doppelaufrufe in demselben
Render, ist aber kein Cache über mehrere Anfragen hinweg.

## Hinweise für Paketautoren

1. Verwende einen Index für große, häufig durchsuchte Lesedaten.
2. Setze `ttlMs` bewusst nach Änderungsrate und Snapshot-Kosten.
3. Verwende `http(url, ttlMs)` für wiederholte externe GET-Abfragen.
4. Erwarte für normale MCP-Aktionen keinen Ergebnis-Cache.
5. Dokumentiere bei zustandsändernden Funktionen, wann Nutzer einen frischen
   Zustand erwarten können.
6. Teste mindestens kalten Zugriff, Cache-Treffer, TTL-Ablauf und Zustand nach
   einer Schreibaktion.

## Diagnose

Hinweise auf Cache-Verhalten stehen im Trace:

- `template.http.cache`: HTTP-Antwort kam aus dem Cache.
- Indexfehler erscheinen als `template.index.error`.
- Ein langsamer erster Zugriff und schnelle Folgezugriffe sprechen für einen
  kalten und danach warmen Index.

Weitere Prüfschritte stehen unter [Fehler beheben](TROUBLESHOOTING.md#index).
