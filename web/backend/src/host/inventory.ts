/**
 * 宿主插件树的设置面元数据。
 *
 * 内置插件即使还没有可配置项也要登记进「插件配置」，才能看出宿主由哪些插件组成；显示名、一句话
 * 说明与卡片图标由这张表统一维护。元数据缺失时 `registerHostPlugins` 直接抛错，防止插件树与设置面漂移。
 */
import type { PluginIcon } from "@woohaa3/contracts";
import type { HostContext, HostPlugin } from "./context.js";

export type HostPluginInfo = { label: string; description: string; icon: PluginIcon };

/** 基础层插件（`host/base/index.ts` 的装载顺序）的显示信息。 */
export const BASE_LAYER_INFOS: Readonly<Record<string, HostPluginInfo>> = {
  diagnostics: { label: "诊断日志", description: "服务端接入与同步事件的有界内存缓冲，供调试窗口读取", icon: "logs" },
  log: { label: "日志", description: "结构化日志出口，Cordis 自己的日志也走这里", icon: "logs" },
  gateway: { label: "网关", description: "WebView 经 HTTP / WebSocket 进入本机宿主的唯一入口", icon: "network" },
  access: { label: "访问与身份", description: "部署身份：认证适配器、站点 action 与实例作用域", icon: "identity" },
  config: { label: "配置", description: "YAML 配置文件、密钥文件与设置面读写", icon: "config" },
  restart: { label: "受控重启", description: "管理员请求重启：排空在途工作后以退出码 75 退出，由拉起方重新启动", icon: "config" }
};

/** 核心层插件（`host/core/index.ts` 的装载顺序）的显示信息。 */
export const CORE_LAYER_INFOS: Readonly<Record<string, HostPluginInfo>> = {
  storage: { label: "存储扩展点", description: "存储后端注册表，media 与 task 按它读写字节", icon: "storage" },
  telemetry: { label: "本机遥测", description: "本机事件记录、聚合与异常复盘，数据不出本机", icon: "activity" },
  media: { label: "媒体", description: "内容寻址、导入校验与 /api/media", icon: "media" },
  generation: { label: "生成", description: "生成 Provider 注册表与站点级模型策略", icon: "generation" },
  marketplace: { label: "扩展市场", description: "市场来源注册表（只接受内置根扩展注册来源）", icon: "apps" },
  extensionManager: { label: "扩展安装", description: "受管扩展的安装、校验、回滚、卸载与观察期", icon: "apps" },
  adminApi: { label: "管理接口", description: "会话读模型与 Provider 凭据管理面", icon: "identity" },
  task: { label: "任务", description: "生成任务的目录、worker 与历史", icon: "task" },
  canvas: { label: "画布", description: "画布、Yjs 同步与画布侧 MCP 服务", icon: "canvas" },
  recordingExecutor: {
    label: "录制执行器",
    description: "本机片场录制的私有控制通道与执行器租约（桌面端才有实际执行器）",
    icon: "media"
  },
  mcp: { label: "MCP", description: "内置 MCP 服务与共享工具授权表", icon: "tools" },
  mcpInstallation: { label: "MCP 安装", description: "发现本机客户端并安装 MCP 配置", icon: "tools" },
  application: { label: "应用扩展", description: "站点插件宿主：控制面、站点配置与公开路由", icon: "apps" }
};

/**
 * 把一层内置插件按装载顺序登记进设置面清单。
 *
 * 没有设置服务（独立入口或测试）时静默跳过；缺元数据即抛错。
 */
export function registerHostPlugins(ctx: HostContext, layer: "base" | "core", plugins: readonly HostPlugin<never>[]): void {
  const config = ctx.get("config");
  if (!config) return;
  const infos = layer === "base" ? BASE_LAYER_INFOS : CORE_LAYER_INFOS;
  for (const plugin of plugins) {
    const info = infos[plugin.name];
    if (!info) throw new Error(`宿主 ${layer} 层插件缺少设置面元数据：${plugin.name}`);
    // 宿主层的插件随宿主同生共死，注销函数丢掉即可。
    config.registerPlugin({ id: plugin.name, label: info.label, description: info.description, layer, icon: info.icon });
  }
}
