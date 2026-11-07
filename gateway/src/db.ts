// Reiner Barrel-Export: kein DB-Seiteneffekt beim Import. Der Entrypoint
// (src/server.ts) initialisiert die DB explizit vor dem ersten Zugriff.
export { getDb, getSchemaVersion } from './db/schema.js';
export {
  listActions,
  getAction,
  createAction,
  updateAction,
  deleteAction,
} from './db/actions.js';
export {
  listFunctions,
  getFunctionByName,
  createFunction,
  updateFunction,
  deleteFunction,
} from './db/functions.js';
export {
  listMcpServers,
  getMcpServer,
  createMcpServer,
  maskMcpServerSecrets,
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
  existingParams,
  parseStoredManifest,
} from './db/packages.js';
export {
  parseManifest,
  validateManifest,
  manifestDangerous,
  manifestItems,
  paramValues,
  requiredParams,
  deriveCategory,
  type PackageManifest,
} from './core/packages.js';
export {
  addLog,
  listLogs,
  summarizeUsage,
  recentAgentTurns,
} from './db/logs.js';
