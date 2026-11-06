import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import mqtt from 'mqtt';

// Interner MQTT-MCP-Server: laeuft als stdio-Kindprozess des Gateways und
// haelt fuer alle Topics einen Last-Value-Cache. Schreiben ist nur auf
// explizit erlaubte Topics moeglich - ein offener Publish-Tool waere auf einem
// Broker ein Freifahrtschein fuer Geraete, die SmartPilot nie steuern soll.
export const MAX_TOPICS = 1000;
export const MAX_VALUE_BYTES = 4096;
export const MAX_SNAPSHOTS = 50;
// Kurz nach dem Verbinden kommen die retain-Nachrichten; erst danach lohnt
// ein Snapshot (sonst meldet er faelschlich "keine Werte").
export const SETTLE_MS = 1500;
export const TAG = '[MQTT]';

export interface Settings {
  url: string;
  username?: string;
  password?: string;
  prefix: string;
  clientId: string;
  allowWrite: string[];
}

export function parseSettings(env: NodeJS.ProcessEnv): Settings {
  const url = (env.MQTT_URL ?? '').trim();
  if (!url) throw new Error('MQTT_URL fehlt (z. B. mqtt://broker:1883)');
  const password = env.MQTT_PASSWORD;
  return {
    url,
    username: env.MQTT_USERNAME?.trim() || undefined,
    // Passwort unveraendert uebernehmen: Leerzeichen koennen Teil des Secrets sein.
    password: password === undefined || password === '' ? undefined : password,
    prefix: normalizePrefix(env.MQTT_PREFIX),
    clientId: env.MQTT_CLIENT_ID?.trim() || 'smartpilot-mqtt',
    allowWrite: (env.MQTT_ALLOW_WRITE ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

// Praefix wie 'haus/' - fuehrender/abschliessender Slash wird vereinheitlicht.
export function normalizePrefix(raw: string | undefined): string {
  const p = (raw ?? '').trim().replace(/^\/+/, '');
  if (!p) return '';
  return p.endsWith('/') ? p : `${p}/`;
}

// Topic fuer Anzeige/Aufruf: fuehrender Slash weg, Praefix ergaenzen, wenn er
// fehlt. Wildcards sind fuer get/set sinnlos (kein einzelner Wert) und werden
// abgelehnt; sie kaemen sonst als Topic-Namen in den Cache.
export function normalizeTopic(topic: string, prefix: string): string | null {
  const raw = String(topic ?? '').trim().replace(/^\/+/, '');
  if (!raw || /[+#]/.test(raw)) return null;
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
}

// Relative Darstellung ohne Praefix (so sieht der Nutzer die Topics in der UI).
export function displayTopic(topic: string, prefix: string): string {
  return prefix && topic.startsWith(prefix) ? topic.slice(prefix.length) : topic;
}

// Schreibfreigabe: exakter Topic-Name oder Praefix mit '#'/'*' ('haus/#').
export function isWriteAllowed(topic: string, allowWrite: readonly string[]): boolean {
  return allowWrite.some((entry) => {
    const pattern = entry.trim().replace(/^\/+/, '');
    if (!pattern) return false;
    if (pattern.endsWith('/#')) return topic === pattern.slice(0, -2) || topic.startsWith(pattern.slice(0, -1));
    if (pattern.endsWith('/*')) return topic.startsWith(pattern.slice(0, -1));
    return topic === pattern;
  });
}

// Werte kappen: ein Broker darf den Gateway-Speicher nicht fluten.
export function truncateValue(raw: string): string {
  if (Buffer.byteLength(raw, 'utf8') <= MAX_VALUE_BYTES) return raw;
  return `${Buffer.from(raw, 'utf8').subarray(0, MAX_VALUE_BYTES - 3).toString('utf8')}...`;
}

// Last-Value-Cache mit Deckel: aeltester Eintrag faellt zuerst (FIFO), damit
// ein schwatzhafter Broker den Prozess nicht unbegrenzt wachsen laesst.
export class LastValueCache {
  private readonly values = new Map<string, string>();

  set(topic: string, value: string): void {
    const capped = truncateValue(value);
    this.values.delete(topic);
    this.values.set(topic, capped);
    while (this.values.size > MAX_TOPICS) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  get(topic: string): string | undefined {
    return this.values.get(topic);
  }

  size(): number {
    return this.values.size;
  }

  // Sortiert nach Topic, begrenzt (Standard: MAX_SNAPSHOTS).
  snapshot(limit = MAX_SNAPSHOTS): [string, string][] {
    const max = Math.max(1, Math.min(limit, MAX_SNAPSHOTS));
    return [...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, max);
  }
}

export interface ServerDeps {
  cache: LastValueCache;
  settings: Settings;
  publish: (topic: string, value: string) => Promise<void>;
  /** true, solange nach dem Verbinden die retain-Nachrichten noch ausstehen. */
  settling?: () => boolean;
}

const TOOLS = [
  {
    name: 'mqtt_get',
    description: 'Wert eines MQTT-Topics aus dem Last-Value-Cache (z. B. "keller/temperatur").',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'Topic ohne Praefix' } },
      required: ['topic'],
    },
  },
  {
    name: 'mqtt_snapshot',
    description: 'Alle bekannten MQTT-Topics mit ihrem letzten Wert (optional begrenzt).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Hochstzahl der Zeilen (max. 50)' } },
    },
  },
  {
    name: 'mqtt_set',
    description: 'Setzt ein erlaubtes MQTT-Topic (retained, QoS 1). Nur freigegebene Topics.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic ohne Praefix' },
        value: { type: 'string', description: 'Nutzlast, z. B. ON/OFF' },
      },
      required: ['topic', 'value'],
    },
  },
];

