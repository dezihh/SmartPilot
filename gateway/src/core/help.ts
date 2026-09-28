// Deterministische Hilfe (ohne LLM): nennt zu jeder eingerichteten Faehigkeit
// GENAU eine generische Zeile - nichts erfinden, nichts weglassen. So waechst
// die Hilfe zuverlaessig mit den installierten Paketen, unabhaengig vom Modell.
// Werkzeuge = registrierte Funktionen, Systeme = registrierte MCP-Server.
import { listFunctions } from '../db/functions.js';
import { listMcpServers } from '../db/mcpServers.js';
import { getSetting } from '../db/settings.js';

// Eine Zeile je Faehigkeit; Notiz bevorzugt, sonst Kurzbeschreibung, sonst nur
// der Name (generische Hilfe - kein Tool darf fehlen).
function toolLine(name: string, ...notes: (string | null | undefined)[]): string {
  const text = notes.map((n) => (n ?? '').trim()).find((n) => n.length > 0);
  return text ? `- ${name}: ${text}` : `- ${name}`;
}

export function buildHelpSpeech(): string {
  const name = getSetting('assistant_name') ?? 'Dein SmartPilot';
  const tools = listFunctions(true).map((f) => toolLine(f.name, f.inventory_prompt, f.description));
  const systems = listMcpServers(true).map((s) => toolLine(s.name, s.inventory_prompt));

  const parts: string[] = [];
  if (tools.length === 0 && systems.length === 0) {
    parts.push(
      'Zurzeit sind noch keine Fähigkeiten eingerichtet. Du kannst im Admin-Bereich unter "Pakete" Erweiterungen hinzufügen.'
    );
  } else {
    parts.push('Das kann ich aktuell:');
    if (tools.length > 0) parts.push(`Werkzeuge:\n${tools.join('\n')}`);
    if (systems.length > 0) parts.push(`Systeme:\n${systems.join('\n')}`);
  }
  parts.push(
    `Grundfunktionen habe ich immer: Ich sage dir meinen Namen auf "wie heisst du", beantworte einzelne freie Fragen ohne Kommando (z. B. "frage ${name} warum ist der Himmel blau") und bleibe in einem laufenden Gespräch ("starte chat modus", Ende mit "chat beenden").`
  );
  parts.push('Was interessiert dich?');
  return parts.join('\n\n');
}
