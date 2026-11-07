# Aufgabenliste (Home Assistant)

Liest und schreibt Todo-Listen aus Home Assistant — Einkaufslisten, Aufgaben,
Packing-Listen. Das Paket bringt **keinen eigenen MCP-Server** mit: es nutzt den
`ha-mcp`-Server der Home-Assistant-Anbindung und ergänzt ihn um die
Todo-Werkzeuge.

## Voraussetzungen

- Paket **Home Assistant Anbindung** (`home-assistant`) ist installiert, der
  `ha-mcp`-Server erreichbar.
- In Home Assistant existiert mindestens eine Todo-Liste, z. B. über
  **Einstellungen → Geräte & Dienste → Integration hinzufügen → „Local To-do“**.
  Deren `entity_id` (z. B. `todo.einkaufsliste`) findest du später in
  `ha_get_todo()`.
- **`ha-mcp` bringt die drei Todo-Werkzeuge mit.** Sie sind seit mindestens
  **v7.9.0** enthalten (bis dorthin geprüft); empfohlen ist **v9.1.0 oder
  neuer**, weil dort die Schreibzugriffe auf die Core-Todo-Services umgestellt
  wurden. Fehlen die Werkzeuge, bleibt der Vorgang ohne Ergebnis — eine
  Fehlermeldung gibt es dann nicht.

## Was das Paket anlegt

| Artefakt | Inhalt |
|---|---|
| Vorgang `Aufgabenliste` | LLM-Vorgang mit den Werkzeugen `ha_get_todo`, `ha_set_todo_item`, `ha_remove_todo_item` |
| `allowTools` | ergänzt die globale Allowlist (`agent_tools`) um dieselben drei Werkzeuge |

Der Vorgang wird über Trigger-Phrasen wie „Einkaufsliste“, „was steht auf der
Liste“, „setz auf die Einkaufsliste“, „abhaken“ oder „von der Liste streichen“
getroffen. Die freie Agent-Frage kann die Listen ebenfalls lesen und schreiben,
weil die Werkzeuge in `agent_tools` stehen.

## Werkzeuge (vom ha-mcp-Server)

| Werkzeug | Zweck | Wichtige Parameter |
|---|---|---|
| `ha_get_todo` | Listen oder Einträge lesen | `entity_id` (leer = alle Listen), `status` (`needs_action` / `completed`) |
| `ha_set_todo_item` | Eintrag anlegen, ändern, umbenennen, verschieben | `entity_id`, `summary` (neu), `item` (bestehend), `status`, `rename`, `due_date`, `move_after` |
| `ha_remove_todo_item` | Eintrag entfernen | `entity_id`, `item` (UID oder exakter Text), `remove_completed` |

Details: <https://homeassistant-ai.github.io/ha-mcp/tools> (Kategorie „Todo Lists“).

## Sicherheitshinweis

Das Paket ist als **gefährlich** markiert: Der Vorgang ändert und entfernt
Todo-Einträge (`ha_set_todo_item`, `ha_remove_todo_item`). Die Rückfrage hängt
nur am Prompt; eine zusätzliche Bestätigungsschranke im Gateway gibt es nicht.
Die Installation verlangt deshalb eine ausdrückliche Bestätigung.

## Beispiele

- „Was steht auf der Einkaufsliste?“ → offene Punkte vorlesen.
- „Setz Milch und Brot auf die Einkaufsliste.“ → zwei Einträge anlegen.
- „Hak Milch ab.“ → `status=completed`.
- „Streiche Brot von der Liste.“ → entfernen.
- „Lösche alle erledigten Punkte.“ → `remove_completed=true` (nur nach
  ausdrücklicher Bestätigung).

## Grenzen

- Das Paket ändert immer nur eine Liste pro Befehl. Bei mehreren plausiblen
  Listen fragt der Agent nach, statt eine `entity_id` zu raten.
- Löschen ist endgültig; „erledigt“ ist der Weg, einen Punkt zu behalten.
- Die Todo-Werkzeuge müssen im installierten `ha-mcp` vorhanden sein (aktuelle
  Version; ältere Stände kennen sie nicht).
