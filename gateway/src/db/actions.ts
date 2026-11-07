import { getDb } from './schema.js';
import type { ActionMode, ActionRow, ParsedAction, SideEffect } from '../types.js';

export function parseAction(row: ActionRow): ParsedAction {
  let triggers: string[] = [];
  try {
    triggers = row.trigger_phrases ? (JSON.parse(row.trigger_phrases) as unknown[]).map(String) : [];
  } catch {
    triggers = [];
  }
  // Normierte Tool-Liste: fehlt die Spalte, gilt "keine" (leere Auswahl).
  // "Alle" gibt es als Spezialfall nicht mehr - eine Liste mit allen Tools
  // wird explizit geschrieben (Select-All in der UI).
  let toolList: string[] = [];
  try {
    toolList = row.tools ? (JSON.parse(row.tools) as unknown[]).map(String) : [];
  } catch {
    toolList = [];
  }
  let functionArgs: Record<string, unknown> | null = null;
  try {
    const parsed = row.function_args ? (JSON.parse(row.function_args) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      functionArgs = parsed as Record<string, unknown>;
    }
  } catch {
    functionArgs = null;
  }
  // Issue #4: Bestandszeilen ohne Spalte (alte Sicherung) fallen auf die
  // verhaltensneutralen Defaults zurueck.
  const sideEffect: SideEffect = row.side_effect === 'read' ? 'read' : 'write';
  return { ...row, triggers, toolList, functionArgs, side_effect: sideEffect, confirm: row.confirm ? 1 : 0 };
}

export function listActions(enabledOnly: boolean): ParsedAction[] {
  const rows = enabledOnly
    ? (getDb().prepare('SELECT * FROM actions WHERE enabled = 1 ORDER BY id').all() as ActionRow[])
    : (getDb().prepare('SELECT * FROM actions ORDER BY id').all() as ActionRow[]);
  return rows.map(parseAction);
}

export function getAction(id: number): ParsedAction | undefined {
  const row = getDb().prepare('SELECT * FROM actions WHERE id = ?').get(id) as ActionRow | undefined;
  return row ? parseAction(row) : undefined;
}

export function createAction(input: ActionInput): ParsedAction {
  const data = { side_effect: 'write', confirm: 0, ...input };
  const info = getDb().prepare(
      `INSERT INTO actions (name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, function_ref, function_args, tools, enabled, side_effect, confirm)
       VALUES (@name, @mode, @trigger_phrases, @fuzzy_threshold, @system_prompt, @template, @function_ref, @function_args, @tools, @enabled, @side_effect, @confirm)`
    )
    .run(data);
  const row = getAction(Number(info.lastInsertRowid));
  if (!row) throw new Error('Action konnte nicht gelesen werden');
  return row;
}

export function updateAction(id: number, input: ActionInput): ParsedAction | undefined {
  const data = { side_effect: 'write', confirm: 0, ...input };
  getDb().prepare(
    `UPDATE actions SET name = @name, mode = @mode, trigger_phrases = @trigger_phrases,
     fuzzy_threshold = @fuzzy_threshold, system_prompt = @system_prompt, template = @template,
     function_ref = @function_ref, function_args = @function_args, tools = @tools, enabled = @enabled,
     side_effect = @side_effect, confirm = @confirm, updated_at = datetime('now')
     WHERE id = @id`
  ).run({ ...data, id });
  return getAction(id);
}

export function deleteAction(id: number): void {
  getDb().prepare('DELETE FROM actions WHERE id = ?').run(id);
}

export interface ActionInput {
  name: string;
  mode: ActionMode;
  trigger_phrases: string;
  fuzzy_threshold: number | null;
  system_prompt: string | null;
  template: string | null;
  function_ref: string | null;
  function_args: string | null;
  tools: string | null;
  enabled: number;
  /** Default 'write' (verhaltensneutral); 'read' = nur lesend. */
  side_effect?: SideEffect;
  /** 1 = vor dem Ausfuehren nachfragen. */
  confirm?: number;
}
