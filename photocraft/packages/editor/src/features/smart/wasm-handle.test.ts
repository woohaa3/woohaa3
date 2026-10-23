/**
 * 智能对象 WASM 适配边界：新增的三个入口必须显式释放 wasm-bindgen 资源，
 * 空结果与坏数据不能当成成功交给面板。
 */
import { describe, expect, it, vi } from "vitest";
import type { EditorInstance } from "../../editor-wasm.js";
import type { FeatureHandleContext } from "../contracts.js";
import { createHandle } from "./wasm-handle.js";

function context(instance: Partial<Record<keyof EditorInstance, unknown>>) {
  const calls: string[] = [];
  const ctx: FeatureHandleContext = {
    instance: instance as unknown as EditorInstance,
    call<T>(run: (i: EditorInstance) => T) {
      calls.push("call");
      try {
        return { ok: true, value: run(instance as unknown as EditorInstance) };
      } catch (error) {
        return { ok: false, code: "command-failed", message: error instanceof Error ? error.message : String(error) } as never;
      }
    }
  };
  return { ctx, calls };
}

describe("智能对象 WASM 适配", () => {
  it("层状态读取只做 JSON 解码", () => {
    const { ctx } = context({ smartLayerStateJson: (layer: number) => JSON.stringify({ layer, smart: false, reason: "请先选择智能对象图层" }) });
    expect(createHandle(() => ctx).smartLayerState(7)).toMatchObject({ ok: true, value: { layer: 7, smart: false } });
  });

  it("导出源读出名称与字节并释放资源，即使读取失败也释放", () => {
    const free = vi.fn();
    const exported = { name: "contents.pcraft", bytes: new Uint8Array([1, 2, 3]), free };
    const { ctx } = context({ exportSmartSource: () => exported });
    expect(createHandle(() => ctx).exportSmartSource(4)).toMatchObject({ ok: true, value: { name: "contents.pcraft" } });
    expect(free).toHaveBeenCalledTimes(1);

    const failing = vi.fn();
    const { ctx: empty } = context({
      exportSmartSource: () => ({ name: "contents.pcraft", bytes: new Uint8Array(), free: failing })
    });
    expect(createHandle(() => empty).exportSmartSource(4)).toMatchObject({ ok: false });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("转回图层返回结构化结果；内核异常归一化成失败", () => {
    const { ctx } = context({ convertSmartToLayers: () => JSON.stringify({ layer: 9, group: true, layers: 3 }) });
    expect(createHandle(() => ctx).convertSmartToLayers(4)).toEqual({ ok: true, value: { layer: 9, group: true, layers: 3 } });
    const { ctx: broken } = context({ convertSmartToLayers: () => { throw new Error("变形后的智能对象无法转回图层"); } });
    expect(createHandle(() => broken).convertSmartToLayers(4)).toMatchObject({ ok: false, message: "变形后的智能对象无法转回图层" });
  });
});