type RpcRequest = { id?: number | string; method?: string; params?: Record<string, unknown> };
type RpcResponse = { jsonrpc: '2.0'; id: number | string; result?: unknown; error?: { code: number; message: string } };

function textResult(text: string, isError = false): unknown {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

// JSON-RPC-Dispatch ohne Seiteneffekte auf stdin/stdout - so testbar.
export async function handleRequest(msg: RpcRequest, deps: ServerDeps): Promise<RpcResponse | null> {
  const { settings } = deps;
  const id = msg.id ?? 0;
  const method = msg.method ?? '';
  // Notifications (ohne id) bekommen keine Antwort.
  if (msg.id === undefined) return null;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'smartpilot-mqtt', version: '0.5.0' },
      },
    };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

  if (method === 'tools/call') {
    const params = msg.params ?? {};
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    if (name === 'mqtt_get') {
      const topic = normalizeTopic(String(args.topic ?? ''), settings.prefix);
      if (!topic) return { jsonrpc: '2.0', id, result: textResult(`${TAG} ungueltiges Topic`, true) };
      const value = deps.cache.get(topic);
      const label = `${TAG} ${displayTopic(topic, settings.prefix)}`;
      return {
        jsonrpc: '2.0',
        id,
        result: value === undefined ? textResult(`${label}=unbekannt`) : textResult(`${label}=${value}`),
      };
    }

    if (name === 'mqtt_snapshot') {
      const limit = Number(args.limit ?? MAX_SNAPSHOTS);
      const rows = deps.cache.snapshot(Number.isFinite(limit) ? limit : MAX_SNAPSHOTS);
      if (!rows.length) {
        const hint = deps.settling?.() ? ' (verbinde noch, gleich erneut fragen)' : '';
        return { jsonrpc: '2.0', id, result: textResult(`${TAG} keine Werte${hint}`) };
      }
      const lines = rows.map(([topic, value]) => `${TAG} ${displayTopic(topic, settings.prefix)}=${value}`);
      return { jsonrpc: '2.0', id, result: textResult(lines.join('\n')) };
    }

    if (name === 'mqtt_set') {
      const topic = normalizeTopic(String(args.topic ?? ''), settings.prefix);
      if (!topic) return { jsonrpc: '2.0', id, result: textResult(`${TAG} ungueltiges Topic`, true) };
      if (!isWriteAllowed(topic, settings.allowWrite)) {
        return {
          jsonrpc: '2.0',
          id,
          result: textResult(`${TAG} nicht erlaubt: ${displayTopic(topic, settings.prefix)} (MQTT_ALLOW_WRITE)`, true),
        };
      }
      const value = String(args.value ?? '');
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
        return { jsonrpc: '2.0', id, result: textResult(`${TAG} Wert zu gross (max. ${MAX_VALUE_BYTES} Byte)`, true) };
      }
      try {
        await deps.publish(topic, value);
      } catch (e) {
        return {
          jsonrpc: '2.0',
          id,
          result: textResult(`${TAG} Publish fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`, true),
        };
      }
      deps.cache.set(topic, value);
      return { jsonrpc: '2.0', id, result: textResult(`${TAG} ${displayTopic(topic, settings.prefix)}=${value}`) };
    }

    return { jsonrpc: '2.0', id, result: textResult(`${TAG} unbekanntes Tool: ${name}`, true) };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Methode nicht unterstuetzt: ${method}` } };
}

// Verbindet Cache und stdin/stdout. Alle Logs gehen auf stderr - stdout ist
// ausschliesslich fuer JSON-RPC reserviert.
export function startServer(settings: Settings): void {
  const cache = new LastValueCache();
  const client = mqtt.connect(settings.url, {
    clientId: settings.clientId,
    username: settings.username,
    password: settings.password,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
  });

  client.on('connect', () => {
    client.subscribe(`${settings.prefix}#`, { qos: 1 }, (err) => {
      process.stderr.write(`${TAG} verbunden mit ${settings.url}: ${err ? err.message : `abonniert ${settings.prefix}#`}\n`);
    });
  });
  client.on('error', (err: Error) => {
    process.stderr.write(`${TAG} Verbindungsfehler: ${err.message}\n`);
  });
  client.on('message', (topic: string, payload: Buffer) => {
    cache.set(topic, payload.toString('utf8'));
  });

  // Bis SETTLE_MS nach dem Verbinden koennen retain-Nachrichten noch fehlen.
  let settleUntil = 0;
  client.on('connect', () => {
    settleUntil = Date.now() + SETTLE_MS;
  });

  const deps: ServerDeps = {
    cache,
    settings,
    publish: async (topic, value) => {
      await client.publishAsync(topic, value, { qos: 1, retain: true });
    },
    settling: () => Date.now() < settleUntil,
  };

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcRequest;
    try {
      msg = JSON.parse(trimmed) as RpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    void handleRequest(msg, deps)
      .then((res) => {
        if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
      })
      .catch((e: unknown) => {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id ?? 0,
            error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
          })}\n`
        );
      });
  });
  rl.on('close', () => {
    client.end(true);
    process.exit(0);
  });
}

function main(): void {
  try {
    startServer(parseSettings(process.env));
  } catch (e) {
    process.stderr.write(`${TAG} Start fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

// Nur als Programm starten, nicht beim Import in Tests.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry && import.meta.url === entry) main();
