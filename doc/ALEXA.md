# Alexa anbinden

## Ziel

Diese Anleitung ist die Fortsetzung der [Installation](INSTALLATION.md). Dort
läuft das Gateway bereits und ist öffentlich per HTTPS erreichbar. Jetzt
verbindest du es mit Alexa. Jeder Abschnitt endet mit einem prüfbaren
Zwischenstand.

## Voraussetzungen

- Abgeschlossene [Installation](INSTALLATION.md): Das Gateway läuft, hat eine
  öffentliche HTTPS-Adresse, und `POST /api/query` antwortet mit dem
  Bearer-Token `AUTH_TOKEN`.
- Ein Amazon-Developer-Konto.
- Für Weg B zusätzlich ein AWS-Konto.

Die Einrichtung dieser Konten ist nicht Teil dieser Anleitung.

## Zwei Wege

| | Weg A: Alexa-hosted | Weg B: eigene AWS-Lambda |
|---|---|---|
| Aufwand | gering | mittel |
| AWS-Konto | nicht nötig | nötig |
| Backend | von Amazon gehostet | eigene Lambda |
| Grenzen | ca. 8 Sekunden Zeitlimit; Code und Token liegen im hosted Repo | Timeout frei wählbar, volle Kontrolle |
| Empfehlung | zum Ausprobieren | für den Betrieb |

```mermaid
flowchart LR
    E[Echo] --> P[Alexa-Plattform]
    P --> L[AWS Lambda]
    L -->|HTTPS und Token| G[Gateway]
    G -->|Antwort| L
```

In beiden Wegen bleibt das Gateway die Zentrale: Routing, Funktionen, Werkzeuge
und LLM. Die Lambda ist ein dünner Adapter und ruft `POST /api/query` auf.
Öffentlich erreichbar ist nur diese eine Route.

## 1. Skill anlegen

In der Alexa Developer Console:

1. **Create Skill**.
2. **Skill name**: z. B. `SmartPilot` (Anzeigename in der Skill-Liste; siehe
   „Umbenennen“).
3. **Default language**: **German (DE)**.
4. **Choose a type of experience**: **Other**.
5. **Choose a model to add to your skill**: **Custom**.
6. **Choose a method to host your skill's backend resources**:
   - Weg A: **Alexa-Hosted (Python)**
   - Weg B: **Provision your own**
7. **Create Skill**. Auf der Seite **Choose a template to add to your skill**
   **Start from Scratch** wählen (nicht „Import skill“) und mit
   **Continue with template** bestätigen.
8. Nach ein bis zwei Minuten öffnet sich der **Build**-Tab. Die **Skill-ID**
   steht unter **Build → Endpoint → „Your Skill ID“** (Format
   `amzn1.ask.skill.…`). Sie wird für den Trigger in Weg B gebraucht und ist in
   Weg A als optionaler `alexa_skill_id`-Wert nützlich.

## 2. Interaktionsmodell

Im **Build**-Tab → **JSON Editor** folgendes Modell einsetzen (den
`invocationName` an den gewünschten Aufrufnamen anpassen), **Save Model** und
**Build Model** ausführen:

```json
{
  "interactionModel": {
    "languageModel": {
      "invocationName": "smart pilot",
      "intents": [
        { "name": "AMAZON.CancelIntent", "samples": [] },
        { "name": "AMAZON.HelpIntent", "samples": [] },
        { "name": "AMAZON.StopIntent", "samples": [] },
        { "name": "AMAZON.FallbackIntent", "samples": [] },
        {
          "name": "GptQueryIntent",
          "slots": [{ "name": "query", "type": "AMAZON.Person" }],
          "samples": ["{query}"]
        }
      ],
      "types": []
    }
  }
}
```

Das Einfügen ersetzt die Intents der Vorlage (`HelloWorldIntent`). Die Console
kann `AMAZON.NavigateHomeIntent` automatisch wieder aufnehmen und eine Warnung
anzeigen; der Intent ist unkritisch und wird im Normalbetrieb nicht ausgelöst.

Das Modell legt fest:

- **Invocation Name** `smart pilot` – so wird der Skill geöffnet.
- Intent `GptQueryIntent` mit Slot `query` und Sample `{query}` für freie Fragen.
- `AMAZON.HelpIntent`, `AMAZON.CancelIntent`, `AMAZON.StopIntent`,
  `AMAZON.FallbackIntent`.

## 3. Weg A: Alexa-hosted

Beim hosted Skill liegen Code und Interaktionsmodell bei Amazon. Der Skill ist
in Schritt 1 mit **Alexa-Hosted (Python)** angelegt.

### 3.1 Interaktionsmodell

Wie in Schritt 2: **Build** → **JSON Editor**, Modell einsetzen, **Save Model**,
**Build Model**.

### 3.2 Lambda-Code und Abhängigkeiten

