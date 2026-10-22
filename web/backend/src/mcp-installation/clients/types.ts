/** 客户端安装规格的声明式类型；新增客户端只加一条规格，不改读写流程。 */
import type { McpInstallClientGroup, McpInstallClientId } from "@woohaa3/contracts";

export type McpConfigFormat = "json" | "jsonc" | "toml" | "yaml";

/**
 * 检测证据是「或」关系，任一命中即视为已发现。
 * - executable：PATH 中的可执行文件名（Windows 自动补 .exe/.cmd）。
 * - file：额外的已知用户级配置文件（例如旧版归档路径、客户端自带的配置链）。
 * - app：桌面应用安装包名，仅 macOS 有意义。
 * - targets：任一已声明安装目标文件存在（覆盖常规用户级配置）。
 */
export type DetectEvidence =
  | { kind: "executable"; names: readonly string[] }
  | { kind: "file"; paths: (ctx: SpecContext) => readonly string[] | Promise<readonly string[]> }
  | { kind: "app"; names: readonly string[] }
  | { kind: "targets" };

/** 一个可写安装目标；同一客户端可有多个（例如按 profile 展开）。 */
export type InstallTarget = {
  /** 注册表内稳定 key；单目标客户端固定为 "default"。 */
  key: string;
  label: string;
  /** 宿主自己算出的绝对路径，浏览器不可提交。 */
  path: string;
  format: McpConfigFormat;
  /** 插件类客户端：缺失该插件时拒绝写入。 */
  requiresPlugin?: string;
};

/**
 * 远程条目如何落到具体格式里：容器键路径 + 远程条目的字段与取值。
 * 数组容器（Continue）按 `name` 字段定位条目。
 */
export type RemoteEntryShape = {
  container: readonly string[];
  /** 容器是数组，条目自带 name 字段。 */
  array?: boolean;
  /** 保存公开地址的字段名（不同客户端不统一）。 */
  urlField: string;
  /** 新建或更新远程条目时写入的字段，url 由调用方注入。 */
  fields: (url: string) => Record<string, unknown>;
  /** 远程条目的标记字段与合法取值；用于识别同名非远程冲突。 */
  remoteMarker?: { field: string; values: readonly string[] };
  /** 存在该字段且为 false 时不视为已安装（OpenCode 的 enabled）。 */
  enabledField?: string;
};

export type McpClientWriter =
  | { kind: "file" }
  | {
      kind: "command";
      /** PATH 中的可执行文件名；固定参数由 args 生成，不经 shell。 */
      names: readonly string[];
      args: (url: string) => string[];
      /** 命令需要的额外环境变量（如 CODEX_HOME）。 */
      env?: (target: InstallTarget, env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    }
  | { kind: "plugin-patch"; plugin: string };

export type SpecContext = {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** macOS 应用安装目录；测试可指向临时目录。 */
  applicationsDir: string;
  exists(file: string): Promise<boolean>;
};

export type McpClientSpec = {
  id: McpInstallClientId;
  label: string;
  group: McpInstallClientGroup;
  detect: readonly DetectEvidence[];
  targets(ctx: SpecContext): Promise<InstallTarget[]>;
  entry: RemoteEntryShape;
  writer: McpClientWriter;
};

export const SERVER_NAME = "woohaa3-model-canvas";
