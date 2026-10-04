import { config } from './config.js';
import { initDb } from './db/schema.js';

// Runtime-Init mit Referenz-Seed (Tests initialisieren bewusst selbst mit
// Temp-Pfad und ohne Seed - initDb(path) ohne 2. Argument).
initDb(config.dbPath, true);

export { initDb, getDb, getSchemaVersion } from './db/schema.js';
export {
  parseAction,
  listActions,
  getAction,
  createAction,
  updateAction,
  deleteAction,
  type ActionInput,
} from './db/actions.js';
export {
  listFunctions,
  getFunction,
  getFunctionByName,
  createFunction,
  updateFunction,
  deleteFunction,
  type ParsedFunction,
  type FunctionInput,
} from './db/functions.js';
export {
  listMcpServers,
  getMcpServer,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  type McpServerInput,
} from './db/mcpServers.js';
export {
  getSettings,
  getSetting,
  getSettingNum,
  setSetting,
  deleteSetting,
  restoreDefaultSettings,
  getPrompt,
  setPrompt,
  listPrompts,
} from './db/settings.js';
export {
  listInstalledPackages,
  getInstalledPackage,
  listPackageItems,
  listAllPackageItems,
  installPackage,
  uninstallPackage,
  conflictItems,
  packageDiff,
  type InstalledPackageRow,
  type PackageItemRow,
  type PackageReport,
  type UninstallReport,
  type DiffItem,
  type DiffField,
} from './db/packages.js';
export {
  parseManifest,
  validateManifest,
  manifestDangerous,
  manifestItems,
  paramValues,
  requiredParams,
  manifestHash,
  type PackageManifest,
} from './core/packages.js';
export {
  addLog,
  listLogs,
  summarizeUsage,
  recentAgentTurns,
  type LogEntry,
} from './db/logs.js';
