/** Offline CLI composition; runtime hosts inject this codec through extension ports. */
import { planMigration as plan, applyMigration, type MigrationOptions } from "../../web/services/canvas-service/src/storage/migrations/film-set-shooting-shots.js";
import { filmSetManagedMediaMigration } from "../../web/extensions/film-set/src/state/shared/managed-shot-media-migration.js";
export { applyMigration };
export function planMigration(db: unknown, options: MigrationOptions = {}) { return plan(db, { ...options, managedMigrations: [filmSetManagedMediaMigration] }); }
