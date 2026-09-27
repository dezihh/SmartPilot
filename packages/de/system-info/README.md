# System-Info (Shell) — ⚠️ gefährliche Aktion

Legt zwei **Shell-Funktionen** an: `gateway_uptime` (Laufzeit in Tagen via
`/proc/uptime`) und `cpu_type` (CPU-Modell via `/proc/cpuinfo`).

> **Antwortweg:** deterministisch — Funktion liefert den Messwert direkt.

## Was es braucht (Gegenseite)

Nichts — die Funktionen lesen lokale Dateien (`/proc`) im Gateway-Container.
Die `shell()`-Bausteine laufen mit **Timeout 5 s** und **Ausgabe-Cap 4000
Zeichen**.

## ⚠️ Gefährliche Aktion

`shell()`-Templates führen Befehle im Gateway-Container aus. Dieses Paket ist
deshalb als **gefährlich** markiert: beim Install erscheint eine Warnung mit
den betroffenen Funktionen, die Installation verlangt eine Bestätigung.

## Nach der Installation

1. Monitor/Test: „wie lange läuft das Gateway schon" / „welche CPU hat der Server".
2. Eigene Shell-Funktionen: Tab **Funktionen** → mit `{{ shell('...') }}`
   bauen — mit Bedacht: kein Logging, keine Interaktion, kurze Befehle.