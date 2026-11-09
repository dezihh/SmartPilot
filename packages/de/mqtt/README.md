# MQTT-Broker

Legt den Registry-Eintrag für den **internen MQTT-Server** an. Er läuft als
stdio-Prozess im Gateway-Container (`dist/mcp/mqtt-server.js`) — kein Extra-
Container, kein npm-Paket zum Nachinstallieren.

> **Antwortweg:** Agent (LLM) — der Agent liest Topics und schaltet nur
> freigegebene Topics.

## Was es liefert

| Werkzeug | Wirkung |
|---|---|
| `mqtt_snapshot` | alle bekannten Topics mit letztem Wert (max. 50 Zeilen) |
| `mqtt_get` | Wert eines Topics aus dem Last-Value-Cache |
| `mqtt_set` | setzt ein **freigegebenes** Topic (retained, QoS 1) |

Der Cache hält maximal 1000 Topics, pro Wert 4 KB; der älteste Eintrag fällt
zuerst heraus. Nach dem Verbinden bleiben 1,5 s für die retained-Nachrichten,
vorher meldet ein leerer Snapshot das offen.

## Was es braucht (Gegenseite)

Einen erreichbaren MQTT-Broker, z. B. Mosquitto:

```yaml
mosquitto:
  image: eclipse-mosquitto:2
  container_name: mosquitto
  restart: unless-stopped
  volumes:
    - ./mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
```

Wichtig: Der Gateway-Container muss den Broker erreichen. Beide ins gleiche
Docker-Netz legen oder die IP des Broker-Hosts angeben.

## Parameter

| Feld | Bedeutung |
|---|---|
| `mqtt_url` | `mqtt://host:1883` oder `mqtts://host:8883` (Pflicht) |
| `mqtt_username` / `mqtt_password` | Zugangsdaten, nur nötig wenn der Broker sie verlangt |
| `mqtt_prefix` | Namensanfang ohne `#`/`*`, z. B. `netfreq/` oder `haus/`; nur Topics darunter werden abonniert (leer = alle) |
| `mqtt_allow_write` | schaltbare Topics, komma-getrennt: `haus/licht/kuche`, `haus/heizung/#` (leer = kein Topic schaltbar) |

## Sicherheit

- **Schreiben ist standardmäßig gesperrt.** Ein offener Publish-Tool wäre auf
  einem Broker eine Fernsteuerung für alle Geräte im Netz — deshalb nur
  explizite Topics bzw. Präfixe mit `#`/`*`.
- Jedes freigegebene Topic kann SmartPilot auf Zuruf setzen: die Liste
  absichtlich klein halten.
- Der Server läuft als stdio-Prozess im Gateway-Container (wie `searxng`);
  das Paket zeigt auf `dist/mcp/mqtt-server.js`.

## Beispiel

```text
Nutzer:  "Wie warm ist es im Keller?"
Tool:    mqtt_get { topic: "keller/temperatur" }
→        [MQTT] keller/temperatur=21.5

Nutzer:  "Mach das Licht in der Küche an."
Tool:    mqtt_set { topic: "licht/kuche", value: "ON" }
→        [MQTT] licht/kuche=ON
```
