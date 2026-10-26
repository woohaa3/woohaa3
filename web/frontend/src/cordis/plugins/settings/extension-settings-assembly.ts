/**
 * 设置专项扩展装配（change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.2 / design D5）。
 *
 * 画布内设置弹窗只为**未激活**的扩展按需装配设置贡献：
 * - 已激活扩展直接复用其贡献与业务服务（不重复装配）；
 * - 未激活扩展只调用可信发布 descriptor 的可选 `settingsPlugin()`，并以独立 fiber 挂到当前
 *   Canvas scope；关闭设置时释放该 fiber；
 * - 旧 artifact 没有设置专用入口时给出真实原因，**不回退执行完整 `plugin()`**；
 * - 加载按 extensionId 去重（重复打开不增长），并跟踪 dispose：迟到结果不再挂载。
 *
 * 只读取发布目录 identity（`loadDescriptor` 校验 artifact/metadata），不从 `/api/settings`、
 * query、localStorage 构造模块地址。
 */
import type { Context } from "@deepseek-ai/cordis";
import { scopedExtensionServices } from "../../slots.js";
import type { Fiber } from "@deepseek-ai/cordis";
import { fiberStatus } from "../../diagnostics.js";
import type { ExtensionRuntimeService } from "../../extension-runtime/service.js";
import type { ExtensionSettingsAssembly } from "./plugin.js";
import type { ApplicationExtensionStatusService } from "../../services/application-extension-status.js";

export type CanvasSettingsAssembly = {
  /** 交给设置插件的装配能力（方法在 `attach` 前返回明确原因）。 */
  assembly: ExtensionSettingsAssembly;
  /** scope install 阶段注入当前 Canvas Context（此后才可能真正加载）。 */
  attach(ctx: Context): void;
  /** 已挂载设置 fiber 数量（诊断/回归）。 */
  mountedIds(): string[];
};

/** 服务端权威状态里「正在运行」的站点扩展（降级运行也算已装载）。 */
function runningIds(status: ApplicationExtensionStatusService | undefined): Set<string> {
  const snapshot = status?.getSnapshot();
  return new Set(
    (snapshot?.plugins ?? [])
      .filter((plugin) => plugin.actualState === "active" || plugin.actualState === "degraded")
      .map((plugin) => plugin.extensionId)
  );
}

export function createCanvasSettingsAssembly(input: {
  /** App 级 extension runtime（发布目录/artifact loader）。 */
  runtime: ExtensionRuntimeService | undefined;
  /** 本次 Canvas 启动**静态装配**的扩展 id（always + 已启用 browser-local）。 */
  staticallyAssembled: ReadonlySet<string>;
}): CanvasSettingsAssembly {
  let ctx: Context | null = null;
  let disposed = false;
  const fibers = new Map<string, Fiber>();
  const pending = new Map<string, Promise<{ ok: true } | { ok: false; reason: string }>>();

  const activeIds = (): ReadonlySet<string> => {
    const status = ctx?.get("applicationExtensionStatus" as never) as ApplicationExtensionStatusService | undefined;
    return new Set([...input.staticallyAssembled, ...runningIds(status)]);
  };

  const load = async (extensionId: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (disposed) return { ok: false, reason: "设置已关闭" };
    const cached = pending.get(extensionId);
    if (cached) return cached;
    const scope = ctx;
    if (!scope) return { ok: false, reason: "画布还没有就绪" };
    if (fibers.has(extensionId)) return { ok: true };
    if (activeIds().has(extensionId)) return { ok: true };
    if (!input.runtime) return { ok: false, reason: "当前实例没有扩展发布目录" };

    const task = (async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
      try {
        const descriptor = await input.runtime!.loadDescriptor(extensionId);
        if (disposed) return { ok: false, reason: "设置已关闭" };
        if (typeof descriptor.settingsPlugin !== "function") {
          return { ok: false, reason: "该扩展版本未提供设置专用入口" };
        }
        const plugin = descriptor.settingsPlugin();
        // 设置专用贡献同样由宿主盖章来源身份（change: 2026-10-21-harden-extension-fault-isolation，design D1）。
        const scoped = scopedExtensionServices(scope, extensionId);
        const fiber = scope.extend({ slots: scoped.slots, dialogs: scoped.dialogs } as never).plugin(plugin) as Fiber;
        await fiber.await().catch(() => undefined);
        if (disposed) {
          await fiber.dispose();
          return { ok: false, reason: "设置已关闭" };
        }
        fibers.set(extensionId, fiber);
        // fiber 未激活：视为加载失败，清理半挂载状态。
        if (fiberStatus(fiber) !== "active") {
          fibers.delete(extensionId);
          await fiber.dispose();
          return { ok: false, reason: "设置面板加载失败" };
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: "设置面板加载失败" };
      } finally {
        pending.delete(extensionId);
      }
    })();
    pending.set(extensionId, task);
    return task;
  };

  return {
    assembly: {
      activeIds,
      load,
      dispose: () => {
        disposed = true;
        pending.clear();
        // 同步触发释放并清空索引：贡献由 fiber dispose 撤销，重开设置时重新装配。
        for (const fiber of fibers.values()) void fiber.dispose();
        fibers.clear();
      }
    },
    attach(next) {
      ctx = next;
    },
    mountedIds: () => [...fibers.keys()]
  };
}
