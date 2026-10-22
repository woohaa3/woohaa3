/**
 * 游戏炼丹炉工作区右侧需求与版本面板（extension 自有 UI，任务 5.3/5.6/5.7/5.8）
 * （change: 2026-10-10-add-game-furnace-extension）。
 *
 * 名称/描述必填、玩法选填；模型选择来自当前可执行 language catalog，无可用模型时禁用生成并
 * 给出配置入口；生成阶段/候选-活动版本可见，失败给出安全原因。只读时写操作禁用。
 */
import { Button } from "@woohaa3/frontend/extension-api";
import type { GameBuild, GameGeneration, GameRequirements } from "../shared.js";
import type { RequirementsDraft } from "./workspace-session.js";
import { phaseLabel } from "./workspace-session.js";
import { GameFurnaceMcpGuide } from "./mcp-guide.js";

export type GameFurnaceRequirementsPanelProps = {
  canvasId: string | undefined;
  nodeId: string;
  requirements: GameRequirements;
  builds: readonly GameBuild[];
  generations: readonly GameGeneration[];
  activeBuildId?: string;
  latestGenerationId?: string;
  dirtyFields: readonly (keyof RequirementsDraft)[];
  canGenerate: boolean;
  editable: boolean;
  busy: boolean;
  /** 真实阶段字符串（来自 disposition/任务），未知值显示为「状态暂不可确认」。 */
  phase: string;
  model: { executable: boolean; modelKey?: string; message?: string | null; models: readonly { modelKey: string; title: string }[] };
  guideWritable: boolean;
  onDraftChange: (field: keyof RequirementsDraft, value: string) => void;
  onConfigureModels: () => void;
  onSave: () => Promise<unknown>;
  onGenerate: () => Promise<void>;
  onCancel: () => Promise<void>;
  onFinalize: (generationId: string) => Promise<void>;
  onPlay: (buildId: string) => Promise<void>;
  onActivate: (buildId: string) => Promise<void>;
};

export function GameFurnaceRequirementsPanel(props: GameFurnaceRequirementsPanelProps) {
  const { requirements, builds, generations, activeBuildId, latestGenerationId, dirtyFields, canGenerate, editable, busy, phase, model } = props;
  const latestGeneration = generations.find(generation => generation.generationId === latestGenerationId);
  const phaseText = phaseLabel(phase);
  return (
    <section className="game-furnace-workspace__requirements" aria-label="游戏需求">
      <GameFurnaceMcpGuide key={`${props.canvasId}:${props.nodeId}`} canvasId={props.canvasId} nodeId={props.nodeId} requirements={requirements} writable={props.guideWritable} />
      <h3>游戏需求</h3>
      <label>
        名称
        <input data-game-furnace-name="true" value={requirements.name} disabled={!editable}
          onChange={(event) => props.onDraftChange("name", event.target.value)} />
      </label>
      <label>
        描述
        <textarea data-game-furnace-description="true" value={requirements.description} disabled={!editable} rows={4}
          onChange={(event) => props.onDraftChange("description", event.target.value)} />
      </label>
      <label>
        玩法（选填）
        <textarea value={requirements.gameplay ?? ""} disabled={!editable} rows={3}
          onChange={(event) => props.onDraftChange("gameplay", event.target.value)} />
      </label>
      <label>
        语言模型
        <select value={model.modelKey ?? ""} disabled={!editable} onChange={(event) => props.onDraftChange("modelKey", event.target.value)}>
          {!model.executable ? <option value={model.modelKey ?? ""}>{model.message ?? "请选择模型"}</option> : null}
          {model.models.map(item => <option key={item.modelKey} value={item.modelKey}>{item.title}</option>)}
        </select>
      </label>
      {model.message ? <p role="status">{model.message}</p> : null}
      <Button size="sm" onClick={props.onConfigureModels}>配置模型</Button>

      <div className="game-furnace-workspace__actions">
        <Button size="sm" disabled={!editable || dirtyFields.length === 0} onClick={() => void props.onSave()}>保存</Button>
        <Button size="sm" tone="primary" disabled={!editable || !canGenerate || !model.executable} onClick={() => void props.onGenerate()}>生成</Button>
      </div>
      <p className="game-furnace-workspace__phase" data-game-furnace-phase={phase}>阶段：{phaseText}</p>
      {latestGeneration && !latestGeneration.candidateBuildId && latestGeneration.disposition !== "cancelled" && latestGeneration.disposition !== "failed" ? <>
        <p>当前生成采用已确认的输入；后续编辑仅用于下一次生成。</p>
        <Button size="sm" disabled={!editable} onClick={() => void props.onCancel()}>取消生成</Button>
      </> : null}

      {builds.length > 0 ? (
        <ul className="game-furnace-workspace__builds">
          {builds.map((build) => (
            <li key={build.buildId}>
              <span>{build.title}</span>
              {build.buildId === activeBuildId ? <span>当前</span> : <span className="game-furnace-workspace__candidate">候选</span>}
              <Button size="sm" onClick={() => void props.onPlay(build.buildId)}>试玩</Button>
              {build.buildId !== activeBuildId ? (
                <Button size="sm" disabled={!editable || busy} onClick={() => void props.onActivate(build.buildId)}>采用</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {latestGenerationId ? (
        <Button size="sm" disabled={!editable || busy} onClick={() => void props.onFinalize(latestGenerationId)}>收尾最新生成</Button>
      ) : null}
    </section>
  );
}
