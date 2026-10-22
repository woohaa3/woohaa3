import { describe, expect, it, vi } from "vitest";
import { SlotRegistry } from "../slots.js";
import { CanvasNavigationStore } from "../navigation/store.js";
import { resolveFocusWorkspace, watchFocusWorkspace } from "./host.js";

/**
 * 公共 focus 宿主 owner 解析/watch 生命周期
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D3/D4/D5）。
 *
 * 迁移自旧 `cordis/focus-workspace.test.ts`：baseline watcher 只观察 `extension` 聚焦，
 * 通用化后必须覆盖三类 editor，且**不得**把图片/视频会话异步建立期间的瞬时不可用
 * 误判为「owner 丢失」而把刚进入的聚焦弹回 overview。
 */
describe("focus workspace owner resolution and watcher", () => {
  function harness(kind: "image" | "video" | "model" | "extension" = "extension") {
    const slots = new SlotRegistry();
    const navigation = new CanvasNavigationStore();
    let invalidVersion = false;
    let canvasChanged = () => {};
    let focused = false;
    const apply = vi.fn((target: unknown) => {
      focused = !!target;
      return { ok: true as const };
    });
    const props = (nodeId?: string) => {
      const mode = navigation.getSnapshot().mode;
      return {
        revision: 0,
        writable: false,
        focus: nodeId
          ? { nodeId, kind }
          : mode.type === "node-focus"
            ? { nodeId: mode.nodeId, kind: mode.kind }
            : null
      };
    };
    const register = (id = "workspace") =>
      slots.register("canvas.focus-workspace", {
        id,
        owner: "test",
        kind,
        matchesFocus: (p) => p.focus?.nodeId === "owned" || p.focus?.nodeId.startsWith("async"),
        validate: () => (invalidVersion ? "版本不受支持" : null),
        render: () => null
      });
    navigation.setFocusAdapter({
      apply,
      isFocused: () => focused,
      isTargetValid: (nodeId) => resolveFocusWorkspace(slots, props(nodeId)).ok,
      targetUnavailableReason: (nodeId) => {
        const r = resolveFocusWorkspace(slots, props(nodeId));
        return r.ok ? null : r.reason;
      }
    });
    const dispose = watchFocusWorkspace({
      slots,
      navigation,
      props,
      subscribeCanvas: (listener) => {
        canvasChanged = listener;
        return () => {
          canvasChanged = () => {};
        };
      }
    });
    return {
      slots,
      navigation,
      apply,
      register,
      dispose,
      props,
      invalidateVersion: () => {
        invalidVersion = true;
        canvasChanged();
      }
    };
  }

  it("unknown/disabled/invalid targets reject before layout effects and notify diagnostics", () => {
    const h = harness();
    const notify = vi.fn();
    h.navigation.subscribe(notify);
    expect(h.navigation.enterNodeFocus({ nodeId: "owned", kind: "extension" }).ok).toBe(false);
    expect(h.navigation.getSnapshot().mode.type).toBe("overview");
    expect(h.apply).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
    const unregister = h.register();
    expect(h.navigation.enterNodeFocus({ nodeId: "unknown", kind: "extension" }).ok).toBe(false);
    h.invalidateVersion();
    expect(h.navigation.enterNodeFocus({ nodeId: "owned", kind: "extension" }).ok).toBe(false);
    expect(h.navigation.getDiagnostic()).toBe("版本不受支持");
    unregister();
    h.dispose();
  });

  it("removing owner releases layout and returns overview; re-enable requires explicit entry", () => {
    const h = harness();
    const unregister = h.register();
    expect(h.navigation.enterNodeFocus({ nodeId: "owned", kind: "extension" }).ok).toBe(true);
    unregister();
    unregister();
    expect(h.navigation.getSnapshot().mode.type).toBe("overview");
    expect(h.apply.mock.calls.at(-1)?.[0]).toBeNull();
    h.register();
    expect(h.navigation.getSnapshot().mode.type).toBe("overview");
    expect(h.navigation.enterNodeFocus({ nodeId: "owned", kind: "extension" }).ok).toBe(true);
    h.dispose();
  });

  it("content version changes or ambiguous owners invalidate active workspace", () => {
    const h = harness();
    h.register();
    h.navigation.enterNodeFocus({ nodeId: "owned", kind: "extension" });
    h.register("conflicting-owner");
    expect(h.navigation.getSnapshot().mode.type).toBe("overview");
    expect(h.navigation.getDiagnostic()).toContain("多个扩展");
    h.dispose();
    const next = harness();
    next.register();
    next.navigation.enterNodeFocus({ nodeId: "owned", kind: "extension" });
    next.invalidateVersion();
    expect(next.navigation.getSnapshot().mode.type).toBe("overview");
    expect(next.navigation.getDiagnostic()).toBe("版本不受支持");
    next.dispose();
  });

  it("throwing owner validation is a visible rejection, never an exception", () => {
    const slots = new SlotRegistry();
    slots.register("canvas.focus-workspace", {
      id: "broken",
      owner: "test",
      kind: "extension",
      matchesFocus: () => {
        throw Error("broken");
      },
      render: () => null
    });
    expect(
      resolveFocusWorkspace(slots, { revision: 0, writable: true, focus: { nodeId: "n", kind: "extension" } })
    ).toMatchObject({ ok: false, reason: expect.stringContaining("校验失败") });
  });

  it.each(["image", "video"] as const)(
    "%s: 会话在导航发布后才异步可用时不得把刚进入的聚焦弹回 overview",
    (kind) => {
      const slots = new SlotRegistry();
      const navigation = new CanvasNavigationStore();
      let focused = false;
      let available = false;
      navigation.setFocusAdapter({
        apply: (target) => {
          focused = !!target;
          return { ok: true };
        },
        isFocused: () => focused,
        isTargetValid: () => true
      });
      // editor 的贡献以**异步建立的会话**为可用性门禁（与真实图片/视频 editor 一致）。
      slots.register("canvas.focus-workspace", {
        id: `${kind}-editor-workspace`,
        owner: `${kind}-editor`,
        kind,
        available: () => available,
        render: () => null
      });
      const props = () => {
        const mode = navigation.getSnapshot().mode;
        return {
          revision: 0,
          writable: false,
          focus: mode.type === "node-focus" ? { nodeId: mode.nodeId, kind: mode.kind } : null
        };
      };
      const dispose = watchFocusWorkspace({
        slots,
        navigation,
        props,
        subscribeCanvas: () => () => undefined
      });

      expect(navigation.enterNodeFocus({ nodeId: "n1", kind }).ok).toBe(true);
      // watcher 已先于 editor 的导航监听运行，此时会话仍不可用；不得抢先失效。
      expect(navigation.getSnapshot().mode).toMatchObject({ type: "node-focus", nodeId: "n1", kind });
      // 会话异步就绪后，聚焦仍保留（宿主据 available 重新解析唯一 owner）。
      available = true;
      expect(navigation.getSnapshot().mode).toMatchObject({ type: "node-focus", nodeId: "n1", kind });
      dispose();
    }
  );

  it("owner 注销后同一目标释放（三类通用，不只 extension）", () => {
    const h = harness("image");
    const unregister = h.register("image-editor-workspace");
    expect(h.navigation.enterNodeFocus({ nodeId: "owned", kind: "image" }).ok).toBe(true);
    unregister();
    expect(h.navigation.getSnapshot().mode.type).toBe("overview");
    h.dispose();
  });
});
