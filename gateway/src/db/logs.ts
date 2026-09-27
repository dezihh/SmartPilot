import { getDb } from './schema.js';
import type { TraceEvent } from '../types.js';

export function recentAgentTurns(limit = 2, maxAgeMs = 30 * 60_000): { query: string; response: string; ageMs: number }[] {
  const rows = getDb().prepare(
      "SELECT ts, query, response FROM logs WHERE route = 'agent' AND response != '' ORDER BY id DESC LIMIT ?"
    )
    .all(limit) as { ts?: string; query: string; response: string }[];
  const now = Date.now();
  const parsed = rows
    .map((r) => {
      // datetime('now') ist UTC: ohne TZ-Suffix wuerde Date.parse die
      // Zeitstempel als Lokalzeit lesen (Zeitzonen-Bug, ageMs = Offset).
      const t = r.ts ? Date.parse(r.ts.replace(' ', 'T') + 'Z') : NaN;
      const ageMs = Number.isFinite(t) ? now - t : 0;
      return { query: r.query, response: r.response, ageMs };
    })
    .filter((r) => r.ageMs <= maxAgeMs);
  return parsed.reverse();
}

export interface LogEntry {
  sessionId: string;
  query: string;
  route: string;
  actionId?: number;
  score?: number;
  response: string;
  durationMs: number;
  trace: TraceEvent[];
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
}

let logInserts = 0;

export function addLog(entry: LogEntry): void {
  getDb().prepare(
    `INSERT INTO logs (session_id, query, route, action_id, score, response, duration_ms, trace, prompt_tokens, completion_tokens, llm_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.sessionId,
    entry.query,
    entry.route,
    entry.actionId ?? null,
    entry.score ?? null,
    entry.response,
    entry.durationMs,
    JSON.stringify(entry.trace),
    entry.promptTokens ?? null,
    entry.completionTokens ?? null,
    entry.model ?? null
  );
  // Retention: gelegentlich alte Logs entfernen (kein eigener Cron im Gateway).
  if (++logInserts % 200 === 0) {
    try {
      getDb().prepare("DELETE FROM logs WHERE ts < datetime('now', '-30 days')").run();
    } catch {
      /* Retention ist best-effort */
    }
  }
}

export function summarizeUsage(days = 30): {
  requests: number;
  llmRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedRequests: number;
} {
  const windowDays = Math.max(1, Math.floor(days));
  const rows = getDb().prepare(
      "SELECT prompt_tokens, completion_tokens, trace FROM logs WHERE trace IS NOT NULL AND trace != '' AND ts >= datetime('now', ?)"
    )
    .all(`-${windowDays} days`) as { prompt_tokens: number | null; completion_tokens: number | null; trace: string }[];
  let prompt = 0;
  let completion = 0;
  let cacheHits = 0;
  let llmRequests = 0;
  for (const r of rows) {
    let events: TraceEvent[] = [];
    try {
      events = JSON.parse(r.trace) as TraceEvent[];
    } catch {
      continue;
    }
    const usageEvents = events.filter((e) => e.step === 'llm.usage');
    if (usageEvents.length === 0) continue;
    llmRequests += 1;
    prompt += r.prompt_tokens ?? 0;
    completion += r.completion_tokens ?? 0;
    for (const e of usageEvents) {
      const d = e.detail as { cached?: boolean };
      if (d?.cached) cacheHits += 1;
    }
  }
  return {
    requests: rows.length,
    llmRequests,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    cachedRequests: cacheHits,
  };
}

export function listLogs(limit: number): Record<string, unknown>[] {
  const rows = getDb().prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...r,
    trace: r.trace ? JSON.parse(r.trace as string) : [],
  }));
}
