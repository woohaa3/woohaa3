/**
 * `HOST_SERVICE_ABI` 一致性（change: 2026-11-13-add-extension-capability-abi，任务 1.4）。
 *
 * 这张表是插件在 `extension.json` 的 `engines.host` 里声明依赖时的**唯一版本来源**，
 * 所以它必须与「插件实际能从 `ctx` 上拿到什么」严格对齐：
 *
 * - 少登记一个面 → 插件无从声明对它的依赖，该面的破坏性变更静默放行；
 * - 版本不跟着破坏性变更走 → 声明了旧版本的插件被判兼容，问题拖到运行期才暴露
 *   （2026-11-16 `remote-server` 的 `capabilities.register` 签名变更即此形态：
 *   ABI 仍是 1、扩展也声明 1，装载期校验放行，注册时抛错让整个扩展激活回滚，
 *   连带 `server` 存储后端缺席，远端画布的媒体被一致报成 404）。
 *
 * 键集合**从类型推导**，不手抄：手抄清单在 `ctx` 新增服务面时不会失败，恰好漏掉本测试
 * 要防的那一类漂移。推导方式是 `keyof HostExtensionContext` 减去 `keyof Context`
 * （Cordis 框架成员）与纯数据字段。
 *
 * 版本号本身是人工推进的整数，没有可机械校验的真值，只能靠注释与 review 把关。
 */
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { HOST_SERVICE_ABI, hostServiceAbi, hostServiceNames } from "./abi.js";
import type { HostExtensionContext } from "./context.js";

/** 纯数据字段：也在扩展上下文上，但不是「服务面」，不该在 ABI 表里占位。 */
type ContextDataKey = "basePath" | "deployment";

/**
 * 扩展上下文里属于**宿主服务面**的键：扣掉 Cordis 框架成员与纯数据字段。
 *
 * `ctx` 新增一个服务面而 ABI 忘了登记时，下面第二个用例会编译失败。
 */
type ContextServiceKey = Exclude<keyof HostExtensionContext, keyof Context | ContextDataKey>;

/**
 * `HOST_SERVICE_ABI` 覆盖了、但**不在** `HostExtensionContext` 上的名字。
 *
 * `executors` 登记在 `ExtensionPlugin`（插件声明自己提供哪些执行模块），不是插件从 `ctx`
 * 读取的服务面——`HostExtensionContext` 上没有这个键，也没有任何扩展声明或读取它。它留在
 * 表里不影响现有扩展（`engines.host` 只在声明时校验），但属于登记口径不一致：等服务面
 * 真的落到 `ctx` 上再决定是否保留，届时从这里删掉即可。
 */
type NotOnContext = "executors";

describe("HOST_SERVICE_ABI 与 HostExtensionContext 一致", () => {
  it("表里每个名字都能在上下文上找到（或显式登记为不在上下文上）", () => {
    // 编译期：表里的键（去掉豁免项）必须都是上下文真实存在的键。
    type DeclaredOnContext = Exclude<keyof typeof HOST_SERVICE_ABI, NotOnContext>;
    const _declaredExists: DeclaredOnContext extends ContextServiceKey ? true : never = true;
    void _declaredExists;

    for (const name of hostServiceNames()) {
      if (name === "executors") continue;
      expect(hostServiceAbi(name), `${name} 没有登记版本`).toBeGreaterThan(0);
    }
  });

  it("上下文上的每个服务面都在表里登记了版本（新增面不能忘记登记）", () => {
    // 编译期主检查：上下文的服务面必须全被 ABI 覆盖。
    // `ctx` 新增服务面却忘了登记 ABI 时这里是 never，编译失败。
    // 报错读法：`ctx` 上有、ABI 里没有的名字 =
    //   Exclude<ContextServiceKey, keyof typeof HOST_SERVICE_ABI>
    // 把它补进 `abi.ts`（新增面首版记 1）即可。
    const missing = undefined as unknown as Exclude<ContextServiceKey, keyof typeof HOST_SERVICE_ABI>;
    const _noMissing: never = missing;
    void _noMissing;

    for (const name of ["basePath", "deployment"] as const) {
      expect(hostServiceAbi(name), `${name} 是数据字段，不该在 ABI 表里占位`).toBeUndefined();
    }
  });

  it("所有版本都是正整数（engines.host 的校验口径与之一致）", () => {
    for (const [name, version] of Object.entries(HOST_SERVICE_ABI)) {
      expect(Number.isInteger(version), `${name} 的版本必须是整数`).toBe(true);
      expect(version, `${name} 的版本必须 ≥ 1`).toBeGreaterThanOrEqual(1);
    }
  });

  it("未知服务面返回 undefined（而不是抛错或返回假版本）", () => {
    expect(hostServiceAbi("nope")).toBeUndefined();
    expect(hostServiceAbi("__proto__")).toBeUndefined();
  });

  it("capabilities 面在 2：register 已从位置参数改为单个注册对象", () => {
    // 回归护栏。`capabilities.register` 曾经是 `(id, value)` 两个位置参数，
    // 改成 `{ id, version, value }` 是破坏性变更，必须同时抬到这里，否则声明旧版本的插件
    // 会被装载期校验放行、在运行期注册时抛错并让整个扩展激活回滚。
    expect(HOST_SERVICE_ABI.capabilities).toBe(2);
  });
});
