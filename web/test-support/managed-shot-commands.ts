/** Test composition: production hosts inject these same extension ports. */
import { applyCanvasCommands as reduce } from "../contracts/src/canvas/command-reducer.js";
import { ManagedNodeLifecycleRegistry } from "../contracts/src/canvas/managed-node-lifecycle.js";
import { filmSetManagedLifecycle } from "../extensions/film-set/src/state/shared/managed-shot-media-lifecycle.js";
import { planCanvasEdit as plan } from "../contracts/src/canvas/edit-plan.js";
import { filmSetManagedMediaMigration } from "../extensions/film-set/src/state/shared/managed-shot-media-migration.js";
const lifecycle = new ManagedNodeLifecycleRegistry();
lifecycle.register(filmSetManagedLifecycle);
export const filmSetTestLifecycles = lifecycle;
export const filmSetTestMigrations = [filmSetManagedMediaMigration];
export function applyCanvasCommands(...[canvas, commands, options]: Parameters<typeof reduce>): ReturnType<typeof reduce> {
  return reduce(canvas, commands, { lifecycle, ...options });
}
export function planCanvasEdit(...[canvas, commands, options]: Parameters<typeof plan>): ReturnType<typeof plan> {
  return plan(canvas, commands, { lifecycle, ...options });
}
