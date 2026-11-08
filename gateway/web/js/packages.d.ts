// Typen fuer die Paket-Helfer, damit die Node-Tests sie typpruefen koennen.
// Reine Deklaration: Browser laden sie nie, sie liegt aber mit `web/` im Image.
export function setTestPackageHandler(fn: (id: string) => void): void;
export function getPackageForTest(id: string): { id: string } | null;
export function diffValue(from: unknown, to: unknown): string;
export function cmpVersion(a: unknown, b: unknown): number;
export function updateChip(installedVersion: unknown, registryVersion: unknown): string;
export function loadMaintenance(): Promise<void>;
