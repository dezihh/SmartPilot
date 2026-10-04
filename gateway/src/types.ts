export type ActionMode = 'deterministic' | 'llm' | 'hybrid';

// Ob ein Tool/Server/funktion den Aussenwelt-Zustand veraendern kann. 'write'
// (Default) verwirft den Entity-Index-Cache nach dem Aufruf, 'read' nicht.
export type SideEffect = 'read' | 'write';

export interface VoiceQuery {
  sessionId: string;
  userId?: string;
  text: string;
}

export interface DisplayPayload {
  title?: string;
  text?: string;
  images?: string[];
  video?: string;
}

export interface AssistantResponse {
  speech: string;
  ssml?: boolean;
  display?: DisplayPayload;
  followUp?: boolean;
  followupPrompt?: string;
  keepOpen?: boolean;
}

export interface ActionRow {
  id: number;
  name: string;
  mode: ActionMode;
  trigger_phrases: string | null;
  fuzzy_threshold: number | null;
  system_prompt: string | null;
  template: string | null;
  function_ref: string | null;
  function_args: string | null;
  tools: string | null;
  enabled: number;
}

export interface ParsedAction extends ActionRow {
  triggers: string[];
  toolList: string[];
  functionArgs: Record<string, unknown> | null;
}

export interface McpServerRow {
  id: number;
  name: string;
  url: string;
  auth_token: string | null;
  transport: 'http' | 'stdio';
  command: string | null;
  args: string | null;
  env: string | null;
  /** npm-Paket zum Provisionieren des stdio-Servers (z. B. "@scope/bin@1.2.3"). */
  npm_spec: string | null;
  inventory_prompt: string | null;
  side_effect: SideEffect;
  enabled: number;
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface TraceEvent {
  ts: number;
  step: string;
  detail?: unknown;
}

export interface EngineResult {
  response: AssistantResponse;
  route: string;
  actionId?: number;
  score?: number;
  durationMs: number;
  trace: TraceEvent[];
}
