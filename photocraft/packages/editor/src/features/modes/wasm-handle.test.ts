import { expect, it } from "vitest";
import { failureFrom, type EditorInstance } from "../../editor-wasm.js";
import type { FeatureHandleContext } from "../contracts.js";
import { modeInfo, planMode, planColorTable } from "./wasm-handle.js";

/**
 * 运行时协商回归（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
 *
 * 加载到没有本域导出的旧内核时，直接调用会抛 `TypeError: … is not a function`，界面上只是一句
 * 英文开发者信息。适配层必须先判定导出是否存在，换成可读的 `runtime-unsupported` 拒绝。
 */

/** 复用共享的 `Editor::call` 语义（try/catch → failureFrom），只替换实例。 */
function context(instance: Record<string, unknown>): FeatureHandleContext {
  return {
    instance: instance as unknown as EditorInstance,
    call: (run) => {
      try {
        return { ok: true as const, value: run(instance as unknown as EditorInstance) };
      } catch (error) {
        return failureFrom(error);
      }
    }
  } as FeatureHandleContext;
}

it("rejects with a readable reason when the runtime predates this domain", () => {
  const result = modeInfo.call(context({}));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("runtime-unsupported");
  expect(result.message).toContain("modeInfo");
  expect(result.message).toContain("内核");
});

it("names every missing export, not just the first one", () => {
  const result = planMode.call(context({ modeInfo: () => "{}" }), "grayscale", {});
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("runtime-unsupported");
  expect(result.message).toContain("planMode");
  expect(result.message).toContain("applyMode");
  expect(result.message).toContain("applyColorTable");
});

it("still rejects invalid responses once the runtime is in place", () => {
  // 协商通过后不能变成「什么都说行」：非法响应仍要在这里失败。
  const handler = {
    modeInfo: () => "not json",
    planMode: () => "{}",
    applyMode: () => "{}",
    planColorTable: () => "{\"report\":{}}",
    applyColorTable: () => "{}"
  };
  const broken = modeInfo.call(context(handler));
  expect(broken.ok).toBe(false);
  if (!broken.ok) expect(broken.code).not.toBe("runtime-unsupported");

  const invalid = planColorTable.call(context(handler), {});
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.code).not.toBe("runtime-unsupported");
});
