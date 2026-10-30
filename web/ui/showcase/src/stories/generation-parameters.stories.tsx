/**
 * 生成参数预设卡片 · 渲染对照
 *
 * 这个 story 给「要接新 Provider 的人」看三件事：
 * 1. **卡片只是数据**：`@woohaa3/contracts` 的 `BUILTIN_PRESET_CARDS` 里加一条，
 *    面板立刻多一个模型——story 里没有一条 `if (modelId === ...)`；
 * 2. **渲染走生产链路**：`composePresetCard` → `projectParameterFields` → `ExecutionPanel`，
 *    与画布上的面板是同一份代码；
 * 3. **剪枝与约束的差别**：剪枝改 schema（少几个控件），约束改行为（计数、禁用、提示）。
 *
 * 数据全部来自契约，夹具只补部署级上限与 `ExecutionPanel` 的装配。
 */
import { useMemo, useState } from "react";
import type { Story, StoryDefault } from "@ladle/react";
import {
  BUILTIN_PRESET_CARDS,
  PARAMETER_CONTROLS,
  MODEL_TYPE_PRESETS,
  presetCardsOf
} from "@woohaa3/contracts";
import {
  ExecutionPanel,
  type ExecutionPanelData
} from "../../../../frontend/src/cordis/plugins/task-execution/execution-panel/index.js";
import {
  SHOWCASE_DEPLOY_LIMITS,
  buildCardSet,
  type ComposedEntry
} from "../fixtures/parameter-presets.js";

export default {
  title: "画布组件/生成参数/预设卡片"
} satisfies StoryDefault;

const IMAGE_CARDS = presetCardsOf(BUILTIN_PRESET_CARDS, "image");
const VIDEO_CARDS = presetCardsOf(BUILTIN_PRESET_CARDS, "video");
const AUDIO_CARDS = presetCardsOf(BUILTIN_PRESET_CARDS, "audio");

