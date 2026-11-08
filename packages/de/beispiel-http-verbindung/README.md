# Beispiel: HTTP-Verbindung

Zeigt, wie ein Paket eine **benannte HTTP-Verbindung** mitbringt und darüber
GET- und POST-Aufrufe macht. Die Verbindung `jsonplaceholder` zeigt auf eine
öffentliche Demo-API; die Funktionen sind reine Beispiele.

## Was das Paket anlegt

- HTTP-Verbindung `jsonplaceholder` (Base-URL `https://jsonplaceholder.typicode.com`)
- Funktion `demo_posts` — GET `/posts?_limit=3`
- Funktion `demo_neuer_post` — POST `/posts` mit `title` und `body`

## Muster

```jinja
{# GET über die Verbindung #}
{{ http('jsonplaceholder:/posts?_limit=3') }}

{# POST mit JSON-Body #}
{{ http.request('jsonplaceholder', '/posts', {
     method: 'POST',
     body: { title: args.title, body: args.body, userId: 1 }
   }) }}
```

Die Verbindung fixiert den Host. Ein Pfad kann die Origin nicht verlassen;
Header und Secrets bleiben in der Verbindung. Für Pakete, die eine eigene
API mit Key ansprechen, wird im Manifest `httpConnections` mit
`headers` und ggf. `allowPrivate` deklariert.

## Nach der Installation

1. `demo_posts` ausführen.
2. `demo_neuer_post` mit Titel und Text ausführen.
3. Die Verbindung im Admin-Bereich unter „HTTP-Verbindungen“ ansehen
   (Header bleiben maskiert).
