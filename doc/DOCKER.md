# Betrieb mit dem Docker-Image

Das Gateway gibt es als fertiges Container-Image für `linux/amd64` und
`linux/arm64` (Raspberry Pi 4/5, Rock64, NAS). Damit läuft die Installation
ohne Quellcode und ohne Build.

**Wichtigster Punkt vorab:** Nach dem Start ist das Gateway **sofort
benutzbar** — Admin-UI, Testmonitor, Vorgänge und Pakete. Für **Alexa** kommt
zusätzlich eine öffentlich erreichbare HTTPS-Adresse (Reverse-Proxy mit TLS)
sowie die Lambda bzw. der Alexa-hosted Skill dazu. Beides ist optional und
unabhängig vom Container.

## 1. Dateien besorgen

Beide Dateien liegen im GitHub-Release und gehören zu genau dieser Version:

```bash
mkdir smartpilot && cd smartpilot
curl -LO https://github.com/dezihh/SmartPilot/releases/latest/download/compose.yaml
curl -LO https://github.com/dezihh/SmartPilot/releases/latest/download/env.example
mv env.example .env
```

| Datei | Inhalt |
|---|---|
| `compose.yaml` | Startvorschrift mit festem Image-Tag der Version |
| `.env` | Laufzeit-Konfiguration (aus `env.example`) |

Die Image-Version steht in der Compose, nicht in der `.env`. Ein Update ist
deshalb immer ein Datei-Tausch, kein Variablen-Setzen.

## 2. `.env` ausfüllen

Pflicht sind fünf Werte:

```dotenv
ADMIN_TOKEN=<mind. 24 Zeichen, != API_TOKEN>
API_TOKEN=<mind. 24 Zeichen>
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=<Schlüssel>
LLM_MODEL=<Modellname>
```

Alles Weitere ist optional und in `env.example` kommentiert. Betriebswerte
(Token-Budget, Tool-Runden, HTTP-Grenzen) stehen **nicht** in der `.env`,
sondern in der Admin-UI unter **Grundeinstellungen**.

> Läuft der Start mit „Fehlende Umgebungsvariable" oder „mindestens 24 Zeichen"
> auf, fehlt ein Pflichtwert oder ein Token ist zu kurz.

## 3. Starten

```bash
docker compose up -d
```

Danach:

| Prüfung | Erwartung |
|---|---|
| `curl http://localhost:3000/healthz` | `{"ok":true,"schema_version":…}` |
| `http://<host>:3000/admin` | Login-Seite, Anmeldung mit `ADMIN_TOKEN` |
| Tab **Monitor / Test** | erste Frage wird beantwortet |

**Ab hier ist das Soforterlebnis da** — ohne Alexa, ohne Reverse-Proxy, ohne
weitere Dienste. Pakete (Wetter, Home Assistant, MQTT …) lassen sich im Tab
**Wartung und Pakete** nachinstallieren.

Im Verzeichnis liegen danach nur:

```
smartpilot/
├── compose.yaml
├── .env
└── data/        SQLite-Datenbank, Backups, installierte MCP-Server
```

## 4. Anpassungen ohne Änderung der Compose

Anderer Host-Port, andere Bind-Adresse oder ein abweichendes Image gehören in
eine `compose.override.yaml` neben der Compose:

```yaml
services:
  gateway:
    ports: !override
      - "192.168.10.2:8332:3000"
```

Compose lädt diese Datei automatisch, solange die Basisdatei `compose.yaml`
heißt. Ohne `!override` werden Ports **ergänzt** statt ersetzt.

Standardmäßig veröffentlicht die Compose Port `3000` auf allen Interfaces. Wer
das einschränken will, nimmt genau diesen Override mit `127.0.0.1:3000:3000`.

## 5. Update und Rollback

```bash
# neue compose.yaml aus dem Release laden, dann:
docker compose pull
docker compose up -d
```

**Rollback:** in der `compose.override.yaml` den alten Image-Tag setzen
(`image: ghcr.io/dezihh/smartpilot:<alte Version>`), dann `pull` und `up -d`.

Vor jedem Update `data/` sichern: Die Datenbank wird beim Start migriert, ein
Rückschritt auf ein älteres Schema ist nicht garantiert.

## 6. Wenn Alexa dazukommen soll

Das Gateway allein genügt dafür nicht. Zusätzlich nötig:

1. **Öffentliche HTTPS-Adresse** mit Reverse-Proxy (TLS-Terminierung) — das
   Gateway selbst spricht nur HTTP. Referenzaufbau mit nginx, Pfadregeln und
   Sicherheitszielen: [INSTALLATION.md](INSTALLATION.md#netzwerk-und-https)
   und [INSTALLATION.md](INSTALLATION.md#referenzaufbau-mit-nginx).
   Nur `/api/query` muss öffentlich sein; Admin-UI und `/metrics` bleiben intern.
2. **Alexa-Anbindung** — Skill, Interaktionsmodell und entweder eigene
   AWS-Lambda (`smartpilot-alexa-lambda.zip`) oder Alexa-hosted Skill
   (`smartpilot-alexa-hosted.zip`): [ALEXA.md](ALEXA.md).
3. **Token-Abgleich** — die Lambda nutzt `API_TOKEN` (nicht `ADMIN_TOKEN`),
   gesetzt als `api_token` in der Lambda-Konfiguration.

## 7. Betrieb

```bash
docker compose logs -f gateway     # Logs
docker compose ps                  # Status inkl. Healthcheck
docker compose restart gateway     # Neustart ohne Neu-Erzeugen
```

- Neustart-Politik: `unless-stopped` (übersteht Reboot, solange nicht bewusst
  gestoppt).
- Healthcheck: `/healthz` alle 30 s, 3 Fehlversuche.
- Logs enthalten keine Tokens; `http_headers` erscheint maskiert als
  `(gesetzt)`.

## 8. Kurzdiagnose

| Symptom | Ursache |
|---|---|
| Start bricht mit „Fehlende Umgebungsvariable" | Pflichtwert in `.env` leer |
| „muss in Produktion mindestens 24 Zeichen haben" | `ADMIN_TOKEN`/`API_TOKEN` zu kurz |
| `401` auf `/api/query` | `API_TOKEN` der Lambda ≠ Gateway |
| Container `unhealthy` | siehe `docker compose logs gateway` |
| Seite lädt, aber alte UI | Browser-Cache, `Strg+Shift+R` |
| Alexa antwortet „Es tut mir leid" | Gateway nicht öffentlich erreichbar oder Token falsch |

Weitere Fälle: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Verweise

- Installation mit Klon und Build: [INSTALLATION.md](INSTALLATION.md)
- Konfiguration und Einstellungsebenen: [CONFIGURATION.md](CONFIGURATION.md)
- Betrieb, Sicherheit, Proxy-Regeln: [DEPLOYMENT.md](DEPLOYMENT.md)
- Alexa: [ALEXA.md](ALEXA.md)
- Template- und Umgebungsreferenz: [REFERENCE.md](REFERENCE.md)
