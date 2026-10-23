import { useEffect, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { isRecord } from "../shared/panels.js";
import {
  CANVAS_ANCHORS,
  CROP_RATIOS,
  EXTENSION_COLORS,
  RESAMPLE_METHODS,
  TRIM_BASIS,
  canvasSizeParams,
  cropParams,
  fitCropFrame,
  isParamError,
  isValidPerspectiveQuad,
  parseWorkflowManifest,
  perspectiveCropParams,
  pixelsToPrintSize,
  PUPPET_DENSITY,
  PUPPET_MODES,
  puppetWarpParams,
  perspectiveWarpParams,
  resolveCropRatio,
  rotateArbitraryParams,
  rotatedCanvasSize,
  trimParams,
  type CompositionWorkflow,
  type PerspectiveCorners,
  type PrintUnit
} from "./workflows.js";
import {
  compileImageSize,
  compileWorkflow,
  defaultValues,
  isWorkflowEnabled,
  meshParamsFor,
  puppetPinOf,
  workflowFields,
  type FieldValue,
  type FieldValues,
  type WorkflowField
} from "./workflow-form.js";
import { publishCompositionOverlay, releaseCompositionOverlay } from "./overlay-store.js";
import { identityWarpMesh, isIdentityWarpMesh } from "./warp-mesh.js";
import type { TransformRect, WarpMesh } from "./workflows.js";

type ComposeCommand = "image.crop" | "image.imageSize" | "image.canvasSize" | "image.trim";

const COMPOSE_LABELS: Record<ComposeCommand, string> = {
  "image.crop": "裁剪",
  "image.imageSize": "图像尺寸",
  "image.canvasSize": "画布尺寸",
  "image.trim": "裁边"
};

function messageOf(result: { ok: boolean; message?: string }): string | null {
  return result.ok ? null : (result.message ?? "操作被拒绝");
}

/** 内核返回的构图工作流清单（结构非法时为空，界面因此只显示预览类操作）。 */
function useWorkflows(controller: EditorWorkspaceController): CompositionWorkflow[] {
  const [workflows] = useState(() => {
    const composition = controller.features.composition;
    if (typeof composition?.workflowManifest !== "function") return [];
    const result = composition.workflowManifest();
    if (!result.ok) return [];
    return parseWorkflowManifest(result.value) ?? [];
  });
  return workflows;
}

// ---------------------------------------------------------------- 裁剪 / 尺寸 / 裁边

export function ComposePanel({ controller, readonly, width, height, initialCommand }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  initialCommand?: string;
  width: number;
  height: number;
}) {
  const [command, setCommand] = useState<ComposeCommand>(initialCommand && initialCommand in COMPOSE_LABELS ? initialCommand as ComposeCommand : "image.crop");
  const [frame, setFrame] = useState({ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) });
  const [ratioId, setRatioId] = useState<string>("free");
  const [angle, setAngle] = useState(0);
  /** 整图任意角度旋转的预览角度；与裁剪「拉直」是两件事，不能共用一份状态。 */
  const [rotateAngle, setRotateAngle] = useState(0);
  const [deletePixels, setDeletePixels] = useState(true);
  const [contentAware, setContentAware] = useState(false);
  const [resample, setResample] = useState<(typeof RESAMPLE_METHODS)[number]>("bicubic");
  const [resolution, setResolution] = useState(72);
  const [keepPrintSize, setKeepPrintSize] = useState(false);
  const [percent, setPercent] = useState(100);
  /** 显式宽高；空表示「按百分比或只改 DPI」。 */
  const [pixels, setPixels] = useState<{ width: number | null; height: number | null }>({ width: null, height: null });
  const [relative, setRelative] = useState(false);
  const [anchor, setAnchor] = useState<(typeof CANVAS_ANCHORS)[number]>("center");
  const [extensionColor, setExtensionColor] = useState<string>("background");
  const [basedOn, setBasedOn] = useState<(typeof TRIM_BASIS)[number]>("transparent");
  const [sides, setSides] = useState({ top: true, bottom: true, left: true, right: true });
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  const [printUnit, setPrintUnit] = useState<PrintUnit>("in");
  const [status, setStatus] = useState<string | null>(null);

  const document = { width: Math.max(1, width), height: Math.max(1, height) };
  // 相对模式下的宽高是「增减量」，初值是 0 而不是文档尺寸——否则一切换就被当成 +40/+30。
  const [relativeSize, setRelativeSize] = useState({ width: 0, height: 0 });

  /**
   * 裁剪框叠加层：只在裁剪命令且已进入预览时发布，确认/取消后立即撤回。
   *
   * 叠加层与面板共用同一份 `frame`/`angle`：画布上拖动会写回面板输入框，面板改数值也会
   * 反映到画布框上，避免出现「两个各自维护的裁剪框」。
   */
  useEffect(() => {
    const cropping = command === "image.crop";
    if (!cropping || !active) {
      // 裁剪预览未激活时，若正在调任意角度旋转就显示旋转预览；两者互斥。
      if (Math.abs(rotateAngle) >= 0.05) {
        publishCompositionOverlay({
          active: "rotate",
          document,
          angle: rotateAngle,
          snap: 15,
          onAngleChange: (next) => setRotateAngle(next)
        }, "composition.rotate");
      } else {
        releaseCompositionOverlay("composition.rotate");
      }
      releaseCompositionOverlay("composition.crop");
      return;
    }
    releaseCompositionOverlay("composition.rotate");
    publishCompositionOverlay({
      active: "crop",
      frame,
      document,
      angle,
      ratio: resolveCropRatio(CROP_RATIOS.find((entry) => entry.id === ratioId)?.ratio, document),
      grid: "thirds",
      allowOutside: true,
      onFrameChange: (next) => setFrame(next),
      onStraightenChange: (next) => setAngle(next)
    }, "composition.crop");
  }, [command, active, frame.x, frame.y, frame.width, frame.height, angle, rotateAngle, ratioId, document.width, document.height]);

  // 面板卸载时让出自己的两个槽位，画布上不能残留旧框。
  useEffect(() => () => {
    releaseCompositionOverlay("composition.crop");
    releaseCompositionOverlay("composition.rotate");
  }, []);

  const plan = (): Record<string, unknown> | null => {
    if (command === "image.crop") {
      const compiled = cropParams({ frame, angle, deleteCroppedPixels: deletePixels, contentAware, resample });
      if (isParamError(compiled)) { setMessage(compiled.error); return null; }
      return compiled;
    }
    if (command === "image.imageSize") {
      const values: FieldValues = {
        resolution,
        resample,
        keepPrintSize,
        ...(percent !== 100 ? { percent } : {}),
        ...(pixels.width !== null ? { width: pixels.width } : {}),
        ...(pixels.height !== null ? { height: pixels.height } : {})
      };
      const compiled = compileImageSize(values);
      if (isParamError(compiled)) { setMessage(compiled.error); return null; }
      return compiled;
    }
    if (command === "image.canvasSize") {
      const compiled = canvasSizeParams({
        width: relative ? relativeSize.width : frame.width,
        height: relative ? relativeSize.height : frame.height,
        relative,
        anchor,
        extensionColor: extensionColor as `#${string}`
      });
      if (isParamError(compiled)) { setMessage(compiled.error); return null; }
      return compiled;
    }
    const compiled = trimParams({ basedOn, ...sides });
    if (isParamError(compiled)) { setMessage(compiled.error); return null; }
    return compiled;
  };

  const preview = () => {
    const params = plan();
    if (!params) return;
    const result = active ? controller.updateCompose(params) : controller.beginCompose(command, params);
    setMessage(messageOf(result));
    if (!result.ok) return;
    setActive(true);
    if (isRecord(result.value) && typeof result.value.width === "number" && typeof result.value.height === "number") {
      setSize([result.value.width, result.value.height]);
    }
  };

  const applyRatio = (id: string) => {
    setRatioId(id);
    const entry = CROP_RATIOS.find((candidate) => candidate.id === id);
    if (!entry) return;
    setFrame((current) => fitCropFrame(current, resolveCropRatio(entry.ratio, document), document));
  };

  const runWorkflow = (id: string, params: Record<string, unknown>) => {
    const composition = controller.features.composition;
    const result = composition.runWorkflow(id, params);
    setStatus(result.ok ? null : messageOf(result));
  };

  const workflows = useWorkflows(controller);
  const availability = (id: string) => workflows.find((workflow) => workflow.id === id);

  const numberInput = (value: number, onChange: (value: number) => void, extra: { min?: number; step?: number } = {}) => (
    <input type="number" value={value} disabled={readonly || active} {...extra}
      onChange={(event) => onChange(Number(event.currentTarget.value))} />
  );

  return (
    <section className="photo-editor__advanced-group" aria-label="构图" data-compose-panel="true">
      <span className="photo-editor__options-title">{COMPOSE_LABELS[command]}</span>
      <label>
        操作
        <select value={command} disabled={readonly || active} onChange={(event) => setCommand(event.currentTarget.value as ComposeCommand)}>
          {(Object.keys(COMPOSE_LABELS) as ComposeCommand[]).map((id) => <option key={id} value={id}>{COMPOSE_LABELS[id]}</option>)}
        </select>
      </label>

      {command === "image.crop" ? (
        <>
          <label>
            比例
            <select value={ratioId} disabled={readonly || active} onChange={(event) => applyRatio(event.currentTarget.value)}>
              {CROP_RATIOS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <label>X{numberInput(frame.x, (value) => setFrame((current) => ({ ...current, x: value })))}</label>
          <label>Y{numberInput(frame.y, (value) => setFrame((current) => ({ ...current, y: value })))}</label>
          <label>宽{numberInput(frame.width, (value) => setFrame((current) => ({ ...current, width: value })), { min: 1 })}</label>
          <label>高{numberInput(frame.height, (value) => setFrame((current) => ({ ...current, height: value })), { min: 1 })}</label>
          <label>拉直{numberInput(angle, setAngle, { min: -45, step: 0.1 })}°</label>
          <label><input type="checkbox" checked={deletePixels} disabled={readonly || active} onChange={(event) => setDeletePixels(event.currentTarget.checked)} />删除裁剪像素</label>
          <label><input type="checkbox" checked={contentAware} disabled={readonly || active} onChange={(event) => setContentAware(event.currentTarget.checked)} />内容识别填充露出区域</label>
          <label>
            重采样
            <select value={resample} disabled={readonly || active} onChange={(event) => setResample(event.currentTarget.value as typeof resample)}>
              {RESAMPLE_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
            </select>
          </label>
          <span className="photo-editor__option-hint">
            裁剪框可超出画布（扩展画布）；「删除裁剪像素」关闭时可用「显示全部」恢复。
          </span>
        </>
      ) : null}

      {command === "image.imageSize" ? (
        <>
          <label>宽{numberInput(pixels.width ?? document.width, (value) => setPixels((current) => ({ ...current, width: value })), { min: 1 })}px</label>
          <label>高{numberInput(pixels.height ?? document.height, (value) => setPixels((current) => ({ ...current, height: value })), { min: 1 })}px</label>
          <label>百分比{numberInput(percent, setPercent, { min: 1 })}%</label>
          <label>分辨率{numberInput(resolution, setResolution, { min: 1 })}ppi</label>
          <label>
            打印尺寸
            <select value={printUnit} disabled={readonly} onChange={(event) => setPrintUnit(event.currentTarget.value as PrintUnit)}>
              <option value="in">英寸</option>
              <option value="cm">厘米</option>
              <option value="mm">毫米</option>
            </select>
          </label>
          <span className="photo-editor__option-hint">
            {pixelsToPrintSize(pixels.width ?? document.width, printUnit, resolution)?.toFixed(2) ?? "—"} × {pixelsToPrintSize(pixels.height ?? document.height, printUnit, resolution)?.toFixed(2) ?? "—"} {printUnit}
            ；仅改分辨率时像素不变，勾选「保持打印尺寸」才重采样。
          </span>
          <label><input type="checkbox" checked={keepPrintSize} disabled={readonly || active} onChange={(event) => setKeepPrintSize(event.currentTarget.checked)} />保持打印尺寸（按分辨率重采样）</label>
          <label>
            重采样
            <select value={resample} disabled={readonly || active} onChange={(event) => setResample(event.currentTarget.value as typeof resample)}>
              {RESAMPLE_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
            </select>
          </label>
          <Button size="sm" tone="ghost" disabled={readonly || active} onClick={() => setPixels({ width: null, height: null })}>按百分比</Button>
        </>
      ) : null}

      {command === "image.canvasSize" ? (
        <>
          <label><input type="checkbox" checked={relative} disabled={readonly || active}
            onChange={(event) => { const next = event.currentTarget.checked; setRelative(next); if (next) setRelativeSize({ width: 0, height: 0 }); }} />相对当前尺寸</label>
          {relative ? (
            <>
              <label>宽增减{numberInput(relativeSize.width, (value) => setRelativeSize((current) => ({ ...current, width: value })))}px</label>
              <label>高增减{numberInput(relativeSize.height, (value) => setRelativeSize((current) => ({ ...current, height: value })))}px</label>
              <span className="photo-editor__option-hint">负值收缩；收缩后宽高至少为 1 像素。</span>
            </>
          ) : (
            <>
              <label>宽{numberInput(frame.width, (value) => setFrame((current) => ({ ...current, width: value })), { min: 1 })}px</label>
              <label>高{numberInput(frame.height, (value) => setFrame((current) => ({ ...current, height: value })), { min: 1 })}px</label>
            </>
          )}
          <label>
            锚点
            <select value={anchor} disabled={readonly || active} onChange={(event) => setAnchor(event.currentTarget.value as typeof anchor)}>
              {CANVAS_ANCHORS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            扩展颜色
            <select value={extensionColor} disabled={readonly || active} onChange={(event) => setExtensionColor(event.currentTarget.value)}>
              {EXTENSION_COLORS.map((value) => <option key={value} value={value}>{value}</option>)}
              <option value="#ffffff">#ffffff</option>
            </select>
          </label>
        </>
      ) : null}

      {command === "image.trim" ? (
        <>
          <label>
            依据
            <select value={basedOn} disabled={readonly || active} onChange={(event) => setBasedOn(event.currentTarget.value as typeof basedOn)}>
              {TRIM_BASIS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {(["top", "bottom", "left", "right"] as const).map((side) => (
            <label key={side}>
              <input type="checkbox" checked={sides[side]} disabled={readonly || active}
                onChange={(event) => { const checked = event.currentTarget.checked; setSides((current) => ({ ...current, [side]: checked })); }} />
              {side}
            </label>
          ))}
        </>
      ) : null}

      <Button size="sm" disabled={readonly} onClick={preview}>预览</Button>
      <Button size="sm" disabled={readonly || !active} onClick={() => {
        const result = controller.commitCompose();
        setMessage(messageOf(result));
        setActive(false);
        setSize(null);
      }}>确认</Button>
      <Button size="sm" tone="ghost" disabled={!active} onClick={() => {
        controller.cancelCompose();
        setActive(false);
        setSize(null);
        setMessage(null);
      }}>取消</Button>
      {size ? <span className="photo-editor__option-hint">{size[0]} × {size[1]}</span> : null}

      <PerspectiveCropControls
        readonly={readonly}
        document={document}
        availability={availability("perspectiveCrop")}
        onApply={(params) => runWorkflow("perspectiveCrop", params)}
      />

      <div className="photo-editor__options-group" aria-label="整图操作">
        <Button size="sm" tone="ghost" disabled={readonly || !isWorkflowEnabled(availability("revealAll"))}
          title={availability("revealAll")?.reason ?? undefined}
          onClick={() => runWorkflow("revealAll", {})}>显示全部</Button>
        <label>任意角度{numberInput(rotateAngle, setRotateAngle, { min: -359, step: 0.1 })}°</label>
        <Button size="sm" tone="ghost" disabled={readonly || !isWorkflowEnabled(availability("rotateArbitrary"))}
          title={availability("rotateArbitrary")?.reason ?? undefined}
          onClick={() => {
            const params = rotateArbitraryParams(rotateAngle);
            if (isParamError(params)) { setStatus(params.error); return; }
            const next = rotatedCanvasSize(document, rotateAngle);
            setStatus(`旋转后画布 ${next.width} × ${next.height}`);
            runWorkflow("rotateArbitrary", params);
            // 已提交到内核，预览框随之撤回（文档尺寸已经变了）。
            setRotateAngle(0);
          }}>旋转画布</Button>
      </div>

      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
      {status ? <p className="photo-editor__brush-note">{status}</p> : null}
    </section>
  );
}

/** 四角透视裁剪：输入四个角的文档坐标，先做凸性校验再提交。 */
function PerspectiveCropControls({ readonly, document, availability, onApply }: {
  readonly: boolean;
  document: { width: number; height: number };
  availability: CompositionWorkflow | undefined;
  onApply: (params: Record<string, unknown>) => void;
}) {
  const [corners, setCorners] = useState<PerspectiveCorners>([
    [0, 0],
    [document.width, 0],
    [document.width, document.height],
    [0, document.height]
  ]);
  const [error, setError] = useState<string | null>(null);
  const valid = isValidPerspectiveQuad(corners);
  const disabled = readonly || !isWorkflowEnabled(availability);
  const setCorner = (index: number, axis: 0 | 1, value: number) => {
    setCorners((current) => current.map((corner, position) => position === index
      ? (axis === 0 ? [value, corner[1]] : [corner[0], value]) as [number, number]
      : corner) as PerspectiveCorners);
  };
  return (
    <div className="photo-editor__options-group" aria-label="透视裁剪">
      <span className="photo-editor__options-title">透视裁剪</span>
      {corners.map((corner, index) => (
        <label key={index}>
          {["左上", "右上", "右下", "左下"][index]}
          <input type="number" value={corner[0]} disabled={disabled} onChange={(event) => setCorner(index, 0, Number(event.currentTarget.value))} />
          <input type="number" value={corner[1]} disabled={disabled} onChange={(event) => setCorner(index, 1, Number(event.currentTarget.value))} />
        </label>
      ))}
      <Button size="sm" disabled={disabled || !valid} title={availability?.reason ?? undefined} onClick={() => {
        const params = perspectiveCropParams(corners);
        if (isParamError(params)) { setError(params.error); return; }
        setError(null);
        onApply(params);
      }}>裁剪到四角</Button>
      {!valid ? <span className="photo-editor__option-hint">四角必须构成顺时针凸四边形</span> : null}
      {availability && !availability.allowed ? <span className="photo-editor__option-hint">{availability.reason}</span> : null}
      {error ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- 其余工作流

/**
 * 通用工作流面板：按分组列出入口，未开放的显示具体原因，选中的入口渲染字段表。
 *
 * 字段与参数编译在 `workflow-form.ts`（纯函数、可单测），本组件只管渲染与收集值。
 * 三个入口有专用表单（透视变形、操控变形、透视裁剪），其余走声明式字段表。
 */
export function CompositionWorkflowPanel({ controller, readonly, groups }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  groups: readonly string[];
}) {
  const workflows = useWorkflows(controller);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * 当前正在编辑的变形（上游的「transform session warp」）。
   *
   * `edit.transform.warp` 把变形直接应用到图层，不返回 warp 对象；而 `warpGrid` / `splitWarp*`
   * 需要一个 warp 才能工作（否则它们会去找活动智能对象，普通像素层上必然失败）。因此这里由
   * 界面会话持有：先用一次 `warp` 建立它，再把它整链路传给网格与拆分。
   */
  const [warpSession, setWarpSession] = useState<unknown>(undefined);
  /**
   * 画布上的变形网格会话：`{rect, mesh}`。
   *
   * 只有选中 `warp` 且当前有目标图层时才进入——这时网格框就是该图层的 `transformFrame`，
   * 与内核 `edit.transform.warp` 用的 `rect` 是同一份角点。拖动控制点改的是这份 `mesh`，
   * 「应用变形」把它按 `warp` 送进内核；双击分割则把当前 `mesh` 作为「正在编辑的变形」交给
   * `splitWarp*`，拿回新的 `mesh` 继续编辑。
   */
  const [meshSession, setMeshSession] = useState<{ rect: TransformRect; mesh: WarpMesh } | null>(null);
  /**
   * 网格编辑是**显式**进入的：选中「变形」不会自己把网格铺到画布上。
   *
   * 变形入口既有预设样式（`style`/`bend`）也有自由网格，两者是同一个命令的两种输入法。
   * 自动铺网格会让只想用预设的人一选就被虚线框盖住，所以由按钮决定进哪一种。
   */
  const [meshEditing, setMeshEditing] = useState(false);
  const visible = workflows.filter((workflow) => groups.includes(workflow.group));
  const current = visible.find((workflow) => workflow.id === selected) ?? visible[0];
  // 目标图层框来自视图模型；没有目标图层或控制器只暴露了最小面时按「没有框」处理。
  const transformFrame = typeof controller.currentView === "function"
    ? controller.currentView().document?.transformFrame ?? null
    : null;
  const warpAvailable = current?.id === "warp" && current.allowed && !readonly && transformFrame !== null;
  const warpEditing = warpAvailable && meshEditing;
  const meshChanged = meshSession ? !isIdentityWarpMesh(meshSession.mesh, meshSession.rect) : false;

  // 换入口就退出网格编辑：网格只属于「变形」这一步，切到别的命令后不该继续占用画布。
  useEffect(() => { setMeshEditing(false); }, [current?.id]);

  /**
   * 进入/退出变形网格编辑：进入时以目标图层框铺一张单位网格，退出时让出槽位。
   *
   * 图层框变了（换图层、被别的命令改动）就重建单位网格——但只在没有未应用改动时才重建，
   * 否则用户拖到一半切了个视图就把网格重置了。这里以 `rect` 相等作为「同一个目标」的判据。
   */
  useEffect(() => {
    if (!warpEditing || transformFrame === null) {
      releaseCompositionOverlay("composition.warp");
      setMeshSession(null);
      return;
    }
    const sameTarget = meshSession !== null
      && meshSession.rect.every((value, index) => value === transformFrame[index]);
    if (!sameTarget) setMeshSession({ rect: transformFrame, mesh: identityWarpMesh(transformFrame) });
  }, [warpEditing, transformFrame?.[0], transformFrame?.[1], transformFrame?.[2], transformFrame?.[3]]);

  // 网格状态变化即发布：叠加层与面板共用同一份 mesh。
  useEffect(() => {
    if (!meshSession) {
      releaseCompositionOverlay("composition.warp");
      return;
    }
    publishCompositionOverlay({
      active: "warp",
      rect: meshSession.rect,
      mesh: meshSession.mesh,
      showMesh: true,
      onMeshChange: (mesh) => setMeshSession((session) => session ? { ...session, mesh } : session),
      // 松手不直接提交：变形通常要拖多次点，自动提交会变成一串历史。只把改动留在会话里，
      // 由面板上的「应用变形 / 重置网格」决定何时写回内核。
      onApply: () => {},
      onSplit: (at) => {
        // `at` 是**文档坐标**（内核按 warp bounds 反解参数），直接把画布点交给上游。
        const inline = { style: "custom", bounds: meshSession.rect, mesh: meshSession.mesh };
        const result = controller.features.composition.runWorkflow("splitWarpCrosswise", { at, warp: inline });
        if (!result.ok) { setMessage(messageOf(result)); return; }
        const next = (result.value as { warp?: { mesh?: WarpMesh } } | null)?.warp?.mesh;
        if (next) setMeshSession((session) => session ? { ...session, mesh: next } : session);
        else setMessage("分割后内核没有返回新网格");
      }
    }, "composition.warp");
    // 依赖整个会话而不是网格的「形状」：拖点时点数、块数都不变，只看形状就不会重发布，
    // 画布上会停在旧网格。会话对象只在真正改动时才换新引用，因此不会每帧重发。
  }, [meshSession, warpEditing]);
  useEffect(() => () => releaseCompositionOverlay("composition.warp"), []);

  /**
   * 执行一个入口，并维护「正在编辑的变形」会话。
   *
   * `session` 给的是界面自己构造的 warp（画布网格提交时用）：`edit.transform.warp` 不回传 warp，
   * 若这里把它清掉，紧接着的「网格分割」就会退化成「去找活动智能对象」而在普通像素层上失败。
   */
  const run = (id: string, params: Record<string, unknown>, session?: unknown) => {
    const result = controller.features.composition.runWorkflow(id, params);
    setMessage(result.ok ? null : messageOf(result));
    if (!result.ok) return;
    if (session !== undefined) { setWarpSession(session); return; }
    // 建立或更新变形会话：`warpGrid` / `splitWarp*` 的返回里带 `warp` 时以新的为准。
    const returned = (result.value as { warp?: unknown } | null)?.warp;
    if (returned !== undefined) setWarpSession(returned);
    else if (id === "warp") setWarpSession(undefined);
  };

  if (typeof controller.features.composition?.workflowManifest !== "function"
    || typeof controller.features.composition?.runWorkflow !== "function") return null;
  if (visible.length === 0) return null;

  return (
    <section className="photo-editor__advanced-group" aria-label="构图工作流" data-composition-workflows="true">
      <span className="photo-editor__options-title">工作流</span>
      <label>
        操作
        <select value={current?.id ?? ""} disabled={readonly} onChange={(event) => setSelected(event.currentTarget.value)}>
          {visible.map((workflow) => (
            <option key={workflow.id} value={workflow.id} disabled={!workflow.allowed}>
              {workflow.label}{workflow.allowed ? "" : `（${workflow.reason ?? "尚未接通"}）`}
            </option>
          ))}
        </select>
      </label>
      {current ? <WorkflowForm key={current.id} workflow={current} readonly={readonly} warp={warpSession} onRun={(params) => run(current.id, params)} onError={setMessage} /> : null}
      {warpAvailable ? (
        <div className="photo-editor__options-group" data-warp-session="true">
          <span className="photo-editor__options-title">画布网格</span>
          <Button size="sm" tone={meshEditing ? "ghost" : "primary"}
            onClick={() => setMeshEditing((value) => !value)}>
            {meshEditing ? "退出网格编辑" : "在画布上编辑网格"}
          </Button>
          {meshEditing && meshSession ? (
            <span className="photo-editor__option-hint">拖动控制点调整网格，双击分割块</span>
          ) : (
            <span className="photo-editor__option-hint">用上面的样式与弯曲，或在画布上逐点拖网格</span>
          )}
          {meshEditing && meshSession ? (
            <>
              <Button size="sm" disabled={meshChanged === false}
                onClick={() => {
                  const params = meshParamsFor(meshSession.mesh, meshSession.rect);
                  if (isParamError(params)) { setMessage(params.error); return; }
                  // 把刚应用的这份网格记为「正在编辑的变形」，后续网格分割才能接着用它。
                  run("warp", params, { style: "custom", bounds: meshSession.rect, mesh: meshSession.mesh });
                  // 已写回内核：网格回到「单位网格」语义，再拖就是新一次变形。
                  setMeshSession({ rect: meshSession.rect, mesh: identityWarpMesh(meshSession.rect) });
                }}>应用变形</Button>
              <Button size="sm" tone="ghost"
                onClick={() => setMeshSession({ rect: meshSession.rect, mesh: identityWarpMesh(meshSession.rect) })}>重置网格</Button>
              <span className="photo-editor__option-hint">{meshChanged ? "网格已改动，待应用" : "网格未改动"}</span>
            </>
          ) : null}
        </div>
      ) : null}
      {groups.includes("structure") ? <CompositionExportActions controller={controller} readonly={readonly} onMessage={setMessage} /> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

/**
 * 画板 / 切片导出（U56）。
 *
 * 范围与命名由内核计划给出（含同名去重），字节由内核编码，落盘走宿主端口。没有宿主端口时
 * 按钮禁用并说明原因，而不是点下去才失败。
 */
function CompositionExportActions({ controller, readonly, onMessage }: {
  controller: EditorWorkspaceController;
  readonly: boolean;
  onMessage: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState<null | "slices" | "artboards">(null);
  const [status, setStatus] = useState<string | null>(null);
  const available = typeof controller.canDeliverFiles === "function" && controller.canDeliverFiles();
  const exportKind = async (kind: "slices" | "artboards") => {
    setBusy(kind);
    setStatus(null);
    onMessage(null);
    const result = await controller.exportCompositionArtifacts(kind);
    setBusy(null);
    if (!result.ok) {
      onMessage(result.message);
      return;
    }
    const files = result.value.delivered;
    setStatus(
      `已导出 ${files.length} 个${kind === "slices" ? "切片" : "画板"}：${files.join("、")}`
      + (result.value.written ? "" : "（已发起下载，尚未确认写入磁盘）")
    );
  };
  const disabled = readonly || !available || busy !== null;
  return (
    <div className="photo-editor__options-group" data-composition-export="true">
      <span className="photo-editor__options-title">导出</span>
      <Button size="sm" disabled={disabled} title={available ? undefined : "当前宿主不支持本地文件保存"}
        onClick={() => { void exportKind("slices"); }}>
        {busy === "slices" ? "正在导出切片…" : "导出切片"}
      </Button>
      <Button size="sm" disabled={disabled} title={available ? undefined : "当前宿主不支持本地文件保存"}
        onClick={() => { void exportKind("artboards"); }}>
        {busy === "artboards" ? "正在导出画板…" : "导出画板"}
      </Button>
      {!available ? <span className="photo-editor__option-hint">当前宿主不支持本地文件保存，导出不可用。</span> : null}
      {status ? <span className="photo-editor__option-hint">{status}</span> : null}
    </div>
  );
}

function WorkflowForm({ workflow, readonly, warp, onRun, onError }: {
  workflow: CompositionWorkflow;
  readonly: boolean;
  warp?: unknown;
  onRun: (params: Record<string, unknown>) => void;
  onError: (message: string) => void;
}) {
  // 能力门失败即禁用：清单缺失（`undefined`）同样按未开放处理。
  const disabled = readonly || !isWorkflowEnabled(workflow);
  switch (workflow.id) {
    case "perspectiveWarp":
      return <PerspectiveWarpForm disabled={disabled} onRun={onRun} onError={onError} />;
    case "puppetWarp":
      return <PuppetWarpForm disabled={disabled} onRun={onRun} onError={onError} />;
    default:
      return <FieldWorkflowForm workflow={workflow} disabled={disabled} warp={warp} onRun={onRun} onError={onError} />;
  }
}

/** 声明式字段表单：字段表来自 `workflow-form.ts`。 */
function FieldWorkflowForm({ workflow, disabled, warp, onRun, onError }: {
  workflow: CompositionWorkflow;
  disabled: boolean;
  warp?: unknown;
  onRun: (params: Record<string, unknown>) => void;
  onError: (message: string) => void;
}) {
  const fields = workflowFields(workflow.id);
  const [values, setValues] = useState<FieldValues>(() => defaultValues(workflow.id));

  const set = (key: string, value: FieldValue) => setValues((current) => ({ ...current, [key]: value }));
  const submit = () => {
    const params = compileWorkflow(workflow.id, values, undefined, warp);
    if (isParamError(params)) { onError(params.error); return; }
    onRun(params);
  };

  return (
    <div className="photo-editor__options-group" data-workflow-form={workflow.id}>
      {!workflow.allowed ? <span className="photo-editor__option-hint">{workflow.reason}</span> : null}
      {fields.length === 0 ? <span className="photo-editor__option-hint">这个入口没有参数。</span> : null}
      {fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={values[field.key]}
          disabled={disabled}
          onChange={(value) => set(field.key, value)}
        />
      ))}
      <Button size="sm" disabled={disabled} onClick={submit}>执行</Button>
      {workflow.command ? <span className="photo-editor__option-hint">命令：{workflow.command}</span> : null}
    </div>
  );
}

function Field({ field, value, disabled, onChange }: {
  field: WorkflowField;
  value: FieldValue | undefined;
  disabled: boolean;
  onChange: (value: FieldValue) => void;
}) {
  if (field.kind === "check") {
    return (
      <label>
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
        {field.label}
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label>
        {field.label}
        <select value={typeof value === "string" ? value : ""} disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}>
          <option value="">（默认）</option>
          {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    );
  }
  if (field.kind === "color") {
    return (
      <label>
        {field.label}
        <input type="color" value={typeof value === "string" ? value : "#000000"} disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)} />
      </label>
    );
  }
  if (field.kind === "number") {
    return (
      <label>
        {field.label}
        <input type="number" min={field.min} max={field.max} step={field.step} placeholder={field.placeholder}
          value={typeof value === "number" ? value : ""} disabled={disabled}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            // 清空要真的回到「没填」，而不是当成 0。
            if (raw === "") { onChange(""); return; }
            onChange(Number(raw));
          }} />
        {field.unit}
      </label>
    );
  }
  return (
    <label>
      {field.label}
      <input type="text" placeholder={field.placeholder} value={typeof value === "string" ? value : ""}
        disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

/** 透视变形：拖动后的四角 + 可选源框与拉直方式。 */
function PerspectiveWarpForm({ disabled, onRun, onError }: {
  disabled: boolean;
  onRun: (params: Record<string, unknown>) => void;
  onError: (message: string) => void;
}) {
  const [quad, setQuad] = useState<PerspectiveCorners>([[0, 0], [100, 0], [100, 100], [0, 100]]);
  // 源框用角点（与上游 `rect` 同义）；界面按左上/右下两组数字输入。
  const [rect, setRect] = useState<[number, number, number, number]>([0, 0, 100, 100]);
  const [useRect, setUseRect] = useState(false);
  const [straighten, setStraighten] = useState<"" | "horizontal" | "vertical" | "auto">("");
  const valid = isValidPerspectiveQuad(quad);
  const setCorner = (index: number, axis: 0 | 1, value: number) => {
    setQuad((current) => current.map((corner, position) => position === index
      ? (axis === 0 ? [value, corner[1]] : [corner[0], value]) as [number, number]
      : corner) as PerspectiveCorners);
  };
  return (
    <div className="photo-editor__options-group" data-workflow-form="perspectiveWarp">
      {quad.map((corner, index) => (
        <label key={index}>
          {["左上", "右上", "右下", "左下"][index]}
          <input type="number" value={corner[0]} disabled={disabled} onChange={(event) => setCorner(index, 0, Number(event.currentTarget.value))} />
          <input type="number" value={corner[1]} disabled={disabled} onChange={(event) => setCorner(index, 1, Number(event.currentTarget.value))} />
        </label>
      ))}
      <label><input type="checkbox" checked={useRect} disabled={disabled} onChange={(event) => setUseRect(event.currentTarget.checked)} />指定源框（默认整幅画布）</label>
      {useRect ? (["x0", "y0", "x1", "y1"] as const).map((key, index) => (
        <label key={key}>
          {key}
          <input type="number" value={rect[index]} disabled={disabled}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              setRect((current) => current.map((entry, position) => position === index ? value : entry) as [number, number, number, number]);
            }} />
        </label>
      )) : null}
      <label>
        拉直
        <select value={straighten} disabled={disabled} onChange={(event) => setStraighten(event.currentTarget.value as typeof straighten)}>
          <option value="">（不拉直）</option>
          <option value="horizontal">水平</option>
          <option value="vertical">垂直</option>
          <option value="auto">自动</option>
        </select>
      </label>
      <Button size="sm" disabled={disabled || !valid} onClick={() => {
        const params = perspectiveWarpParams(quad, {
          ...(useRect ? { rect } : {}),
          ...(straighten ? { straighten } : {})
        });
        if (isParamError(params)) { onError(params.error); return; }
        onRun(params);
      }}>应用透视变形</Button>
      {!valid ? <span className="photo-editor__option-hint">四角必须构成顺时针凸四边形</span> : null}
    </div>
  );
}

/** 操控变形：钉点列表（源点 + 拖到）与网格选项。 */
function PuppetWarpForm({ disabled, onRun, onError }: {
  disabled: boolean;
  onRun: (params: Record<string, unknown>) => void;
  onError: (message: string) => void;
}) {
  const [pins, setPins] = useState([{ srcX: 50, srcY: 50, dstX: 50, dstY: 50, rotate: 0 }]);
  const [mode, setMode] = useState<(typeof PUPPET_MODES)[number]>("normal");
  const [density, setDensity] = useState<(typeof PUPPET_DENSITY)[number]>("normal");
  const [expansion, setExpansion] = useState(2);
  const update = (index: number, key: "srcX" | "srcY" | "dstX" | "dstY" | "rotate", value: number) => {
    setPins((current) => current.map((pin, position) => position === index ? { ...pin, [key]: value } : pin));
  };
  return (
    <div className="photo-editor__options-group" data-workflow-form="puppetWarp">
      {pins.map((pin, index) => (
        <div key={index} className="photo-editor__options-group">
          <span className="photo-editor__option-hint">钉点 {index + 1}</span>
          <label>源 X<input type="number" value={pin.srcX} disabled={disabled} onChange={(event) => update(index, "srcX", Number(event.currentTarget.value))} /></label>
          <label>源 Y<input type="number" value={pin.srcY} disabled={disabled} onChange={(event) => update(index, "srcY", Number(event.currentTarget.value))} /></label>
          <label>拖到 X<input type="number" value={pin.dstX} disabled={disabled} onChange={(event) => update(index, "dstX", Number(event.currentTarget.value))} /></label>
          <label>拖到 Y<input type="number" value={pin.dstY} disabled={disabled} onChange={(event) => update(index, "dstY", Number(event.currentTarget.value))} /></label>
          <label>旋转<input type="number" step={1} value={pin.rotate} disabled={disabled} onChange={(event) => update(index, "rotate", Number(event.currentTarget.value))} />°</label>
          <Button size="sm" tone="ghost" disabled={disabled || pins.length === 1}
            onClick={() => setPins((current) => current.filter((_, position) => position !== index))}>删除钉点</Button>
        </div>
      ))}
      <Button size="sm" tone="ghost" disabled={disabled}
        onClick={() => setPins((current) => [...current, { srcX: 50, srcY: 50, dstX: 50, dstY: 50, rotate: 0 }])}>添加钉点</Button>
      <label>
        模式
        <select value={mode} disabled={disabled} onChange={(event) => setMode(event.currentTarget.value as typeof mode)}>
          {PUPPET_MODES.map((value: string) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>
        密度
        <select value={density} disabled={disabled} onChange={(event) => setDensity(event.currentTarget.value as typeof density)}>
          {PUPPET_DENSITY.map((value: string) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>网格扩张<input type="number" min={-200} max={200} value={expansion} disabled={disabled} onChange={(event) => setExpansion(Number(event.currentTarget.value))} />px</label>
      <Button size="sm" disabled={disabled} onClick={() => {
        const params = puppetWarpParams(pins.map(puppetPinOf), { mode, density, expansion });
        if (isParamError(params)) { onError(params.error); return; }
        onRun(params);
      }}>应用操控变形</Button>
    </div>
  );
}
