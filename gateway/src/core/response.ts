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

export function parseAgentAnswer(content: string, trace: TraceEvent[]): AssistantResponse {
  const filtered = content
    .replace(/<\|?tool_call>[\s\S]*?(?:<tool_call\|>|<\|end_of_turn\|>|$)/gi, '')
    .replace(/<\|[^>]*\|>/g, '')
    .trim();
  if (filtered !== content.trim()) {
    trace.push({ ts: Date.now(), step: 'agent.leak_filtered', detail: { lenBefore: content.length, lenAfter: filtered.length } });
  }
  const text = filtered.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { needs_clarification?: boolean; speech?: string; keep_open?: boolean };
      if (typeof parsed.speech === 'string' && parsed.speech.trim().length > 0) {
        return { speech: parsed.speech, followUp: parsed.needs_clarification === true, keepOpen: parsed.keep_open === true };
      }
      trace.push({ ts: Date.now(), step: 'agent.empty_speech' });
      return { speech: 'Entschuldigung, dazu habe ich gerade nichts gefunden.' };
    } catch {
      trace.push({ ts: Date.now(), step: 'agent.json_parse_error' });
    }
  }
  if (text.length === 0) {
    trace.push({ ts: Date.now(), step: 'agent.empty_content' });
    return { speech: 'Entschuldigung, dazu habe ich gerade nichts gefunden.' };
  }
  return { speech: text };
}
