import { AsyncLocalStorage } from 'node:async_hooks';

// Zentrale Log-Ausgabe: eine Zeile pro Ereignis, Zeitstempel + Level +
// Anfrage-Kennung + Klartext. Docker/journald sammeln stdout/stderr ohnehin;
// ein JSON-Format wuerde im Terminal nur schwer lesbar sein.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const PRIORITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

// Ungueltige Werte liefern undefined, damit die Konfiguration sie beim Start
// ablehnen kann, statt still auf 'info' zurueckzufallen.
export function parseLogLevel(raw: string | undefined): LogLevel | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : undefined;
}

let currentLevel: LogLevel = 'info';
let sink: (line: string, level: LogLevel) => void = (line, level) => {
  if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function levelEnabled(level: LogLevel): boolean {
  return PRIORITY[level] >= PRIORITY[currentLevel];
}

// Nur fuer Tests: Ausgabe abfangen bzw. zuruecksetzen.
export function setLogSink(fn: ((line: string, level: LogLevel) => void) | undefined): void {
  sink =
    fn ??
    ((line, level) => {
      if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });
}

// Anfrage-Kennung je asynchronem Kontext: Logzeilen aus tieferen Schichten
// tragen sie automatisch, ohne dass jede Funktion sie durchreichen muss.
const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

// Strings mit Leerzeichen/Sonderzeichen werden gequotet; Zahlen, Pfade und
// JSON-Objekte stehen roh in der Zeile (sonst waeren sie doppelt escaped).
function quoteIfNeeded(s: string): string {
  return /^[\w.:/@+-]+$/.test(s) ? s : JSON.stringify(s);
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return quoteIfNeeded(value);
  if (value instanceof Error) return quoteIfNeeded(value.message);
  return JSON.stringify(value) ?? String(value);
}

// Reine Formatierung (testbar): "2026-11-06T20:12:33.456Z INFO  req=… text k=v"
export function formatLine(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
  requestId: string | undefined = currentRequestId(),
  now: Date = new Date()
): string {
  const parts = [now.toISOString(), level.toUpperCase().padEnd(5)];
  if (requestId) parts.push(`req=${requestId}`);
  parts.push(message);
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(' ');
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (!levelEnabled(level)) return;
  sink(formatLine(level, message, fields), level);
}

export const log = {
  debug: (message: string, fields?: LogFields): void => emit('debug', message, fields),
  info: (message: string, fields?: LogFields): void => emit('info', message, fields),
  warn: (message: string, fields?: LogFields): void => emit('warn', message, fields),
  error: (message: string, fields?: LogFields): void => emit('error', message, fields),
};

// Fehler kompakt mitschreiben (ohne Stack bei Warnungen, mit Stack auf debug).
export function logError(message: string, err: unknown, fields: LogFields = {}): void {
  emit('error', message, { ...fields, error: err instanceof Error ? err.message : String(err) });
  if (err instanceof Error && err.stack) emit('debug', `${message} (Stack)`, { stack: err.stack });
}
