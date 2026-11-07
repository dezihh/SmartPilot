// Typen fuer die Paket-Helfer, damit die Node-Tests sie typprüfen können.
// Reine Deklaration — wird nicht ausgeliefert.
export function setTestPackageHandler(fn: (id: string) => void): void;
export function getPackageForTest(id: string): { id: string } | null;
export function diffValue(from: unknown, to: unknown): string;
export function cmpVersion(a: unknown, b: unknown): number;
export function loadMaintenance(): Promise<void>;
