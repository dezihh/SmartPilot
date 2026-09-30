# Beispiel: Home Assistant

Legt die Beispiel-Funktion **`hausstatus`** an: Sonnenstand (`sun.sun`) und
Anwesenheit (`zone.home`) in einem fertigen Bericht. Beide Entities gibt es in
jeder Home-Assistant-Installation — das Rezept zeigt, wie man Index-Werte
deterministisch formuliert und dient als Vorlage für eigene Funktionen.

> **Antwortweg:** Agent (LLM) — nutzt `fn_hausstatus`; optional als Vorgang
> mit Trigger `hausstatus`.

## Was es braucht (Gegenseite)

- Das Paket **`home-assistant`** (Entity-Index mit `sun.sun` und `zone.home`).
- Sonst nichts — die beiden Entities sind Standard.

## Parameter beim Install

Keine.

## Nach der Installation

Das Paket legt Funktion `hausstatus` **und** den Vorgang `hausstatus` an
(Trigger `hausstatus`, Modus `deterministic`).

1. Funktion testen: Tab **Funktionen** → `hausstatus` → **Ausführen**.
2. Vorgang testen: „wie ist der hausstatus".
3. Eigene Erweiterung: im Funktionen-Editor weitere Entities ergänzen
   (Muster siehe [Praxisrezepte](../../../doc/RECIPES.md)).
