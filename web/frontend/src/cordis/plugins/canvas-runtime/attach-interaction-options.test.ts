import { describe, expect, it } from "vitest";
import type { AlignmentSnapPolicy } from "../../contract/alignment-snap.js";
import { buildAttachInteractionOptions, type AttachAssemblyDeps } from "./attach-interaction-options.js";

/** 只填被测字段，其余按需 cast：这里只验证 deps → controller options 的转发。 */
function build(extra: Partial<AttachAssemblyDeps>) {
  const deps = {
    canvas: {} as HTMLCanvasElement,
    options: { nodeCapabilities: {}, getSession: () => ({}), emit: () => undefined } as never,
    gestures: {},
    ...extra
  } as AttachAssemblyDeps;
  return buildAttachInteractionOptions(deps);
}

describe("buildAttachInteractionOptions", () => {
  it("forwards alignmentSnap so a controller mounted after the extension still sees the policy", () => {
    const policy: AlignmentSnapPolicy = { resolve: () => null };
    const alignmentSnap = () => policy;
    const options = build({ alignmentSnap });
    // 回归：曾经漏转发，扩展先于 controller 挂载注入的策略永远到不了 controller。
    expect(options.alignmentSnap).toBe(alignmentSnap);
    expect(options.alignmentSnap?.()).toBe(policy);
  });

  it("omits alignmentSnap when the host provides none", () => {
    expect("alignmentSnap" in build({})).toBe(false);
  });
});
