# Portainer

Liest Container, Stacks, Images und den Systemstatus direkt aus Portainer —
ohne MCP-Sidecar. Das Paket legt die benannte HTTP-Verbindung `portainer` an;
alle Funktionen sind lesend.

## Parameter

| Parameter | Bedeutung |
|---|---|
| `base_url` | Portainer-URL ohne `/api`, z. B. `http://192.168.10.3:9000` |
| `api_key` | API-Key aus Portainer (My account → Access tokens) |
| `endpoint_id` | Umgebungs-ID, meist `1` (siehe `portainer_endpoints`) |

## Sicherheit

- Der API-Key wird maskiert gespeichert und nur an die Verbindung gesendet.
- `allowPrivate` ist gesetzt, weil Portainer typischerweise im LAN läuft. Die
  Verbindung darf nur die konfigurierte Base-URL erreichen; Pfade können den
  Host nicht verlassen.
- Bei einer Rotation den Key in Portainer erneuern und das Paket mit dem neuen
  Parameter erneut installieren.

## Funktionen

| Funktion | Inhalt |
|---|---|
| `portainer_system` | Version und Erreichbarkeit |
| `portainer_endpoints` | Umgebungen mit Name, URL, Status |
| `portainer_containers` | Container inkl. gestoppter |
| `portainer_stacks` | Stacks mit Status |
| `portainer_images` | Docker-Images |
| `portainer_container_inspect` | Details zu einem Container (`id`) |

## Nach der Installation

1. `portainer_endpoints` ausführen und die passende `endpoint_id` prüfen.
2. `portainer_containers` oder `portainer_stacks` abfragen.
3. Bei Bedarf die Parameter im Paket-Editor anpassen und neu installieren.
