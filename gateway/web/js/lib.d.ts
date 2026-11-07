// Typen fuer den Frontend-Helfer, damit die Node-Tests ihn typpruefen koennen.
// Reine Deklaration: Browser laden sie nie, sie liegt aber mit `web/` im Image.
export const API: string;
export function token(): string;
export function api(path: string, options?: Record<string, unknown>): Promise<unknown>;
export function $<T = unknown>(id: string): T | null;
export function esc(value: unknown): string;
