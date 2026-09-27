# Wetter (Open-Meteo)

Legt die Funktion **`wetter`** an: aktuelles Wetter und 3-Tage-Vorhersage aus
der [Open-Meteo](https://open-meteo.com)-Forecast-API (DWD-ICON-Modell,
Wettercodes als sprechbare Texte, Temperaturen mit Komma).

> **Antwortweg:** deterministisch — Vorgang → Funktion spricht direkt
> (hybrid möglich).

## Was es braucht (Gegenseite)

Nichts — öffentliche API, kein Key. Der Gateway-Container braucht
Internetzugang zu `api.open-meteo.com`.

## Parameter beim Install

| Parameter | Bedeutung | Default |
|---|---|---|
| `latitude` | Breitengrad des Standorts | `53.6653` (Referenz-Haus — **bitte anpassen!**) |
| `longitude` | Längengrad des Standorts | `10.2826` (Referenz-Haus — **bitte anpassen!**) |
| `timezone` | Zeitzone, URL-encodiert | `Europe%2FBerlin` |

> Die Default-Koordinaten gehören zur Referenz-Installation. Trage beim
> Install deine eigenen Koordinaten ein (z. B. aus
> [open-meteo.com](https://open-meteo.com) — dort zeigt der Kartenklick die
> Koordinaten der eigenen Suche).

## Nach der Installation

1. Tab **Funktionen** → `wetter` → **Ausführen** (Test).
2. Vorgänge anlegen? „Wetter heute" als Trigger → Modus `deterministic`,
    Funktion `wetter` (siehe [Praxisrezepte](../../../doc/RECIPES.md)).