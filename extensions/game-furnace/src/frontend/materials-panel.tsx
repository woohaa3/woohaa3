/**
 * 游戏炼丹炉工作区左侧素材清单（extension 自有 UI，任务 5.4/5.5）
 * （change: 2026-10-10-add-game-furnace-extension）。
 *
 * 呈现每项素材的名称/分类/描述与可用性，并允许授权用户就地编辑；字段草稿按 resourceId 合并，
 * 远端新增素材或一次重渲染不会清空正在编辑的字段。图片/音视频/文本/模型/导演场/未知文件走
 * 受控展示（`ResourcePreview`，媒体不自动全部播放）。只读时输入禁用。
 *
 * 不 import 宿主 store 或后端实现；只消费公共扩展 API 类型与扩展自有纯逻辑。
 */
import type { MediaRemoteService } from "@woohaa3/frontend/extension-api";
import { Button } from "@woohaa3/frontend/extension-api";
import type { GameResource } from "../shared.js";
import { resourceUsage } from "../shared.js";
import { GameFurnaceFileImport, type GameFurnaceCollectResult } from "./file-import.js";
import { ResourcePreview } from "./resource-preview.js";
import { mergedResource, type ResourceDraft } from "./resource-draft.js";

/** 与后端 `resourceUsage` 对齐的可用性短标签。 */
export function usageLabel(kind: string): string {
  const usage = resourceUsage({ kind } as never).usage;
  return usage === "used" ? "可用于生成" : usage === "reference-only" ? "参考素材" : "仅保留原件";
}

export type GameFurnaceMaterialsPanelProps = {
  resources: readonly GameResource[];
  resourceDraft: ResourceDraft;
  dirtyResources: readonly string[];
  conflicts: readonly { resourceId: string; fields: readonly string[] }[];
  editable: boolean;
  busy: boolean;
  mediaRemote: MediaRemoteService;
  onResourceDraftChange: (updater: (previous: ResourceDraft) => ResourceDraft) => void;
  onSaveResources: () => Promise<void>;
  onCollect: (operations: readonly import("@woohaa3/contracts").Woohaa3CanvasJsonObject[]) => Promise<GameFurnaceCollectResult>;
};

export function GameFurnaceMaterialsPanel(props: GameFurnaceMaterialsPanelProps) {
  const { resources, resourceDraft, dirtyResources, conflicts, editable, busy, mediaRemote, onResourceDraftChange, onSaveResources, onCollect } = props;
  const patch = (resourceId: string, field: "name" | "category" | "description", value: string, base: string) =>
    onResourceDraftChange((previous) => ({ ...previous, [resourceId]: { ...previous[resourceId], [field]: { value, base } } }));
  return (
    <section className="game-furnace-workspace__materials" aria-label="素材">
      <h3>素材（{resources.length}）</h3>
      {conflicts.length > 0 ? (
        <p role="alert">有素材字段在你编辑期间被更新（{conflicts.map((entry) => `${entry.resourceId}: ${entry.fields.join("/")}`).join("；")}）。请放弃修改或刷新后再提交，以免覆盖并发编辑。</p>
      ) : null}
      {resources.length === 0 ? (
        <p className="game-furnace-workspace__empty">把画布节点拖到炼丹炉上即可收集素材；亦可添加文件。</p>
      ) : (
        <>
          <ul>
            {resources.map((resource) => {
              const shown = mergedResource(resource, resourceDraft[resource.resourceId]);
              return (
                <li key={resource.resourceId} data-resource-kind={resource.kind}>
                  <label>
                    名称
                    <input data-game-furnace-resource-name="true" value={shown.name} disabled={!editable}
                      onChange={(event) => patch(resource.resourceId, "name", event.target.value, resource.name)} />
                  </label>
                  <label>
                    分类
                    <input data-game-furnace-resource-category="true" value={shown.category} disabled={!editable}
                      onChange={(event) => patch(resource.resourceId, "category", event.target.value, resource.category)} />
                  </label>
                  <span className="game-furnace-workspace__usage">{usageLabel(resource.kind)}</span>
                  <label>
                    描述
                    <textarea data-game-furnace-resource-description="true" value={shown.description} disabled={!editable} rows={2}
                      onChange={(event) => patch(resource.resourceId, "description", event.target.value, resource.description)} />
                  </label>
                  {!shown.description ? <p role="status">待补充描述</p> : null}
                  <ResourcePreview key={resource.metadata?.storageKey ?? resource.resourceId} resource={resource} />
                </li>
              );
            })}
          </ul>
          {dirtyResources.length > 0 ? (
            <div className="game-furnace-workspace__actions">
              <Button size="sm" disabled={!editable || busy} onClick={() => void onSaveResources()}>保存素材信息</Button>
              <Button size="sm" disabled={!editable} onClick={() => onResourceDraftChange(() => ({}))}>放弃素材修改</Button>
            </div>
          ) : null}
        </>
      )}
      <GameFurnaceFileImport writable={editable} mediaRemote={mediaRemote} onCollect={onCollect} />
    </section>
  );
}
