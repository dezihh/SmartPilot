// Beispieldaten fuer den Erststart ("Soforterlebnis").
//
// Ablauf: Der Server ruft seedExample() direkt nach initDb(). Ist die
// Datenbank neu und SEED_PROFILE nicht abgeschaltet, wird das Beispielpaket
// aus dem Image installiert und ein Marker gesetzt. Ein zweiter Start findet
// den Marker und tut nichts.
//
// Bewusst NICHT geseedet: alles, was Zugangsdaten, Hosts oder Home Assistant
// braucht. Der Seed bestaetigt auch keine Gefahrenhinweise - waere ein Paket
// mit shell()/stdio dabei, wuerde die Installation hier scheitern und nur
// geloggt.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, DEFAULT_SEED_PROFILE } from '../config.js';
import { parseManifest, type PackageManifest } from '../core/packages.js';
import { log, logError } from '../core/logger.js';
import { installPackage } from './packages.js';
import { getSetting, setSetting } from './settings.js';

// Der Marker verhindert ein zweites Seeden (auch nach einem Absturz mitten
// im Vorgang bleibt nichts doppelt: die Paketinstallation ist ein Upsert).
const SEED_MARKER = 'seed_profile';
const WEATHER_MANIFEST = 'open-meteo-wetter.manifest.json';
const DISABLED = new Set(['none', 'off', '0', 'false']);

// Beispielstandort: Berlin. Aenderbar in den Grundeinstellungen des Pakets.
const EXAMPLE_VALUES = {
  latitude: '52.5200',
  longitude: '13.4050',
  timezone: 'Europe/Berlin',
};

// Beispiel-Vorgaenge: Wetter (nutzt die Funktion des mitgelieferten Pakets)
// und Laufzeit (eigene Funktion ohne externen Dienst).
const starterManifest: PackageManifest = {
  id: 'seed-starter',
  version: '1.0.0',
  name: 'Beispiel-Vorgaenge',
  summary: 'Wetter und Laufzeit fuer das Soforterlebnis.',
  description:
    'Zwei Vorgaenge ohne Zugangsdaten: aktuelles Wetter (Open-Meteo, Beispielstandort Berlin) und die Laufzeit des Gateways seit dem Start des Containers.',
  author: 'dezihh',
  license: 'MIT',
  language: 'de',
  category: 'function',
  functions: [
    {
      name: 'laufzeit',
      description: 'Laufzeit des Gateways in Tagen, Stunden und Minuten. Keine Argumente.',
      inventory_prompt: 'Laufzeit: wie lange das Gateway schon laeuft (Prozess-Start, keine Systemzeit)',
      template: [
        '{%- set s = uptime -%}',
        '{%- set d = (s / 86400) | int -%}',
        '{%- set h = ((s % 86400) / 3600) | int -%}',
        '{%- set m = ((s % 3600) / 60) | int -%}',
        'Das Gateway läuft seit {% if d > 0 %}{{ d }} Tagen, {% endif %}{{ h }} Stunden und {{ m }} Minuten.',
      ].join('\n'),
    },
  ],
  actions: [
    {
      name: 'Wetter',
      mode: 'deterministic',
      trigger_phrases: ['wetter', 'wie ist das wetter', 'wetterbericht', 'regnet es', 'temperatur'],
      function_ref: 'wetter',
      enabled: true,
      side_effect: 'read',
    },
    {
      name: 'Laufzeit',
      mode: 'deterministic',
      trigger_phrases: ['laufzeit', 'uptime', 'wie lange läufst du', 'wie lange laeuft das gateway'],
      function_ref: 'laufzeit',
      enabled: true,
      side_effect: 'read',
    },
  ],
};

/** Verzeichnis der mitgelieferten Beispielpakete (im Image /app/seed). */
export function seedDir(): string {
  return (process.env.SEED_DIR ?? '').trim() || '/app/seed';
}

/**
 * Legt die Beispieldaten an, sofern das Profil aktiv ist, die Datenbank noch
 * keinen Marker traegt und die Manifeste im Image liegen. Fehler werden
 * geloggt, nie geworfen: ein fehlgeschlagener Seed darf den Start nicht
 * verhindern.
 */
export function seedExample(): void {
  const profile = config.seedProfile.trim().toLowerCase();
  if (DISABLED.has(profile)) return;
  if (profile !== DEFAULT_SEED_PROFILE) {
    log.warn('seed: unbekanntes Profil, uebersprungen', { profile });
    return;
  }
  if (getSetting(SEED_MARKER)) return;

  const file = join(seedDir(), WEATHER_MANIFEST);
  if (!existsSync(file)) {
    log.info('seed: keine Beispieldaten im Image, uebersprungen', { file });
    return;
  }
  const parsed = parseManifest(readFileSync(file, 'utf8'));
  if (!parsed.ok) {
    logError('seed: Wetter-Manifest ungueltig', new Error(parsed.errors.join('; ')));
    return;
  }

  try {
    installPackage(parsed.manifest, { source: 'seed', values: EXAMPLE_VALUES });
    installPackage(starterManifest, { source: 'seed' });
  } catch (e) {
    logError('seed: Beispieldaten nicht angelegt', e);
    return;
  }
  setSetting(SEED_MARKER, `${DEFAULT_SEED_PROFILE}@${parsed.manifest.version}`);
  log.info('seed: Beispieldaten angelegt', {
    profile: DEFAULT_SEED_PROFILE,
    package: parsed.manifest.id,
    version: parsed.manifest.version,
  });
}
