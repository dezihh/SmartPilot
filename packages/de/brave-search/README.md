# Websuche Brave

Legt den Registry-Eintrag für die **Brave-Search**-stdio-Brücke (offizielles
`@brave/brave-search-mcp-server`-Paket, läuft via `npx` im Gateway-Container)
und die Funktion **`recherche`** an (Websuche + optionaler Feed-Lese in einem
Call, mit langer Auswertungs-Regel).

> **Antwortweg:** Agent (LLM) — der Agent ruft `fn_recherche` selbst.

## Was es braucht (Gegenseite)

Einen **Brave-Search-API-Key**: auf
[brave.com/search/api](https://brave.com/search/api/) erzeugen (Free-Tier
reicht für den Anfang).

## Parameter beim Install

| Parameter | Bedeutung | Default |
|---|---|---|
| `brave_api_key` | Brave-Search-API-Key | — (erforderlich) |

## Nach der Installation

1. Tool-Registry → **Tools abfragen** — `brave_web_search` erscheint.
2. Monitor/Test: „aktuelles bei heise" — der Agent nutzt `fn_recherche`
   (Suche + `/rss`-Feed-Lese in einem Call).

Nützlich als **Kaskaden-Zweite Quelle**, wenn die Metasuche (SearXNG) leer
bleibt — Details in [Praxisrezepte](../../../doc/RECIPES.md).