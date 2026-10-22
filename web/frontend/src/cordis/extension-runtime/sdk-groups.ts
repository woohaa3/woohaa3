/**
 * Extension SDK 分组 adapter 的公共形状
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 2.2/2.3 / design D2）。
 *
 * 每个分组模块只导出**静态具名 adapter**：一个 `namedExports` 对象，键为公共导出名，值为宿主
 * 实际实现引用（来自 `extension-api` / `shared/ui` 等叶子模块）。禁止 namespace 展开，避免把
 * 未用能力保留进产物。运行时 provider 用动态 import 按组加载，只把被要求的组载入。
 */
import type { ExtensionSdkGroup } from "@woohaa3/contracts";

export type ExtensionSdkGroupModule = {
  group: ExtensionSdkGroup;
  namedExports: Readonly<Record<string, unknown>>;
};
