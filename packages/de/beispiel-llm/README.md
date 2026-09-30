# Beispiel: LLM-Vorgang

Reines Beispiel-Rezept: ein **LLM-Vorgang** ohne Funktion und ohne Werkzeuge.
Zeigt, wie ein eigener System-Prompt (statt eines Datenabrufs) eine
Vorgangs-Klasse abdeckt — und dass ein Paket auch nur Vorgänge mitbringen kann.

## Enthält

- Vorgang `erklaeren` (Modus `llm`, ohne Werkzeuge): beantwortet
  Alltagsfragen knapp aus dem Allgemeinwissen.

## Nach der Installation

Das Paket legt nur den Vorgang `erklaeren` an (keine Funktion, keine Tools).

1. Testen: „erklär mir, warum ist der himmel blau".
2. Anpassen: Tab **Vorgänge** → `erklaeren` → System-Prompt ändern.
3. Erweitern: weitere Trigger ergänzen oder im Vorgang `tools` eintragen,
   damit das LLM Werkzeuge nutzen darf.

## Bezug

Grundbegriffe: [Konzepte](../../../doc/CONCEPTS.md) · Paket-Format:
[Paket-README](../../README.md) · Praxisrezepte: [RECIPES](../../../doc/RECIPES.md).
