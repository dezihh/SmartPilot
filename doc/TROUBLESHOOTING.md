# Fehler beheben

Arbeite immer von innen nach außen: Funktion, Vorgang, Gateway, Lambda, Alexa.
Der Monitor spart bei der Fehlersuche mehrere externe Schichten.

## Admin-Oberfläche

### Inhalte laden nicht

1. Prüfe, ob der Gateway-Prozess läuft.
2. Prüfe Host und `PORT`.
3. Trage den exakten Wert aus `ADMIN_TOKEN` rechts oben ein.
4. Prüfe Browser-Netzwerkfehler und Gateway-Log.

## Tool-Registry

### „Tools abfragen“ liefert nichts

1. Prüfe, ob der MCP-Dienst aus der Gateway-Laufzeit erreichbar ist.
2. Verwende bei Docker keinen nur auf dem Host gültigen Namen wie `localhost`.
3. Prüfe Transport und URL einschließlich `/mcp` beziehungsweise `/mcp/v1`.
4. Prüfe Bearer-Token und dessen Rechte.
5. Bei stdio: Prüfe, ob Befehl und Paket im Gateway-Container vorhanden sind.
6. Lies den konkreten Fehler im Gateway-Log.

### Werkzeugname stimmt nicht

Toolnamen kommen vom MCP-Server und können sich zwischen Versionen ändern.
**Tools abfragen** ist die Quelle der Wahrheit. Passe Templates erst nach
dieser Prüfung an.

## Index

### Probe liefert keine Treffer

1. Prüfe zuerst, ob das konfigurierte MCP-Werkzeug existiert.
2. Prüfe das Ergebnis des Extraktions-Templates.
3. Jede Zeile muss dem Format `id|area|state|unit|name|extra` entsprechen.
4. Suche testweise nach einem Teil der bekannten ID.
5. Ergänze einen Alias, wenn gesprochener und technischer Begriff abweichen.
6. Speichere die Index-Quelle erneut, wenn ihre Konfiguration geändert wurde;
   dadurch wird der Index-Cache verworfen.

### Index wirkt veraltet

Prüfe `ttlMs`. Innerhalb dieses Fensters ist ein älterer Zustand beabsichtigt.
Für schreibende Aktionen darf der Index nur die Ziel-ID liefern; der Erfolg
des Service-Aufrufs kommt vom Werkzeug.

Es gibt kein regelmäßiges Polling: Nach TTL-Ablauf wird erst bei der nächsten
Indexnutzung neu geladen. Details und weitere Cachearten stehen unter
[Cache und Aktualität](CACHE.md).

## Funktionen

### „Ausführen“ bleibt leer

1. Prüfe den Trace auf einen fehlgeschlagenen Preheat-Aufruf.
2. Prüfe Toolnamen und Argumente.
3. Prüfe, ob alle `args.*`-Felder ein Parameter-Schema besitzen.
4. Beachte: Lokale Jinja-`set`-Variablen sind in dynamischen
   `mcp.call`-Argumentobjekten nicht verfügbar.
5. Prüfe verschachtelte `fn(...)`-Aufrufe auf Zyklus oder Tiefe über drei.

### `[object Object]` oder unlesbarer Text

Verwende strukturierte JSON-Felder bei `http()`. MCP-Helfer liefern Text; das
Template muss daraus eine sprechbare Ausgabe bilden.

## Vorgänge

### Falscher Vorgang wird gewählt

1. Prüfe Trigger-Phrasen beider Vorgänge.
2. Verwende natürliche vollständige Fragen.
3. Erhöhe den Fuzzy-Schwellwert bei zu vielen falschen Treffern.
4. Prüfe die tatsächlich gewählte Route im Monitor-Trace.

### Frage fällt immer an den Agenten

Mindestens eine Trigger-Phrase muss ausreichend ähnlich sein und der Vorgang
muss aktiv sein. Teste zunächst die Phrase wörtlich.

## Agent

### Agent ruft kein Werkzeug auf

1. Prüfe, ob das Werkzeug in der globalen und gegebenenfalls
   vorgangsspezifischen Auswahl freigegeben ist.
2. Prüfe, ob **Tools abfragen** ein vollständiges JSON-Schema zeigt.
3. Beschreibe Zuständigkeit und Kaskade im richtigen Inventory-Prompt.
4. Prüfe, ob das Modell Tool-Calling unterstützt.

### Agent erfindet ID oder bestätigt ohne Ausführung

Schärfe die Systemregel: IDs nur aus aktuellen Tool-Ergebnissen übernehmen und
Aktionen erst nach erfolgreichem Aufruf bestätigen. Prüfe anschließend den
Trace, nicht nur den Antworttext.

### Agent antwortet leer oder ungültig

- Modell muss JSON zuverlässig liefern.
- Bei Reasoning-Modellen `llm_max_tokens` ausreichend groß wählen.
- Tool-Deadline und maximale Runden prüfen.
- Rohantwort und Validierungsfehler im Log ansehen.

