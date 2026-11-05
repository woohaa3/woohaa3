/** Test composition: production hosts inject these same extension ports. */
import { applyCanvasCommands as reduce } from "../contracts/src/canvas/command-reducer.js";
import { ManagedNodeLifecycleRegistry } from "../contracts/src/canvas/managed-node-lifecycle.js";
import { planCanvasEdit as plan } from "../contracts/src/canvas/edit-plan.js";

const lifecycle = new ManagedNodeLifecycleRegistry();
export const testLifecycles = lifecycle;
export const testMigrations = [];

export function applyCanvasCommands(...[canvas, commands, options]: Parameters<typeof reduce>): ReturnType<typeof reduce> {
  return reduce(canvas, commands, { lifecycle, ...options });
}

export function planCanvasEdit(...[canvas, commands, options]: Parameters<typeof plan>): ReturnType<typeof plan> {
  return plan(canvas, commands, { lifecycle, ...options });
}
