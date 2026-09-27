# Autobahn-Verkehr

Legt die Funktion **`autobahn`** an: Stau, Baustellen und Warnungen je
Autobahn aus der öffentlichen Autobahn-App-API des Bundes (keyless), gefiltert
auf eine Geo-Box um Zuhause.

> **Antwortweg:** deterministisch — Vorgang → Funktion spricht direkt
> (hybrid möglich).

## Was es braucht (Gegenseite)

Nichts — öffentliche API, kein Key. Der Gateway-Container braucht
Internetzugang zu `verkehr.autobahn.de`.

## ⚠️ Anpassung auf die eigene Region (Pflicht)

Die Funktion ist auf die **Referenz-Region Hamburg** eingestellt. Nach der
Installation im Funktionen-Editor (Tab **Funktionen** → `autobahn`) anpassen:

1. **Autobahn-Nummern** in den `http()`-URLs und den `pick()`-Aufrufen
   (Standard: `A1, A7, A20, A24, A25`).
2. **Geo-Box** (Breite/Länge-Grenzen) im `block()`-Makro auf die eigene
   Region — sie filtert die Meldungen auf Zuhause.

Das ist bewusst kein Install-Parameter: die Struktur ist hartkodiert (5
Blöcke) und in der Template-Datei direkt editierbar.

## Nach der Installation

1. Tab **Funktionen** → `autobahn` → **Ausführen** (Test).
2. Optional: Vorgang „Verkehr auf der A1" mit Trigger `autobahn,stau,verkehr`
   und `args.road` = `A1`.