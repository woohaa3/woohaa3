/**
 * 首次安装的受管后端扩展运行期装配（change: 2026-10-21-isolate-extension-host-process，任务 8.4）。
 *
 * 不重启宿主：代理插件本来就是普通扩展层插件，装载器的 `loadExtension` 逐插件进行，运行期追加与启动期
 * 走同一条路径（配置段登记、站点门禁、P0 时限、serial 队列）。
 */
import type { AnyHostExtensionPlugin } from "@woohaa3/contracts";
import type { HostContext } from "../../context.js";
import type { ExtensionPackageToolkit } from "./types.js";

/**
 * 首次安装的受管后端扩展在运行期装配（change: 2026-10-21-isolate-extension-host-process，任务 8.4）：
 * 描述（只读 JSON）→ 隔离服务 add（控制器 + 代理插件 + gateway 转发）→ 有站点元数据时 siteGate.add →
 * 扩展层追加代理插件（loader 据门禁 attach）→ 控制面 addExtension 协调激活。没有站点元数据的插件由
 * 装载器直接启动（等 `started`）。任何一步失败都按相反顺序撤销，抛错交给 Manager（按热登记失败撤销记录）。
 *
 * 卸载（detach）：控制面 removeExtension → siteGate.remove → 扩展层卸载 → 隔离服务 remove。每步幂等、失败只记日志。
 * 能力缺失（隔离关闭 / 测试最小装配）时返回 null，Manager 退回 restart-required。
 */
export function createRuntimeAttach(ctx: HostContext, toolkit: ExtensionPackageToolkit, log: (event: Record<string, unknown>) => void) {
  const isolation = () => ctx.get("extensionHostIsolation") as (ReturnType<HostContext["get"]> & { add?: (descriptor: never) => { plugin: AnyHostExtensionPlugin } }) | undefined;
  if (!toolkit.describeIsolatedExtension) return null;
  const describe = toolkit.describeIsolatedExtension;
  const supported = () => {
    const service = isolation() as { enabled?: () => boolean; add?: unknown } | undefined;
    return Boolean(service?.enabled?.() && typeof service.add === "function" && ctx.get("extensionLayer"));
  };
  const plane = () => ctx.get("application")?.service.plugins();
  const gate = () => ctx.get("application")?.siteGate;
  /** 本进程运行期装配的扩展：只有它们在卸载时整体撤下（启动期装配的保留占位到下次启动）。 */
  const attached = new Set<string>();
  const attach = async (extensionId: string, directory: string, version: string): Promise<{ state: string }> => {
    if (!supported()) throw Object.assign(new Error("宿主不支持运行期装配受管后端扩展"), { code: "extension-host-unsupported" });
    const service = isolation() as unknown as { add(descriptor: unknown): { plugin: AnyHostExtensionPlugin }; remove(id: string): Promise<void> };
    const layer = ctx.get("extensionLayer")!;
    const { descriptor, metadata } = describe({ dir: directory, extensionId, version });
    const undo: Array<() => Promise<void> | void> = [];
    const rollback = async () => {
      for (const step of undo.reverse()) {
        try {
          await step();
        } catch (error) {
          log({ event: "extension-attach-undo-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    try {
      const { plugin } = service.add(descriptor);
      undo.push(() => service.remove(extensionId));
      const controlPlane = plane();
      const siteGate = gate();
      const siteManaged = Boolean(metadata && controlPlane && siteGate);
      let definition = null as ReturnType<NonNullable<typeof siteGate>["add"]> | null;
      if (siteManaged) {
        definition = siteGate!.add(extensionId);
        undo.push(() => siteGate!.remove(extensionId));
      }
      const loaded = layer.add(plugin);
      undo.push(() => layer.remove(extensionId));
      if (!loaded) throw Object.assign(new Error(`扩展 ${extensionId} 的配置段无效`), { code: "extension-config-invalid" });
      if (!siteManaged) {
        await loaded.started;
        attached.add(extensionId);
        return { state: "active" };
      }
      const outcome = await controlPlane!.addExtension({ metadata: metadata as never, definition: definition! });
      if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code });
      undo.push(async () => {
        await controlPlane!.removeExtension(extensionId);
      });
      const state = outcome.status?.actualState ?? "unknown";
      if (state === "failed") {
        const diagnostic = outcome.status?.diagnostics?.[0];
        throw Object.assign(new Error(diagnostic?.message ?? "激活失败"), { code: diagnostic?.code ?? "activation-failed" });
      }
      attached.add(extensionId);
      return { state };
    } catch (error) {
      await rollback();
      throw error;
    }
  };
  const detach = async (extensionId: string): Promise<void> => {
    if (!attached.has(extensionId)) {
      // 启动期装配的扩展：只停子进程，代理插件与站点登记保留到下次启动（重启后扫描不再有它）。
      await ctx.get("extensionHostIsolation")?.remove(extensionId);
      return;
    }
    attached.delete(extensionId);
    const steps: Array<[string, () => Promise<unknown> | unknown]> = [
      ["control-plane", async () => {
        const outcome = await plane()?.removeExtension(extensionId);
        // 启动期装配的扩展不可移除（占位保留到下次启动）：不是错误。
        if (outcome && !outcome.ok && outcome.code !== "extension-not-found" && outcome.code !== "extension-not-removable") throw Object.assign(new Error(outcome.message), { code: outcome.code });
      }],
      ["site-gate", () => gate()?.remove(extensionId)],
      ["extension-layer", () => ctx.get("extensionLayer")?.remove(extensionId)],
      ["extension-host", () => ctx.get("extensionHostIsolation")?.remove(extensionId)]
    ];
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        log({ event: "extension-detach-step-failed", extensionId, step, message: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  return { attach, detach, supported };
}
