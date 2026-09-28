// Hilfe-Katalog: der LLM bekommt für die Hilfe JEDE eingerichtete Faehigkeit -
// auch solche ohne inventory_prompt (Fallback: description + Parameter). So kann
// das Modell seine Tools und deren Nutzung in einfacher Sprache nennen, ohne
// etwas auszulassen (Ursache der frueheren "Hilfe sagt nichts"-Meldung war der
// unvollstaendige, ueber agent_tools gefilterte Inventory-Katalog).
import { listFunctions, type ParsedFunction } from '../db/functions.js';
import { listMcpServers } from '../db/mcpServers.js';
import { getSetting } from '../db/settings.js';

export interface HelpEntry {
  name: string;
  text: string;
}

// Parameter-Namen samt Beschreibung aus dem JSON-Schema (fuer "wofuer optional").
// parameters kommt bereits geparst (Objekt) aus der DB.
function paramSummary(parameters: unknown): string {
  if (!parameters || typeof parameters !== 'object') return '';
  const props = (parameters as { properties?: Record<string, { description?: string } | undefined> }).properties ?? {};
  return Object.entries(props)
    .map(([key, value]) => (value?.description ? `${key} (${value.description})` : key))
    .filter(Boolean)
    .join('; ');
}

function functionEntry(f: ParsedFunction): HelpEntry {
  const bits = [(f.description ?? '').trim()].filter(Boolean);
  const params = paramSummary(f.parameters);
  if (params) bits.push(`Optionale Angaben: ${params}`);
  return { name: f.name, text: bits.join(' ') };
}

export function capabilityCatalog(): { tools: HelpEntry[]; systems: HelpEntry[] } {
  const tools = listFunctions(true).map(functionEntry);
  const systems = listMcpServers(true).map((s) => ({ name: s.name, text: (s.inventory_prompt ?? '').trim() }));
  return { tools, systems };
}

// Katalog als Prompt-Block. '' wenn nichts eingerichtet ist.
export function renderHelpCatalog(): string {
  const { tools, systems } = capabilityCatalog();
  const blocks: string[] = [];
  if (tools.length > 0) {
    blocks.push(`## Werkzeuge\n${tools.map((t) => `- ${t.name}: ${t.text || '(ohne Beschreibung)'}`).join('\n')}`);
  }
  if (systems.length > 0) {
    blocks.push(`## Systeme\n${systems.map((s) => `- ${s.name}: ${s.text || '(ohne Beschreibung)'}`).join('\n')}`);
  }
  return blocks.join('\n\n');
}

// Deterministischer Text fuer den Leer-Fall und als Notnagel, wenn das LLM
// nicht antwortet: nennt jede Faehigkeit generisch (eine Zeile) + Grundfunktionen.
export function renderHelpFallback(): string {
  const name = getSetting('assistant_name') ?? 'Dein SmartPilot';
  const { tools, systems } = capabilityCatalog();
  const parts: string[] = [];
  if (tools.length === 0 && systems.length === 0) {
    parts.push(
      'Zurzeit sind noch keine Fähigkeiten eingerichtet. Du kannst im Admin-Bereich unter "Pakete" Erweiterungen hinzufügen.'
    );
  } else {
    parts.push('Das kann ich aktuell:');
    if (tools.length > 0) parts.push(`Werkzeuge:\n${tools.map((t) => `- ${t.name}: ${t.text}`).join('\n')}`);
    if (systems.length > 0) parts.push(`Systeme:\n${systems.map((s) => `- ${s.name}: ${s.text}`).join('\n')}`);
  }
  parts.push(
    `Grundfunktionen habe ich immer: Ich sage dir meinen Namen auf "wie heisst du", beantworte einzelne freie Fragen ohne Kommando (z. B. "frage ${name} warum ist der Himmel blau") und bleibe in einem laufenden Gespräch ("starte chat modus", Ende mit "chat beenden").`
  );
  parts.push('Was interessiert dich?');
  return parts.join('\n\n');
}
