/**
 * 扩展纯粹性门禁的**历史债清单**（`extension-purity.test.ts` 读取）。
 *
 * 原则：插件（`web/extensions/<id>/`、`extensions/<id>/`）不得要求改框架代码才能生效；
 * 反过来，框架也不得为某个插件开特例。加一个扩展应当只改扩展目录。
 *
 * 清单只记录**已经存在**的例外，每条必须写明原因与去向；门禁会校验条目没有腐化（文件仍在、
 * 记录的字面量仍在），因此清债时必须同步删除条目。新增条目是明确的架构决策，不是随手放过。
 */

/** 框架源码 import 扩展包（`@woohaa3/extension-*`）的例外。 */
export type ExtensionImportDebt = {
  /** 仓库相对路径。 */
  file: string;
  /** 该文件里出现的扩展包名（`@woohaa3/extension-*`）。 */
  packages: readonly string[];
  reason: string;
};

export const EXTENSION_IMPORT_DEBT: readonly ExtensionImportDebt[] = [
  {
    file: "web/backend/package.json",
    packages: ["@woohaa3/extension-oauth-agent", "@woohaa3/extension-standard-agent-roles", "@woohaa3/extension-sample-site"],
    reason: "宿主核心的站点插件（ChatGPT / 标准 Agent 角色）与测试 fixture 的 workspace 依赖；application-extension-runtime 规范允许后端入口来自静态可信清单。"
  },
  {
    file: "web/backend/src/composition.ts",
    packages: ["@woohaa3/extension-oauth-agent"],
    reason: "同上：ChatGPT 是宿主核心站点插件的类型/服务选项来源。"
  },
  {
    file: "web/backend/src/composition/instance-scope.ts",
    packages: ["@woohaa3/extension-oauth-agent"],
    reason: "同上：站点插件实例作用域按 ChatGPT 的服务形状收窄。"
  },
  {
    file: "web/backend/src/host/core/application.ts",
    packages: ["@woohaa3/extension-oauth-agent", "@woohaa3/extension-standard-agent-roles"],
    reason: "宿主核心站点插件的服务选项/角色绑定常量引用；扩展实现仍由目录宿主装载，不 import 扩展实现。"
  },
  {
    file: "web/services/application-service/package.json",
    packages: ["@woohaa3/extension-sample-site"],
    reason: "同上：application-service 的样例 fixture。私有业务扩展（如炉体）不在此列。"
  },
  {
    file: "web/frontend/src/cordis/test-support/source-extensions.ts",
    packages: ["@woohaa3/extension-task-activity"],
    reason: "测试支持：前端集成测试用源码扩展入口构造 fixture，不是生产装配路径。"
  },
  {
    file: "web/tooling/package.json",
    packages: ["@woohaa3/extension-sample-site"],
    reason: "测试 fixture：样例扩展只在门禁测试里使用。"
  }
];

/** 插件注册面出现扩展 id（或 Provider 配置段字面量）的例外。 */
export type RegistrationSurfaceDebt = {
  file: string;
  /** 该文件里出现的扩展 id 或 `providers.<id>` 配置段字面量。 */
  literals: readonly string[];
  reason: string;
};

export const PLUGIN_REGISTRATION_DEBT: readonly RegistrationSurfaceDebt[] = [
  {
    file: "scripts/lib/ingress.mjs",
    literals: ["oauth-agent", "sdk-agent", "local-agent", "remote-server"],
    reason: "宿主已有公开 API 路由前缀（OAuth/SDK/本机 Agent 来源）；Windows 路径归一化后同步现有清单，不新增业务装配。"
  }
];

/** 字段、身份、路由、工具名与 wire 字段的历史债。清单在 extension-purity-content-allowlist.ts。 */
export type ContentFieldDebt = {
  file: string;
  literals: readonly string[];
  stage: "node-data" | "command" | "route" | "interaction" | "render" | "identity";
  reason: string;
};

export { CONTENT_FIELD_DEBT } from "./extension-purity-content-allowlist.js";
