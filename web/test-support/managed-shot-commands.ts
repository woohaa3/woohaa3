/** Test composition: production hosts inject these same extension ports. */
import { applyCanvasCommands as reduce } from "../contracts/src/canvas/command-reducer.js";
import { ManagedNodeLifecycleRegistry } from "../contracts/src/canvas/managed-node-lifecycle.js";
import { ContentContributionRegistry } from "../contracts/src/canvas/content-contribution.js";
import { filmSetContentContribution } from "../contracts/src/canvas/film-set-content.js";
import { filmSetManagedLifecycle } from "../extensions/film-set/src/state/shared/managed-shot-media-lifecycle.js";
import { planCanvasEdit as plan } from "../contracts/src/canvas/edit-plan.js";
import { filmSetManagedMediaMigration } from "../extensions/film-set/src/state/shared/managed-shot-media-migration.js";
const lifecycle = new ManagedNodeLifecycleRegistry();
lifecycle.register(filmSetManagedLifecycle);
export const filmSetTestLifecycles = lifecycle;
export const filmSetTestMigrations = [filmSetManagedMediaMigration];
/** 与浏览器 page scope / 服务端 composition 相同的 owner 注册方式；不是模块级全局单例。 */
export function filmSetTestContent(): ContentContributionRegistry {
  const content = new ContentContributionRegistry();
  content.register(filmSetContentContribution);
  return content;
}
const content = filmSetTestContent();
export function applyCanvasCommands(...[canvas, commands, options]: Parameters<typeof reduce>): ReturnType<typeof reduce> {
  return reduce(canvas, commands, { lifecycle, content, ...options });
}
export function planCanvasEdit(...[canvas, commands, options]: Parameters<typeof plan>): ReturnType<typeof plan> {
  return plan(canvas, commands, { lifecycle, content, ...options });
}
/** 回放 `planCanvasEdit` 的 forward/inverse（含 owner `extension.edit` 段）。 */
export function applyPlannedEdit(
  canvas: import("../contracts/src/canvas/domain/index.js").ServerCanvas,
  planned: {
    preconditions: readonly unknown[];
    operations: readonly unknown[];
    extensions?: readonly { extensionId: string; direction: "forward" | "inverse"; edit: unknown; preconditions: readonly unknown[] }[];
  }
): ReturnType<typeof reduce> {
  const commands = [
    ...(planned.operations.length > 0 ? [{ type: "edit.apply" as const, preconditions: planned.preconditions, operations: planned.operations }] : []),
    ...(planned.extensions ?? []).map((entry) => ({ type: "extension.edit" as const, extensionId: entry.extensionId, direction: entry.direction, edit: entry.edit, preconditions: entry.preconditions }))
  ];
  return applyCanvasCommands(canvas, commands as never);
}
