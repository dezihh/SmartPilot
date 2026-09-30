# Beispiel: HTTP

Legt zwei Beispiel-Funktionen an:

- **`meine_ip`** — öffentliche IP-Adresse über [ifconfig.me](https://ifconfig.me)
  (`all.json`), deterministisch formuliert.
- **`luftqualitaet`** — europäischer AQI und PM2,5 über die
  [Open-Meteo-Luftqualitäts-API](https://open-meteo.com/en/docs/air-quality-api),
  hybrid: die Rohwerte kommen aus der Funktion, die Einordnung macht das LLM.

Das Rezept zeigt die Muster `http()-Abruf` (JSON, ohne Key) und den
Unterschied zwischen **deterministisch** (fertiger Text) und **hybrid**
(Rohwert → LLM formuliert).

## Was es braucht (Gegenseite)

Nichts — öffentliche Dienste. Der Gateway-Container braucht Internetzugang zu
`ifconfig.me` und `air-quality-api.open-meteo.com`.

## Parameter beim Install

Keine. Die Koordinaten für die Luftqualität stehen im Template
(`latitude=53.5511&longitude=9.9937`, Hamburg) und lassen sich im
Funktionen-Editor anpassen.

## Nach der Installation

Das Paket legt die Funktionen `meine_ip` und `luftqualitaet` sowie die
Vorgänge `meine_ip` (Modus `deterministic`) und `luftqualitaet` (Modus
`hybrid`) an.

1. Deterministik testen: „wie ist meine ip".
2. Hybrid testen: „wie ist die luftqualitaet" — das LLM ordnet den AQI ein.
3. Eigene Erweiterung: andere JSON-Endpunkte per `http('https://…')` abrufen
   (Muster siehe [Praxisrezepte](../../../doc/RECIPES.md)).
