// Basis-Werkzeuge (Variante A): fn_find_entities/fn_get_entity sind kein
// DB-Seed mehr, sondern feste Tools im Gateway-Code - unzerstoerbar, nicht
// konfigurierbar, immer angeboten (unabhaengig von agent_tools).
// Die Pure-Fassungen nimmt der Template-Renderer mit vorbereitetem Snapshot;
// die Async-Fassungen dienen der direkten Tool-Ausfuehrung.
import { getIndexSnapshot, scoreEntries, fmtEntry, type IndexEntry } from './entityIndex.js';

export function findInSnapshot(snapshot: IndexEntry[], query: string, max = 8, key = ''): string {
  if (snapshot.length === 0) return 'Index nicht verfuegbar';
  const hits = scoreEntries(snapshot, String(query ?? ''), max, key).map(fmtEntry);
  return hits.length > 0 ? hits.join('\n') : 'keine Treffer';
}

export function getFromSnapshot(snapshot: IndexEntry[], id: string, _key = ''): string {
  if (snapshot.length === 0) return 'Index nicht verfuegbar';
  const found = snapshot.find((e) => e.id === id);
  return found ? fmtEntry(found) : `${id}: nicht im Index (ID ungueltig) - nutze fn_find_entities mit dem Namen, statt IDs zu raten`;
}

export async function findIndexEntries(query: string, key = ''): Promise<string> {
  return findInSnapshot(await getIndexSnapshot(key), query, 8, key);
}

export async function getIndexEntry(id: string, key = ''): Promise<string> {
  return getFromSnapshot(await getIndexSnapshot(key), id, key);
}