/** 面板外的说明栏：列出被剪掉的键与生效后的约束。 */
function CardNotes({ entry }: { entry: ComposedEntry | undefined }) {
  if (entry === undefined) return null;
  const limits = entry.limits;
  return (
    <div className="showcase__caption" style={{ display: "block", lineHeight: 1.9 }}>
      <div>
        剪掉：{" "}
        {entry.dropped.length === 0 ? (
          <code>（无）</code>
        ) : (
          entry.dropped.map((key) => <code key={key}>{key}</code>)
        )}
      </div>
      <div>
        约束：{" "}
        {limits === null ? (
          <code>未声明</code>
        ) : (
          <>
            <code>prompt ≤ {limits.promptMaxChars}</code>
            {Object.entries(limits.references).map(([kind, limit]) => (
              <code key={kind}>
                {kind} {limit.min}–{limit.max}
                {limit.capped ? "（被部署级截断）" : ""}
              </code>
            ))}
            {limits.total === null ? null : (
              <code>
                合计 ≤ {limits.total.max}
              </code>
            )}
            {limits.combined.map((rule) => (
              <code key={rule.label}>
                {rule.label} ≤ {rule.max}
              </code>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Stage({
  taskKind,
  cards,
  note
}: {
  taskKind: "image-generation" | "video-generation" | "audio-generation";
  cards: readonly import("@woohaa3/contracts").PresetCard[];
  note: string;
}) {
  const { config, entries } = useMemo(() => buildCardSet(cards), [cards]);
  const [data, setData] = useState<ExecutionPanelData>({
    panelPrompt: "",
    taskStatus: "idle",
    parameters: { model: config.defaultModel }
  });
  const modelKey =
    typeof data.parameters?.model === "string" ? data.parameters.model : config.defaultModel;
  const entry = entries.get(modelKey);
  const limits = entry?.limits ?? null;

  // 唯一一处「约束 → 面板」的连线：把未满足的下限交给面板的 blockingReasons。
  const blockingReasons =
    limits === null
      ? undefined
      : Object.entries(limits.references)
          .filter(([, limit]) => limit.min > 0)
          .map(([kind, limit]) => `至少需要 ${limit.min} 份${kindLabel(kind)}`);

  return (
    <div className="showcase__stage">
      <div className="showcase__caption">{note}</div>
      <div className="showcase__frame showcase__frame--sidebar" style={{ width: 400 }}>
        <ExecutionPanel
          taskKind={taskKind}
          modelConfig={config}
          data={data}
          surface="sidebar"
          width={400}
          {...(blockingReasons !== undefined ? { blockingReasons } : {})}
          onChange={(patch) => setData((prev) => ({ ...prev, ...patch }))}
        />
      </div>
      <CardNotes entry={entry} />
    </div>
  );
}

function kindLabel(kind: string): string {
  return kind === "image" ? "参考图" : kind === "video" ? "参考视频" : "参考音频";
}

/** 图片卡片：Seedream Pro / Flash、GPT Image、Gemini、托管通用。 */
export const ImageCards: Story = () => (
  <Stage
    taskKind="image-generation"
    cards={IMAGE_CARDS}
    note="图片卡片共用同一个类型预设；schema 由 imageFamilyParameters 给出，卡片只做剪枝。切换顶部模型选择器对比。"
  />
);
ImageCards.storyName = "图片卡片";

/** 视频卡片：Seedance 2.5 / 2.0 Fast / TokenHub / 托管通用。 */
export const VideoCards: Story = () => (
  <Stage
    taskKind="video-generation"
    cards={VIDEO_CARDS}
    note="视频卡片：参考图 / 参考视频 / 参考音频按卡片各自可用，约束决定下限与拦截。"
  />
);
VideoCards.storyName = "视频卡片";

/** 音频卡片：OpenAI TTS、MiniMax Speech、托管通用。 */
export const AudioCards: Story = () => (
  <Stage
    taskKind="audio-generation"
    cards={AUDIO_CARDS}
    note="音频卡片：音色 / 输出格式 / 语速由卡片收窄；没有参考素材，也没有家族表——值域就写在这几张卡片上。"
  />
);
AudioCards.storyName = "音频卡片";

/** 今天的样子：服务端按类型写死，只有两个文本框，且没有卡片约束。 */
export const TodayGeneric: Story = () => (
  <Stage
    taskKind="video-generation"
    cards={VIDEO_CARDS.filter((card) => card.adds?.includes("seconds"))}
    note="复刻现状：服务端 inputSchemaFor(modelType) 的通用形状，没有约束声明。"
  />
);
TodayGeneric.storyName = "今天的样子";

/** 最大集合总览：契约里定义的每个预设控件，以及它进了哪个类型预设。 */
export const ControlUniverse: Story = () => (
  <div className="showcase__stage">
    <div className="showcase__caption">
      参数最大集合共 <code>{PARAMETER_CONTROLS.length}</code> 个控件，全部来自
      <code>@woohaa3/contracts</code>；类型预设只挑选其中一部分。
    </div>
    <table className="showcase__log" style={{ display: "table", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={{ textAlign: "left", padding: "4px 12px" }}>分组</th>
          <th style={{ textAlign: "left", padding: "4px 12px" }}>键</th>
          <th style={{ textAlign: "left", padding: "4px 12px" }}>控件</th>
          <th style={{ textAlign: "left", padding: "4px 12px" }}>图片预设</th>
          <th style={{ textAlign: "left", padding: "4px 12px" }}>视频预设</th>
          <th style={{ textAlign: "left", padding: "4px 12px" }}>音频预设</th>
        </tr>
      </thead>
      <tbody>
        {PARAMETER_CONTROLS.map((control) => (
          <tr key={control.key}>
            <td style={{ padding: "3px 12px" }}>{control.group}</td>
            <td style={{ padding: "3px 12px" }}>
              <code>{control.key}</code>
            </td>
            <td style={{ padding: "3px 12px" }}>{control.label}</td>
            <td style={{ padding: "3px 12px" }}>
              {MODEL_TYPE_PRESETS.image.keys.includes(control.key) ? "✓" : "—"}
            </td>
            <td style={{ padding: "3px 12px" }}>
              {MODEL_TYPE_PRESETS.video.keys.includes(control.key) ? "✓" : "—"}
            </td>
            <td style={{ padding: "3px 12px" }}>
              {MODEL_TYPE_PRESETS.audio.keys.includes(control.key) ? "✓" : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    <div className="showcase__caption">
      部署级上限（同样取自契约 <code>CANVAS_TASK_LIMITS</code>）：prompt{" "}
      <code>{SHOWCASE_DEPLOY_LIMITS.promptMaxChars}</code> 字、参考总数{" "}
      <code>{SHOWCASE_DEPLOY_LIMITS.totalReferences}</code>、单个素材{" "}
      <code>{Math.round(SHOWCASE_DEPLOY_LIMITS.maxBytesPerItem / 1024 / 1024)}MB</code>。
      模型级声明会被它截断。
    </div>
  </div>
);
ControlUniverse.storyName = "参数最大集合";

/** 约束拦截：TokenHub 要求至少一张参考图。 */
export const LimitsBlocked: Story = () => {
  const cards = VIDEO_CARDS.filter((card) => card.id === "tokenhub-video");
  const { config, entries } = useMemo(() => buildCardSet(cards), [cards]);
  const [data, setData] = useState<ExecutionPanelData>({
    panelPrompt: "",
    taskStatus: "idle",
    parameters: { model: config.defaultModel }
  });
  const entry = entries.get(config.defaultModel);
  const minImage = entry?.limits?.references.image?.min ?? 0;

  return (
    <div className="showcase__stage">
      <div className="showcase__caption">
        TokenHub 声明了 <code>references.image.min = {minImage}</code>：没有参考图时主操作必须不可用。
        这条规则 <code>inputSchema</code> 表达不了，只能由卡片约束承载。
      </div>
      <div className="showcase__frame showcase__frame--sidebar" style={{ width: 400 }}>
        <ExecutionPanel
          taskKind="video-generation"
          modelConfig={config}
          data={data}
          surface="sidebar"
          width={400}
          {...(minImage > 0 ? { blockingReasons: [`至少需要 ${minImage} 张参考图`] } : {})}
          onChange={(patch) => setData((prev) => ({ ...prev, ...patch }))}
        />
      </div>
      <CardNotes entry={entry} />
    </div>
  );
};
LimitsBlocked.storyName = "约束拦截";