Im **Code**-Tab über **Import Code** das fertige Hosted-Zip laden. Es liegt im
GitHub-Repo unter **Releases** (GitHub → Repository `dezihh/SmartPilot` →
**Releases** → neuestes Release → Asset `smartpilot-alexa-hosted.zip`).

Das Zip enthält `lambda/lambda_function.py`, `lambda/requirements.txt` und
`lambda/config.json.example` (datensichere Vorlage). Es enthält bewusst **kein
`config.json`** – die Konfiguration legst du gleich selbst an (3.3). Alternativ
die Dateien direkt im Code-Editor bearbeiten.

### 3.3 config.json

Im `lambda/`-Ordner eine `config.json` anlegen (Vorlage:
`config.json.example`, die Werte daraus übernehmen und anpassen):

```json
{
  "gateway_url": "https://<gateway-host>",
  "gateway_token": "<AUTH_TOKEN>",
  "watchdog_delay": "5",
  "gateway_timeout": "28",
  "skill_name": "SmartPilot",
  "assistant_name": "Dein SmartPilot",
  "alexa_skill_id": "amzn1.ask.skill.<deine-id>"
}
```

Hosted Skills haben keine Umgebungsvariablen wie Weg B; die Werte stehen daher
in dieser Datei. Sie liegt damit im hosted CodeCommit-Repo (nur für dein Konto
sichtbar). `alexa_skill_id` ist optional, aber empfohlen: Die Lambda lehnt dann
Events mit fremder `applicationId` ab.

### 3.4 Deploy und Test

