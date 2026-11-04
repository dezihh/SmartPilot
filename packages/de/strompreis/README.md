# Strompreis (aWATTar/EPEX)

## Was es braucht (Gegenseite)

- Internetzugang des Gateway-Containers zu `api.awattar.de`.
- Kein API-Key, kein Konto.
- Fair-Use: 100 Requests/Tag. Die Funktion cached 15 Minuten.

## Parameter beim Install

Keine.

## Nach der Installation

1. Im Funktionen-Editor die Funktion `strompreis` prüfen.
2. Testen: „Wie teuer ist der Strom gerade?" oder „Wann ist der Strom am billigsten?"
3. Die Antwort nennt den aktuellen Börsenpreis sowie günstigsten und teuersten Slot der nächsten 24 Stunden in ct/kWh.

**Wichtig:** Das ist der Börsenpreis (EPEX Spot, EUR/MWh), nicht der Endkundenpreis inklusive Netzentgelten, Steuern und Abgaben.

Bei `429 Too Many Requests`: 15-Minuten-Cache greift; nicht in kurzen Abständen neu abfragen.