## HTTP und Shell

### HTTP-Daten lassen sich nicht als JSON verwenden

Die Antwort kann größer als `http_body_cap` sein und wird dann als Rohtext
behandelt. Verwende einen schlankeren Endpoint oder erhöhe das Limit bewusst.

### Uptime ist zu klein

In Docker liest `/proc/uptime` möglicherweise die Container- statt der
Host-Laufzeit. Für Hostdaten ist eine ausdrücklich freigegebene externe Quelle
nötig.

## Wartung und Pakete

### Paketliste bleibt leer

Das Gateway lädt die Registry über `raw.githubusercontent.com`
(`packages/<lang>/…`) und braucht dafür Internetzugang.

1. Prüfe das Setting `registry_language` (Default `de`); ein ungültiger Wert
   fällt auf `de` zurück.
2. „Aktualisieren" nutzt bis 60 Sekunden den Registry-Cache; ein Neustart leert
   ihn.
3. Ohne Internet das Manifest **offline importieren** (Vorschau →
   installieren).

### Installation wird abgelehnt

1. „benötigt Gateway >= x.y.z" — `minGatewayVersion` des Pakets ist höher als
   die installierte Version; Gateway aktualisieren.
2. „Parameter … ist erforderlich" — Pflichtwert im Formular fehlt.
3. „Platzhalter … hat keinen Wert" — das Manifest nutzt `${…}`, das nicht in
   den Parametern steht.
4. Ungültiges Manifest — der Validator nennt die betroffenen Felder im
   Klartext.
5. Pakete mit `shell()` verlangen eine ausdrückliche Bestätigung
   (`dangerousAck`).

### Nach der Installation greift nichts

1. Registry-Änderungen verwerfen MCP-Katalog und Index-Cache; prüfe
   **Tools abfragen** und die Index-**Probe** neu.
2. HTTP-Server: URL und Token prüfen; stdio: Befehl und Paket im Container.
3. Ein erneutes Installieren zeigt lokal geänderte Zeilen als Konflikt zur
   Entscheidung.

## Alexa

### Monitor funktioniert, Alexa nicht

1. Prüfe Lambda-`alexa_skill_id` gegen die tatsächliche Skill-ID.
2. Prüfe, ob das Skill-Manifest auf die richtige Lambda-ARN zeigt.
3. Prüfe, ob die Trigger-Permission der Lambda auf die tatsächliche Skill-ID
   beschränkt ist.
4. Prüfe öffentlichen HTTPS-Endpunkt und Zertifikat.
5. Prüfe Lambda-`gateway_url` und `api_token` (muss dem Gateway-`API_TOKEN` entsprechen).
6. Vergleiche Lambda- und Gateway-Logs anhand des Zeitpunkts.
7. Prüfe den Buildstatus des Interaction Model und des Manifests.

### Endpoint-Zertifikat wird abgelehnt (Wildcard)

Alexa akzeptiert am Skill-Endpoint kein **Wildcard-Zertifikat**
(`*.example.com`) — auch nicht in der Alexa-hosted-Variante. Der Endpoint
braucht ein Zertifikat, dessen Name exakt dem verwendeten Host
(`<gateway-host>`) entspricht. Prüfe, dass dieser Host als Subject/SAN im
Zertifikat steht und die vollständige Zertifikatskette ausgeliefert wird.

### Antwort kommt zu spät

1. Prüfe Tool-Laufzeiten im Trace.
2. Reduziere unnötige Tool-Runden.
3. Antworte nach einer URL-Leserunde sofort.
4. Verwende Indexdaten statt vieler Einzelaufrufe.
5. Prüfe Modelllatenz und Tool-Deadline.
6. Prüfe Lambda-Timeout und Warteton-Konfiguration.

Bei einer Alexa-hosted-Variante kann das Antwortfenster von ungefähr acht
Sekunden bei aufwendigeren Suchen oder Agent-Aufrufen erreicht werden. Alexa
bricht die Anfrage dann möglicherweise ab, auch wenn das Gateway später noch
eine Antwort erzeugt. Für produktive oder anspruchsvollere Abfragen ist eine
eigene AWS-Lambda als Alexa-Plattform daher meist robuster; die übrigen
Timeouts von Lambda, Reverse-Proxy und Gateway müssen trotzdem zusammenpassen.

## Diagnosebericht erstellen

Für einen reproduzierbaren Fehler notiere:

- genaue Frage
- erwartete und tatsächliche Antwort
- gewählte Route
- Trace-Schritte mit Laufzeiten
- verwendetes Modell
- betroffene Toolnamen
- relevante, anonymisierte Konfiguration
- ob Monitor, Alexa-Simulator oder echtes Echo betroffen ist

Tokens, interne Hosts und persönliche Entity-IDs gehören nicht in öffentliche
Fehlerberichte.