**Deploy** klicken (lädt Abhängigkeiten, baut und deployt). Danach testen
(Schritt 5). Ein LaunchRequest („Alexa, öffne …") funktioniert auch ohne
erreichbares Gateway; freie Fragen brauchen `gateway_url` und `gateway_token`.

## 4. Weg B: eigene AWS-Lambda (empfohlen)

### 4.1 Lambda-Funktion anlegen

1. Fertiges Zip laden (GitHub → Repository `dezihh/SmartPilot` → **Releases** →
   neuestes Release → Asset `smartpilot-alexa-lambda.zip`).
2. In AWS eine Lambda-Funktion `smartpilot-alexa` anlegen:
   - Region **Europa (Irland) `eu-west-1`** (die Alexa-Konsole trägt den ARN
     als Default-Region ein)
   - Runtime **Python 3.14**, Handler `lambda_function.lambda_handler`
   - Timeout **30 s** (sollte größer als 8 s sein – 8 s laufen auch, bringen
     aber keinen Vorteil gegenüber der hosted-Variante), Memory **512 MB**
   - Ausführungsrolle mit der Richtlinie **`AWSLambdaBasicExecutionRole`**
     (CloudWatch-Logs). Weitere Richtlinien sind **nicht** nötig. Die Console
     kann selbst gewählte Rollennamen ablehnen – dann den vorgeschlagenen
     Namen übernehmen.
   - Das geladene Zip als Code hochladen: Bereich **Code** → Schaltfläche
     **Aktualisieren** (kleines Dreieck) aufklappen → **Aus einer .zip-Datei
     aktualisieren** → Datei wählen → **Speichern**.
3. Umgebungsvariablen setzen:

| Variable | Wert |
|---|---|
| `gateway_url` | öffentliche Basisadresse des Gateways |
| `gateway_token` | muss dem `AUTH_TOKEN` des Gateways entsprechen |
| `alexa_skill_id` | Skill-ID deines Skills (Schritt 1, Punkt 8: **Build → Endpoint → „Your Skill ID“**); abweichende IDs werden abgelehnt |
| `watchdog_delay` | z. B. `5` (Warteton, wenn das Gateway länger braucht) |
| `gateway_timeout` | z. B. `28` (Timeout der Anfrage ans Gateway; muss unter dem Funktions-Timeout liegen) |
| `skill_name` | Anzeigename, z. B. `SmartPilot` |
| `assistant_name` | Name im Gespräch, z. B. `Dein SmartPilot` |
| `apl_exit_delay_ms` | z. B. `90000` (Anzeige auf dem Echo Show) |

Weitere optionale Variablen (in Weg A dieselben Namen als
`config.json`-Schlüssel; Standard in Klammern):

| Variable | Standard | Wirkung |
|---|---|---|
| `debug` | aus | ausführliche Logs in CloudWatch |
| `acknowledgment_enabled` | `false` | sofortige Bestätigung vor der Antwort |
| `ask_for_further_commands` | `false` | hält die Session nach jeder Antwort offen |
| `warteton_enabled` | `true` | Warteton bei langer Gateway-Antwort |
| `warteton_phrase` | leer | eigener Text für den Warteton |

### 4.2 Alexa-Trigger setzen

In der Lambda einen Trigger (Auslöser) vom Typ **Alexa Skills Kit** hinzufügen
und als Skill-ID die ID des Skills eintragen. Die Konsole setzt daraus das
Ereignisquellen-Token (`amzn1.ask.skill.…`) und beschränkt den Aufruf auf genau
diesen Skill (Service-Prinzipal `alexa-appkit.amazon.com`).

### 4.3 Endpoint im Manifest setzen

In der **Alexa Developer Console** (Plattform) beim Skill:

1. **Build** → **Endpoint**.
2. Endpoint-Typ **AWS Lambda ARN** wählen.
3. Im Feld **Default Region** die Funktions-ARN eintragen:
   `arn:aws:lambda:eu-west-1:<konto>:function:smartpilot-alexa`
   (die ARN steht in AWS oben in der Funktion `smartpilot-alexa`).
4. **Save Endpoints**.

Amazon prüft dabei den ARN-Fingerprint; die Region `eu-west-1` muss zur
Funktion passen.

## 5. Testen

1. Dieselbe Frage im Gateway unter **Monitor / Test** stellen.
2. Im Alexa-Simulator der Console sprechen: „Alexa, öffne Smart Pilot“.
3. Auf einem echten Echo testen.
4. Einen langsamen Aufruf testen; der Warteton darf die finale Antwort nicht
   ersetzen.
5. Eine echte Mehrdeutigkeit testen; die Rückfrage muss die Session offen halten.

## Umbenennen

Wenn du einen anderen Namen für den Skill wünschst, ist das problemlos möglich.
**Empfehlung:** zuerst mit dem Standardnamen testen und später neue Rufnamen
nach dieser Anleitung setzen.

Ein anderer Name betrifft **mehrere Stellen**. Sie müssen zusammenpassen, sonst
stellt sich der Assistent je nach Kontext anders vor. Zwei der Namen liegen im
Gateway und sind **global**.

| Name | Wo | Wirkung | Aktion |
|---|---|---|---|
| **Aufrufname** | Alexa-Interaktionsmodell, Feld `invocationName` (Build → **Invocation** oder **JSON Editor**) | „Alexa, öffne …“ | Wert ändern, **Save Model**, **Build Model** |
| **Skill-Anzeigename** | Alexa Developer Console, beim Skill | Name in der Skill-Liste | Anzeigename ändern |
| **Sprechname der Lambda** | Weg A: `lambda/config.json` → `assistant_name`; Weg B: Env `assistant_name` | Begrüßung und Karte der Lambda | Wert ändern, **Deploy** bzw. Env speichern |
| **Assistenten-Name** | Gateway-Admin → **Grundeinstellungen** → **Assistenten-Name** | Wie das LLM sich nennt („Ich bin …“) | Wert ändern, **Einstellungen speichern** |
| **Display-Titel (APL)** | Gateway-Admin → **Grundeinstellungen** → **Display-Titel (APL)** | Überschrift auf dem Echo Show | Wert ändern, **Einstellungen speichern** |

Beachten:

- **Global:** `assistant_name` und `display_title` gelten im Gateway für **alle**
  Skills. Unterschiedliche Namen pro Skill sind damit nicht möglich.
- **Wirkung:** Gateway-Werte greifen sofort (kein Neustart); Lambda-Werte erst
  nach **Deploy** (Weg A) bzw. Speichern der Env-Variablen (Weg B).
- **Unvollständig:** Änderst du nur den Aufrufnamen, bleibt die Begrüßung beim
  alten Namen.
- **Aufrufname:** mindestens zwei Wörter, keine Ziffern.

## Sprachen

Der Skill ist derzeit nur auf **Deutsch (de-DE)** eingerichtet. Eine weitere
Sprache braucht ein eigenes Interaktionsmodell für diese Locale und passende
Sprechtexte in der Lambda (aktuell nur `de-DE` hinterlegt).

## Nutzung

- Wecken und öffnen: „Alexa, öffne Smart Pilot“.
- Freie Frage: „Alexa, frag Smart Pilot, wie ist der Hausstatus“.
- Rückfragen: Bei zusammenfassenden Antworten bleibt die Session offen; „mehr
  dazu“ bezieht sich auf das letzte Thema.
- Chat-Modus: „starte chat modus“ beginnen, „chat beenden“ beenden.
- Beenden: „Alexa, stopp“ oder „Alexa, beenden“.
- Auf dem Echo Show wird die Antwort als Text angezeigt (scrollbar).

## Wenn etwas nicht klappt

- Keine Antwort: prüfen, ob `POST /api/query` mit dem Gateway-Token direkt
  antwortet (Gateway-Monitor).
- „Skill nicht gefunden“: Invocation Name im Modell prüfen.
- Lambda-Fehler: CloudWatch-Logs der Lambda ansehen (Weg B: Funktion
  `smartpilot-alexa`).
- Antworten fehlen Fähigkeiten: Die eigentlichen Funktionen kommen über
  Installationspakete im Gateway, nicht über den Skill.

## Abgrenzung

Music Assistant kann Audio über einen eigenen Alexa-Provider auf Echo-Geräten
wiedergeben. Dieser Skill steuert den Vorgang sprachlich; er streamt selbst
kein Audio zum Echo.
