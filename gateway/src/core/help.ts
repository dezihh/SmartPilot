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

export interface CatalogFilter {
  /** Freigegebene Funktions-/Toolnamen (agent_tools-Semantik): null/undefined = alle, [] = keine. */
  allow?: string[] | null;
  /** Systemnamen, deren Tools der Agent nutzen darf: null/undefined = alle, [] = keine. */
  servers?: string[] | null;
}

// Gleiche Allowlist-Semantik wie das Inventory (Fn-Name oder fn_-Praefix).
function allowedFunction(name: string, allow: string[] | null): boolean {
  if (allow === null) return true;
  return allow.includes(name) || allow.includes(`fn_${name}`);
}

// Katalog der tatsaechlich nutzbaren Faehigkeiten (agent_tools beruecksichtigt).
export function capabilityCatalog(filter: CatalogFilter = {}): { tools: HelpEntry[]; systems: HelpEntry[] } {
  const allow = filter.allow ?? null;
  const tools = listFunctions(true)
    .filter((f) => allowedFunction(f.name, allow))
    .map(functionEntry);
  const servers = filter.servers;
  const systems = listMcpServers(true)
    .filter((s) => servers === undefined || servers === null || servers.includes(s.name))
    .map((s) => ({ name: s.name, text: (s.inventory_prompt ?? '').trim() }));
  return { tools, systems };
}

const MAX_HELP_CHARS = 6000;

// Groessenbegrenzung (Alexa/SSML- und Antwortlimit): harte Kante an Wortgrenze.
function clip(text: string, max = MAX_HELP_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, '')} …`;
}

// Eine Zeile je Eintrag - ohne haengenden Doppelpunkt, wenn kein Text vorliegt.
function bullet(name: string, text: string, empty = ''): string {
  const body = text.trim() || empty;
  return body ? `- ${name}: ${body}` : `- ${name}`;
}

// Katalog als Prompt-Block (groessenbegrenzt). '' wenn nichts eingerichtet ist.
export function renderHelpCatalog(filter: CatalogFilter = {}): string {
  const { tools, systems } = capabilityCatalog(filter);
  const blocks: string[] = [];
  if (tools.length > 0) {
    blocks.push(`## Werkzeuge\n${tools.map((t) => bullet(t.name, t.text, '(ohne Beschreibung)')).join('\n')}`);
  }
  if (systems.length > 0) {
    blocks.push(`## Systeme\n${systems.map((s) => bullet(s.name, s.text, '(ohne Beschreibung)')).join('\n')}`);
  }
  return clip(blocks.join('\n\n'));
}

// Deterministischer Text fuer den Leer-Fall und als Notnagel, wenn das LLM
// nicht antwortet: nennt jede Faehigkeit generisch (eine Zeile) + Grundfunktionen.
//
// Bewusst doppelt gehalten (keine gemeinsame Quelle): Die Grundfunktionen-Formulierung
// steht auch im Seed-Prompt (db/seeds.ts, SEED_HELP_PROMPT) - dort als
// LLM-Anweisung, hier als Sprechtext ohne LLM. Keine Zusammenfuehrung, weil der
// Seed-Prompt nutzereditierbar ist; bei Aenderung beide Stellen pflegen.
export function renderHelpFallback(filter: CatalogFilter = {}): string {
  const name = getSetting('assistant_name') ?? 'Dein SmartPilot';
  const { tools, systems } = capabilityCatalog(filter);
  const head: string[] = [];
  if (tools.length === 0 && systems.length === 0) {
    head.push(
      'Zurzeit sind noch keine Fähigkeiten eingerichtet. Du kannst im Admin-Bereich unter "Pakete" Erweiterungen hinzufügen.'
    );
  } else {
    head.push('Das kann ich aktuell:');
    if (tools.length > 0) head.push(`Werkzeuge:\n${tools.map((t) => bullet(t.name, t.text)).join('\n')}`);
    if (systems.length > 0) head.push(`Systeme:\n${systems.map((s) => bullet(s.name, s.text)).join('\n')}`);
  }
  return [
    clip(head.join('\n\n')),
    `Grundfunktionen habe ich immer: Ich sage dir meinen Namen auf "wie heisst du", beantworte einzelne freie Fragen ohne Kommando (z. B. "frage ${name} warum ist der Himmel blau") und bleibe in einem laufenden Gespräch ("starte chat modus", Ende mit "chat beenden").`,
    'Was interessiert dich?',
  ].join('\n\n');
}
