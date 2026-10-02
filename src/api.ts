// The one surface the UI package (ui/server/core.ts) imports from the core: re-exports only, so the
// UI never reaches into src/ internals. Hook processes never load this module (src/cli/main.ts).
export { openDb, type Db } from './storage/db.js';
export { dbPath, dataDir, hooksLogPath, loadConfig, type EngramConfig } from './config.js';
export { VERSION } from './version.js';
export { getStats, type Stats } from './storage/stats.js';
export { selectProfile } from './claims/profile.js';
export { searchClaimsRanked, type ClaimHit } from './search/claims.js';
export { searchEventsRanked, type EventHit } from './search/events.js';
export { explain, type Explanation } from './claims/explain.js';
export type { ClaimRow } from './claims/claims.js';
export type { EventRow } from './events/events.js';
export { forget, survivalNote, claimSourceEventsNote, type ForgetPlan, type ForgetResult } from './control/forget.js';
export { pin, unpin, type PinResult } from './control/marks.js';
export { isPaused, setPaused } from './control/pause.js';
export { writeExport } from './control/export.js';
export { stripControlChars } from './core/text.js';
export { nowIso } from './core/ids.js';
export * from './control/list.js';
export { doctorReport, doctorReportAsync, type DoctorReport, type DoctorHook } from './cli/commands/install.js';
