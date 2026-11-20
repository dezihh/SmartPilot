// Response-Nachbearbeitung: reine Funktionen (keine Orchestrationskenntnis).
// Alle Schritte sind einzeln testbar - hier lebt der SSML-/Display-/JSON-Flow.
import type { AssistantResponse, TraceEvent } from '../types.js';
import { getSetting } from '../db/settings.js';

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function stripSsmlTags(text: string): string {
  return text
    .replace(/<speak>|<\/speak>/gi, '')
    .replace(/<break[^>]*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    // XML-Entities aufloesen (escapeXml erzeugt sie); &amp; zuletzt, damit
    // "&amp;lt;" korrekt zu "&lt;" und nicht zu "<" wird.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function withSsmlBreaks(resp: AssistantResponse): AssistantResponse {
  if (resp.ssml) return resp;
  const s = resp.speech.trim();
  let parts = s
    .split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2 && s.length >= 160) {
    const sentences = s.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ„"])/);
    if (sentences.length >= 2) {
      parts = [];
      for (let i = 0; i < sentences.length; i += 2) {
        parts.push(sentences.slice(i, i + 2).join(' ').trim());
      }
    }
  }
  if (parts.length < 2 || s.length < 150) return resp;
  const speech = `<speak>${parts
    .map((p) => escapeXml(p).replace(/\s*\n\s*/g, ' '))
    .join('<break time="300ms"/>')}</speak>`;
  return { ...resp, speech, ssml: true };
}

export function withDisplay(resp: AssistantResponse): AssistantResponse {
  const text = resp.display?.text ?? (resp.ssml ? stripSsmlTags(resp.speech) : resp.speech);
  const title = getSetting('display_title') ?? 'SmartPilot';
  return { ...resp, display: { ...resp.display, title, text } };
}

const NO_ANSWER_SPEECH = 'Entschuldigung, dazu habe ich gerade nichts gefunden.';

// Sprachausgabe von Datenresten befreien (Issue #35): Markdown-Links werden
// zu ihrem Label, URLs, Code-Fences und Fett-Marker fliegen raus. Alexa liest
// sonst Woertlich Zeichen vor, die nur in der Anzeige Sinn ergeben.
export function sanitizeSpeech(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)[^\s]*[^\s.,;:!?]/gi, ' ')
    .replace(/`{1,3}/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// JSON-Rohdaten duerfen niemals gesprochen werden. `{` ist immer JSON-Verdacht;
// bei `[` nicht, weil auch ein Markdown-Link so beginnt (`[Quelle](url)`).
export function looksLikeJsonData(text: string): boolean {
  const t = text.trim();
  return t.startsWith('{') || /^\[\s*[{["\d-]/.test(t);
}

// Provider-Sondertokens (DeepSeek u. a.) kommen in voller Breite:
// `<｜｜DSML｜｜tool_calls>` (U+FF5C) oder ASCII `<|tool_call>`. Balken erst
// vereinheitlichen, dann mit einem Ausdruck alle Varianten erkennen.
const TOOL_BARS = /[｜│❘]/g;
const TOOL_TOKEN_RE = /<\/?\|+\s*(?:DSML\s*\|+\s*)?(?:tool_calls?|invoke|parameter)\b/i;

export function containsToolCallSyntax(text: string): boolean {
  return TOOL_TOKEN_RE.test(text.replace(TOOL_BARS, '|'));
}

export function parseAgentAnswer(content: string, trace: TraceEvent[]): AssistantResponse {
  // Erst XML-artige Leaks, dann Provider-Tokens: ab dem ersten Tool-Token ist
  // alles Weitere Tool-Syntax (Invoke/Parameter) und darf nicht gesprochen
  // werden. Text davor bleibt als Antwort erhalten.
  const withoutXml = content
    .replace(/<\|?tool_call>[\s\S]*?(?:<tool_call\|>|<\|end_of_turn\|>|$)/gi, '')
    .replace(/<\|[^>]*\|>/g, '');
  const normalized = withoutXml.replace(TOOL_BARS, '|');
  const tokenAt = normalized.search(TOOL_TOKEN_RE);
  const filtered = (tokenAt >= 0 ? normalized.slice(0, tokenAt) : normalized).trim();
  if (filtered !== content.trim()) {
    trace.push({ ts: Date.now(), step: 'agent.leak_filtered', detail: { lenBefore: content.length, lenAfter: filtered.length } });
  }
  const text = filtered.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (looksLikeJsonData(text)) {
    try {
      const parsed = JSON.parse(text) as { needs_clarification?: boolean; speech?: string; keep_open?: boolean };
      const speech = typeof parsed.speech === 'string' ? sanitizeSpeech(parsed.speech) : '';
      if (speech && !looksLikeJsonData(speech)) {
        return { speech, followUp: parsed.needs_clarification === true, keepOpen: parsed.keep_open === true };
      }
      trace.push({ ts: Date.now(), step: 'agent.empty_speech' });
      return { speech: NO_ANSWER_SPEECH };
    } catch {
      // Abgeschnittenes JSON (z. B. lange Suchtreffer): frueher landete der
      // Rohtext in der Sprachausgabe, jetzt bewusst keine Daten vorlesen.
      trace.push({ ts: Date.now(), step: 'agent.json_parse_error' });
      return { speech: NO_ANSWER_SPEECH };
    }
  }
  const speech = sanitizeSpeech(text);
  if (speech.length === 0) {
    trace.push({ ts: Date.now(), step: 'agent.empty_content' });
    return { speech: NO_ANSWER_SPEECH };
  }
  return { speech };
}
