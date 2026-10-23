/**
 * 文字域内核适配回归（change: 2026-10-22-add-photocraft-typography-workflows）。
 *
 * 两个要点：
 * 1. `typeCommand`/`typeQuery` 是运行时协商的一部分——能力握手看不到入口存在性，所以旧内核可能
 *    没有这两个方法；此时必须回报明确原因，而不是抛 `TypeError` 或假装成功。
 * 2. 有入口时参数按 JSON 转发，返回值原样解出，错误经同一 `call` 边界转成失败结果。
 */
import { expect, it, vi } from "vitest";
import { createHandle } from "./wasm-handle.js";
import type { FeatureHandleContext } from "../contracts.js";
import type { EditorInstance } from "../../editor-wasm.js";

function context(instance: Partial<EditorInstance>) {
  const target = instance as EditorInstance;
  const ctx: FeatureHandleContext = {
    instance: target,
    call: <T,>(run: (value: EditorInstance) => T) => {
      try {
        return { ok: true, value: run(target) };
      } catch (error) {
        return { ok: false, code: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    }
  };
  return createHandle(() => ctx);
}

it("旧内核缺少文字域入口时给出明确失败，不抛 TypeError", () => {
  const handle = context({});
  const command = handle.typeCommand("type.info", { layer: 1 });
  expect(command.ok).toBe(false);
  expect(command.ok ? "" : command.message).toContain("未提供文字域命令入口");
  const query = handle.typeQuery("type.info", { layer: 1 });
  expect(query.ok).toBe(false);
  expect(query.ok ? "" : query.message).toContain("未提供文字域查询入口");
});

it("有入口时按 JSON 转发参数并解出结果", () => {
  const typeCommand = vi.fn((id: string, params: string) => JSON.stringify({ id, params: JSON.parse(params) }));
  const typeQuery = vi.fn((id: string) => JSON.stringify({ id, runs: [] }));
  const handle = context({ typeCommand, typeQuery } as unknown as Partial<EditorInstance>);
  expect(handle.typeCommand("type.warpText", { style: "arc" })).toEqual({ ok: true, value: { id: "type.warpText", params: { style: "arc" } } });
  expect(handle.typeQuery("type.info", undefined)).toEqual({ ok: true, value: { id: "type.info", runs: [] } });
  expect(typeCommand).toHaveBeenCalledWith("type.warpText", JSON.stringify({ style: "arc" }));
  // 缺省参数转成 JSON null，避免 wasm-bindgen 拿到 undefined。
  expect(typeQuery).toHaveBeenCalledWith("type.info", "null");
});

it("内核抛出的拒绝保持失败形态与原因", () => {
  const handle = context({
    typeCommand: () => {
      throw new Error("命令 type.warpText 被拒绝：未知样式");
    }
  } as unknown as Partial<EditorInstance>);
  const result = handle.typeCommand("type.warpText", { style: "spiral" });
  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.message).toContain("未知样式");
});
