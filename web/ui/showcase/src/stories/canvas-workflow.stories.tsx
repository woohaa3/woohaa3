import { useState } from "react";
import type { Story, StoryDefault } from "@ladle/react";
import { CanvasUndoControls } from "../../../../frontend/src/cordis/plugins/canvas-shell/canvas-undo-controls";
import { CanvasSearchPanel } from "../../../../frontend/src/cordis/ui/CanvasSearchPanel";
import { createWorkflowFixture, movePlan, sampleCanvas } from "../fixtures/canvas-workflow-fixture.js";

export default {
  title: "画布组件/画布工作流",
} satisfies StoryDefault;

function Stage({ children, note }: { children: React.ReactNode; note: string }) {
  return (
    <div className="showcase__stage">
      <div className="showcase__caption">
        <code>画布工作流</code> · {note}
      </div>
      <div className="showcase__frame">{children}</div>
    </div>
  );
}

/**
 * 撤销/重做：生产 `CanvasEditService` + `EditJournal`，真实规划 forward/inverse。
 * 移动作品 A → 记录一次可撤销动作；撤销/重做按钮与记录状态实时一致。
 */
export const UndoRedo: Story = () => {
  const controls = createWorkflowFixture();
  const [revision, setRevision] = useState(0);
  const [log, setLog] = useState<string[]>(["尚未记录任何可撤销动作"]);
  const bump = () => setRevision((value) => value + 1);
  return (
    <Stage note="移动/撤销/重做 · 冲突拒绝">
      <div className="showcase__actions" data-revision={revision}>
        <button
          type="button"
          data-testid="wf-move"
          onClick={() => {
            const plan = movePlan(controls.canvas(), "a", 120);
            if (!plan || !plan.ok) {
              setLog((items) => ["无法记录：操作没有净变化", ...items]);
              return;
            }
            void controls.edit.record([{ type: "node.update", nodeId: "a", position: { x: 120, y: 0 } }], "移动作品").then((result) => {
              setLog((items) => [result.ok ? "已记录：移动作品 A" : `未记录：${result.reason}`, ...items]);
              bump();
            });
          }}
        >
          移动作品 A
        </button>
        <button
          type="button"
          data-testid="wf-reject"
          onClick={() => {
            controls.rejectNext("作品已被其他操作修改，无法撤销");
            setLog((items) => ["下一次提交将被服务端拒绝", ...items]);
          }}
        >
          模拟服务端拒绝
        </button>
        <button type="button" data-testid="wf-remote-rename" onClick={() => { controls.remoteRenameA("被其它标签页改名"); setLog((items) => ["另一标签页改了 A 的名称", ...items]); bump(); }}>
          模拟并发修改
        </button>
      </div>
      <div className="showcase__workflow-undo">
        <CanvasUndoControls edit={controls.edit} />
      </div>
      <ul className="showcase__workflow-log">
        {log.slice(0, 6).map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </Stage>
  );
};
UndoRedo.storyName = "撤销与重做";

/** 参数本地撤销说明（参数条目不经服务端）。 */
export const ParameterUndo: Story = () => {
  const controls = createWorkflowFixture();
  const [revision, setRevision] = useState(0);
  return (
    <Stage note="参数草稿本地撤销 · 不写规范参数">
      <div className="showcase__actions">
        <button
          type="button"
          data-testid="wf-param"
          onClick={() => {
            controls.edit.recordParameter({
              label: "撤销参数修改",
              nodeId: "b",
              modelKey: "gpt-image-2",
              before: { steps: 20 },
              after: { steps: 40 },
              apply: () => undefined
            });
            setRevision((value) => value + 1);
          }}
        >
          记录一次参数修改
        </button>
        <span data-testid="wf-param-count">{revision}</span>
      </div>
      <div className="showcase__workflow-undo">
        <CanvasUndoControls edit={controls.edit} />
      </div>
      <p className="showcase__note">撤销只恢复 {`{nodeId, modelKey}`} 草稿分区的参数，不提交画布命令、不重新生成。</p>
    </Stage>
  );
};
ParameterUndo.storyName = "参数本地撤销";

/** 查找作品：名称/类型检索、同名区分、键盘选择。 */
export const Search: Story = () => {
  const controls = createWorkflowFixture();
  controls.search.open();
  controls.search.setQuery("");
  const canvas = sampleCanvas();
  return (
    <Stage note="查找作品 · 名称/类型/同一画布">
      <div className="showcase__frame showcase__frame--full">
        <CanvasSearchPanel
          store={controls.search}
          getCanvas={() => canvas}
          onLocate={() => ({ ok: true })}
        />
      </div>
    </Stage>
  );
};
Search.storyName = "查找作品";

/** 同名与未命名区分。 */
export const SearchSameName: Story = () => {
  const controls = createWorkflowFixture();
  controls.search.open();
  controls.search.setQuery("海边");
  const canvas = sampleCanvas();
  canvas.document.nodes.push({ id: "d", type: "image", position: { x: 960, y: 0 }, width: 260, height: 195 });
  canvas.nodeData = { ...canvas.nodeData, d: { title: "海边日落" } };
  return (
    <Stage note="同名作品用短 ID 区分；未命名用中文默认名">
      <div className="showcase__frame showcase__frame--full">
        <CanvasSearchPanel store={controls.search} getCanvas={() => canvas} onLocate={() => ({ ok: true })} />
      </div>
    </Stage>
  );
};
SearchSameName.storyName = "同名与未命名";

/** 窄屏 390px：查找面板与撤销按钮可达。 */
export const Narrow: Story = () => {
  const controls = createWorkflowFixture();
  controls.search.open();
  const canvas = sampleCanvas();
  return (
    <Stage note="390px · 查找与撤销可达">
      <div className="showcase__frame showcase__frame--narrow">
        <CanvasSearchPanel store={controls.search} getCanvas={() => canvas} onLocate={() => ({ ok: true })} />
        <div className="showcase__workflow-undo">
          <CanvasUndoControls edit={controls.edit} />
        </div>
      </div>
    </Stage>
  );
};
Narrow.storyName = "窄屏 390";
