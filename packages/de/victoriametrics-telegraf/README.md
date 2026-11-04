# VictoriaMetrics/Telegraf Host-Status

## Was es braucht (Gegenseite)

- VictoriaMetrics oder eine Prometheus-kompatible TSDB.
- Telegraf-Metriken: `cpu_usage_user`, `mem_used_percent`, `disk_used_percent`, `system_uptime`.
- Kein Auth im LAN; der Gateway-Container muss die URL erreichen.
- Bei Prometheus mit `node_exporter` heißen die Metriken anders — dann das Template nach dem Install anpassen.

## Parameter beim Install

| Parameter | Bedeutung | Beispiel |
|---|---|---|
| `metrics_url` | Basis-URL ohne `/api/v1/query` | `http://192.168.10.4:8428` |
| `host` | Hostname im Metrik-Label `host` | `hotel` |

Die Standardwerte sind Beispiele und müssen auf die eigene Instanz angepasst werden.

## Nach der Installation

1. Testen: „Wie geht es dem Server?" oder „Wie voll ist die Platte?"
2. Die Funktion `vm_host_status` liefert CPU, RAM, Disk `/` und Uptime; die Quelle wird als `[VictoriaMetrics]` ausgewiesen.
3. Die PromQL-Abfragen sind URL-kodiert. Das ist Absicht: So bleibt die `http()`-URL ein statisches Literal und private LAN-URLs werden nicht vom SSRF-Schutz blockiert.

Die Funktion ist bewusst auf **einen** Host und die Telegraf-Metriknamen zugeschnitten. Für weitere Hosts entweder ein zweites Paket/Install mit anderem `host` oder das Template im Editor erweitern.
