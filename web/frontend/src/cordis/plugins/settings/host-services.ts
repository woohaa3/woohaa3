/**
 * 「核心服务」分区的服务页签投影（纯函数，无 React/DOM）。
 *
 * 宿主自己的配置项按配置键的第一段归到所属核心服务（canvas.* → 画布与同步、
 * storage.* → 存储、telemetry.* → 遥测……）。页签只来自「这个服务当前有配置项」：
 * 没有配置的服务不出现，空页签对用户没有信息量，也会把迁移清单伪装成功能。
 *
 * 未登记的前缀不能丢：用前缀当显示名、排在已登记服务之后。这样宿主或插件先于设置面升级时，
 * 新配置项仍然可见，只是暂时没有更好的名字。
 */
import type { SettingsEntryView } from "@woohaa3/contracts";

export type HostServiceDefinition = {
  id: string;
  /** 页签与说明里的服务名。 */
  label: string;
  /** 一句话职责；只描述这个服务管什么，不重复配置项的说明。 */
  description: string;
  /**
   * 可选指引：这组配置之外的参数在哪里。
   * 集中在元数据里维护，插件接管后删一行即可，不会散落在组件里。
   */
  pointer?: string;
};

/** 已登记的核心服务；顺序就是页签顺序（有配置的服务按这个顺序出现）。 */
export const HOST_SERVICES: readonly HostServiceDefinition[] = [
  {
    id: "canvas",
    label: "画布与同步",
    description: "画布、Yjs 同步与上游接入；权威在本机，远端同步只由「服务端接入」插件提供。"
  },
  {
    id: "storage",
    label: "存储",
    description: "媒体与任务读写字节都经存储扩展点；这里选宿主用哪个后端，每个选择旁边可以直达该后端的配置。"
  },
  {
    id: "exposer",
    label: "临时图床",
    description: "把存储里的对象变成临时外链的提供者。"
  },
  {
    id: "task",
    label: "任务",
    description: "任务目录、worker、租约与历史；调度归属任务服务。"
  },
  {
    id: "media",
    label: "媒体",
    description: "内容寻址、导入校验与签名地址；字节读写走存储扩展点。"
  },
  {
    id: "generation",
    label: "生成",
    description: "生成 Provider 注册表与站点级模型策略；Provider 本身是插件。"
  },
  {
    id: "telemetry",
    label: "遥测",
    description: "本机事件记录、聚合与复盘；数据不出本机，外部上报由出口插件承担。"
  },
  {
    id: "mcp",
    label: "MCP",
    description: "内置 MCP 服务与共享工具授权表。"
  },
  {
    id: "application",
    label: "应用",
    description: "站点插件宿主：控制面、站点配置与公开路由。"
  }
];

export type HostServiceGroup = {
  service: HostServiceDefinition;
  entries: SettingsEntryView[];
};

/** 配置键的领域前缀；没有分隔符时整键就是前缀。 */
export function serviceIdOfKey(key: string): string {
  const index = key.indexOf(".");
  return index > 0 ? key.slice(0, index) : key;
}

/**
 * 把宿主自己的配置项投影成服务分组。
 *
 * 默认只返回有配置项的服务；`includeServiceIds` 用于「有插件向该服务注册能力、但服务自身没有
 * YAML 配置」的情况（当前是 Generation：Provider 插件影响它，页签仍应出现）。
 * 顺序先按 HOST_SERVICES，未登记前缀按首次出现顺序排在后面。
 */
export function hostServiceGroups(
  entries: readonly SettingsEntryView[],
  options: { includeServiceIds?: readonly string[] } = {}
): HostServiceGroup[] {
  const byService = new Map<string, SettingsEntryView[]>();
  for (const entry of entries) {
    const id = serviceIdOfKey(entry.key);
    const list = byService.get(id);
    if (list) list.push(entry);
    else byService.set(id, [entry]);
  }

  const groups: HostServiceGroup[] = [];
  const taken = new Set<string>();
  for (const service of HOST_SERVICES) {
    const list = byService.get(service.id) ?? [];
    if (list.length === 0 && !options.includeServiceIds?.includes(service.id)) continue;
    taken.add(service.id);
    groups.push({ service, entries: list });
  }
  // 兜底：宿主或插件先于设置面升级时，未登记的配置项仍然要显示。
  for (const [id, list] of byService) {
    if (taken.has(id) || list.length === 0) continue;
    groups.push({ service: { id, label: id, description: "" }, entries: list });
  }
  return groups;
}
