// Session-State: In-Memory-History pro Session (mit TTL/Deckel statt
// unbegrenztem Clear) + Chat-Modus-Flag. Rein injizierbar/testbar - die
// Engine nutzt hier nur die exports; keine DB-Zugriffe.
import type { ChatMessage } from '../llm/client.js';
import { TEST_HOOKS_ENABLED } from './testEnv.js';

export const HISTORY_MAX_MESSAGES = 8;
export const HISTORY_MAX_SESSIONS = 100;
// Sessions altern nach 2 h Untaetigkeit (Leak-Schutz; vorher: size>100 => clear ALL).
export const SESSION_TTL_MS = 2 * 60 * 60_000;

interface SessionState {
  messages: ChatMessage[];
  lastSeen: number;
  chatMode: boolean;
}

const sessions = new Map<string, SessionState>();

// Issue #4: Bestaetigungsschranke. Ein schreibender Vorgang mit confirm=1
// merkt sich seine Anfrage hier; die naechste Aeusserung loest sie ein.
export const CONFIRM_TTL_MS = 60_000;

export interface PendingConfirm {
  actionId: number;
  text: string;
  expires: number;
}

const pendingConfirms = new Map<string, PendingConfirm>();

export function setPendingConfirm(sessionId: string, actionId: number, text: string, now = Date.now()): void {
  prune(now);
  pendingConfirms.set(sessionId, { actionId, text, expires: now + CONFIRM_TTL_MS });
}

/** Liefert die offene Bestaetigung (und entfernt sie); 'expired' nach TTL. */
export function takePendingConfirm(sessionId: string, now = Date.now()): PendingConfirm | 'expired' | null {
  const pending = pendingConfirms.get(sessionId);
  if (!pending) return null;
  pendingConfirms.delete(sessionId);
  return pending.expires > now ? pending : 'expired';
}

export function resetSessionsForTests(): void {
  if (!TEST_HOOKS_ENABLED) return;
  sessions.clear();
  pendingConfirms.clear();
}

function prune(now = Date.now()): void {
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      sessions.delete(id);
      pendingConfirms.delete(id);
    }
  }
  // Hart-Deckel: aelteste Sessions zuerst werfen.
  while (sessions.size > HISTORY_MAX_SESSIONS) {
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastSeen < oldestTs) {
        oldestTs = s.lastSeen;
        oldest = id;
      }
    }
    if (!oldest) break;
    sessions.delete(oldest);
    pendingConfirms.delete(oldest);
  }
}

export function priorTurns(sessionId: string, maxMessages: number = HISTORY_MAX_MESSAGES): ChatMessage[] {
  prune();
  const msgs = sessions.get(sessionId)?.messages ?? [];
  return maxMessages > 0 && msgs.length > maxMessages ? msgs.slice(-maxMessages) : msgs;
}

export function rememberTurn(
  sessionId: string,
  query: string,
  speech: string,
  now = Date.now(),
  maxMessages: number = HISTORY_MAX_MESSAGES
): void {
  prune(now);
  const s = sessions.get(sessionId) ?? { messages: [], lastSeen: now, chatMode: false };
  s.lastSeen = now;
  s.messages.push({ role: 'user', content: query });
  s.messages.push({ role: 'assistant', content: speech });
  const cap = maxMessages > 0 ? Math.max(maxMessages, HISTORY_MAX_MESSAGES) : HISTORY_MAX_MESSAGES;
  s.messages = s.messages.slice(-cap);
  sessions.set(sessionId, s);
}

export function isChatSession(sessionId: string): boolean {
  prune();
  return sessions.get(sessionId)?.chatMode === true;
}

export function setChatMode(sessionId: string, on: boolean, now = Date.now()): void {
  prune(now);
  const s = sessions.get(sessionId) ?? { messages: [], lastSeen: now, chatMode: false };
  s.lastSeen = now;
  s.chatMode = on;
  sessions.set(sessionId, s);
}
