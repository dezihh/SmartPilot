# Websuche SearXNG

Legt den Registry-Eintrag für die **mcp-searxng**-stdio-Brücke an (läuft im
Gateway-Container, kein Extra-Container auf Gateway-Seite) und hakt die
Such-Werkzeuge in der Allowlist an.

> **Antwortweg:** Agent (LLM) — der Agent ruft die Such-Werkzeuge selbst.

## Was es braucht (Gegenseite)

Eine **SearXNG-Instanz** per Docker:

```yaml
searxng:
  image: searxng/searxng:latest
  container_name: searxng
  restart: unless-stopped
  ports:
    - "8080:8080"
  volumes:
    - ./searxng:/etc/searxng
```

**Wichtig**: in `searxng/settings.yml` die JSON-API freischalten, sonst
liefert die Brücke nur Fehler:

```yaml
search:
  formats:
    - html
    - json
```

## Parameter beim Install

| Parameter | Bedeutung | Default |
|---|---|---|
| `searxng_url` | Vollständige Such-URL inkl. `/search` | — (erforderlich) |

## Nach der Installation

1. Tool-Registry → **Tools abfragen** — die Such-Werkzeuge erscheinen.
2. Monitor/Test: „Neuigkeiten bei heise" oder „was gibt es Neues zur Ki-Woche".