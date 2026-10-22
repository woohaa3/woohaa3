/**
 * 游戏炼丹炉共享契约：无副作用小工具（对象/字符串/身份判定与 canonical JSON）
 * （change: 2026-10-10-add-game-furnace-extension，任务 1.1–1.5）。
 *
 * 纯叶子：不 import 宿主 store、Provider、数据库、DOM 或 Node API。
 */
import type { Woohaa3CanvasJsonObject } from "@woohaa3/contracts";

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length > max) return null;
  return value;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function isJsonObject(value: unknown): value is Woohaa3CanvasJsonObject {
  return isObject(value);
}

/** 确定性 canonical JSON（对象键排序），供 hash 使用。 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, (item as Record<string, unknown>)[key]]));
    }
    return item;
  });
}
