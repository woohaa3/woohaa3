/**
 * 片场「拍摄镜头」管理工作区
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 6.5 / design D8/D9）。
 *
 * 把原来的「动画片段」控件升级为拍摄镜头管理：静态/动态两类镜头各自的操作、显式类型转换与
 * 转换影响提示、空集合状态。所有写入仍走 `filmSet.clipPatch`（含字段 precondition），选择是
 * **本地** playback 状态，不写持久 `defaultClipId` 或 canonical 之外的任何数据。
 *
 * 机器协议沿用 `clip`（clipId/clipPatch），产品文案统一称「拍摄镜头」。
 */
import { Button, IconButton, Popover, PlusIcon, EllipsisIcon } from "@woohaa3/frontend/extension-api";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import {
  clipConversionImpact,
  createMotionSnapshot,
  decodeFilmSetNodeData,
  filmSetAnimationsOf,
  filmSetBackdropIsCustom,
  filmSetClipPrecondition,
  isFilmSetShotKind,
  readFilmSetBackdrop,
  type FilmSetAnimationClip,
  type FilmSetClipPatchOp,
  type FilmSetShotKind
} from "@woohaa3/contracts";

/** 新建动态镜头的默认时长（秒；静态转动态的兜底值与之一致）。 */
const DEFAULT_DYNAMIC_DURATION = 5;

/** 自定义背景的合法六位 hex；非法时退回黑色（颜色输入始终是合法值）。 */
function customBackdropValid(value: string): string {
  return readFilmSetBackdrop(value).ok ? value.toLowerCase() : "#000000";
}

function kindLabel(kind: FilmSetShotKind): string {
  return kind === "static" ? "静态镜头" : "动态镜头";
}

export function FilmSetAnimationControls({ ctx, nodeId, writable, cameraId, composition, compositionOpen, onCompositionOpenChange }: {
  ctx: Context; nodeId: string; writable: boolean; cameraId: string | null; composition?: ReactNode;
  compositionOpen?: boolean; onCompositionOpenChange?: (open: boolean) => void;
}) {
  const [menu, setMenu] = useState<"create" | "more" | null>(null);
  useSyncExternalStore(ctx.compositeAssets.subscribe, ctx.compositeAssets.getRevision, ctx.compositeAssets.getRevision);
  const canvasState = useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
  const playback = useSyncExternalStore(ctx.filmSetPlayback.subscribe, ctx.filmSetPlayback.getSnapshot, ctx.filmSetPlayback.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [pendingKind, setPendingKind] = useState<FilmSetShotKind | null>(null);
  const [pendingDuration, setPendingDuration] = useState(DEFAULT_DYNAMIC_DURATION);
  /** 镜头背景：跟随主题 / 自定义颜色（D6）。 */
  const [customBackdrop, setCustomBackdrop] = useState("#000000");
  const canvas = canvasState;
  const decoded = decodeFilmSetNodeData(ctx.compositeAssets.projectCanvas(canvas)?.nodeData[nodeId]);
  const animation = decoded.ok ? decoded.value : null;
  const collection = animation ? filmSetAnimationsOf(animation) : null;
  // 选择是本地状态：优先当前本地选中，其次持久默认，最后第一枚镜头（都不写 defaultClipId）。
  const chosen = playback.nodeId === nodeId ? playback.clipId : null;
  const shot = collection?.clips.find(clip => clip.id === chosen) ?? collection?.clips.find(clip => clip.id === collection.defaultClipId) ?? collection?.clips[0];
  useEffect(() => {
    setPendingKind(null);
    setError(null);
    setMenu(null);
  }, [nodeId, shot?.id]);
  useEffect(() => {
    if (playback.nodeId !== nodeId || playback.clipId !== (shot?.id ?? null)) ctx.filmSetPlayback.select(nodeId, shot?.id ?? null);
  }, [nodeId, shot?.id, playback.nodeId, playback.clipId]);
  if (!animation || !collection) return <p role="alert">片场数据无法读取：{decoded.ok ? "定义缺失" : decoded.reason}</p>;

  const mutate = async (op: FilmSetClipPatchOp, id = shot?.id): Promise<boolean> => {
    if (!writable || !id) return false;
    setError(null);
    const result = ctx.canvasSession.submitCommands([{ type: "filmSet.clipPatch", nodeId, clipId: id, op, expectedHash: filmSetClipPrecondition(collection, id, op) }], `web-clip-${crypto.randomUUID()}`);
    if (!result.ok) { setError("拍摄镜头修改未提交，请检查连接和写入权限"); return false; }
    const outcome = await result.handle.settled;
    if (outcome.state === "rejected") { setError(outcome.error ?? "拍摄镜头修改被拒绝，请重新读取后重试"); return false; }
    return true;
  };

  // 新建镜头继承当前所选镜头的背景（D6）。
  const create = async (kind: FilmSetShotKind): Promise<void> => {
    const id = `clip-${crypto.randomUUID()}`;
    const duration = kind === "dynamic" ? DEFAULT_DYNAMIC_DURATION : 0;
    const clip: FilmSetAnimationClip = {
      id,
      name: kind === "dynamic" ? "新动态镜头" : "新静态镜头",
      kind,
      timeline: { duration, loop: false },
      initialCamera: animation.sceneCamera,
      cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }),
      bindings: [],
      ...(shot?.backdrop ? { backdrop: shot.backdrop } : {})
    };
    if (await mutate({ kind: "create", clip }, id)) ctx.filmSetPlayback.select(nodeId, id);
  };

  const replaceComposition = (): void => {
    const camera = ctx.modelWorkspace.session.cameras().find(entry => entry.id === cameraId);
    if (camera) void mutate({ kind: "camera", initialCamera: { azimuth: camera.azimuth, elevation: camera.elevation, distance: camera.distance, aspect: camera.aspect, focusOffset: camera.focusOffset ?? { x: 0, y: 0, z: 0 } } });
  };

  /**
   * 类型转换入口：显式呈现将清除的内容并要求确认（design D8/D9）。
   *
   * 静态→动态：用户给出合法正时长后转换，保留 clipId/构图/预览节点。
   * 动态→静态：含运镜/对象动作/时序时先展示影响清单，确认后才原子清除。
   */
  const requestConvert = (toKind: FilmSetShotKind): void => {
    if (!shot) return;
    if (toKind === "dynamic") { setPendingKind("dynamic"); setPendingDuration(shot.timeline.duration > 0 ? shot.timeline.duration : DEFAULT_DYNAMIC_DURATION); return; }
    const impact = clipConversionImpact(shot);
    if (impact.length === 0) { void mutate({ kind: "set-kind", toKind: "static", confirmClearContent: true }); return; }
    setPendingKind("static");
  };
  const confirmConvert = async (): Promise<void> => {
    if (!shot || !pendingKind) return;
    const toKind = pendingKind;
    const ok = toKind === "dynamic"
      ? await mutate({ kind: "set-kind", toKind, duration: pendingDuration })
      : await mutate({ kind: "set-kind", toKind, confirmClearContent: true });
    if (ok) setPendingKind(null);
  };

  const convertImpact = pendingKind === "static" && shot ? clipConversionImpact(shot) : [];
  const duplicate = () => shot && void mutate({ kind: "duplicate", newClipId: `clip-${crypto.randomUUID()}`, name: `${shot.name.slice(0, 76)} 副本` });
  const remove = () => shot && void mutate({ kind: "delete" });
  const setDefault = () => shot && void mutate({ kind: "set-default" });

  return <section className="film-set-animation-controls" aria-label="拍摄镜头管理">
    <div className="film-set-section-heading">
      <h3>拍摄镜头<span className="film-set-count">{collection.clips.length}</span></h3>
      <div className="film-set-shot-tools">
        <Popover open={menu === "create"} onOpenChange={open => setMenu(open ? "create" : null)} align="end" className="film-set-shot-menu"
          trigger={<IconButton label="新建拍摄镜头" size="sm" tone="ghost" disabled={!writable || collection.clips.length >= 32}><PlusIcon size={16} /></IconButton>}>
          <Button size="sm" tone="ghost" onClick={() => { setMenu(null); void create("static"); }}>新建静态镜头</Button>
          <Button size="sm" tone="ghost" onClick={() => { setMenu(null); void create("dynamic"); }}>新建动态镜头</Button>
        </Popover>
        <Popover open={menu === "more"} onOpenChange={open => setMenu(open ? "more" : null)} align="end" className="film-set-shot-menu"
          trigger={<IconButton label="拍摄镜头操作" size="sm" tone="ghost" disabled={!shot}><EllipsisIcon size={16} /></IconButton>}>
          <Button size="sm" tone="ghost" disabled={!writable || collection.clips.length >= 32} onClick={() => { setMenu(null); duplicate(); }}>复制</Button>
          <Button size="sm" tone="ghost" disabled={!writable || collection.defaultClipId === shot?.id} onClick={() => { setMenu(null); setDefault(); }}>设为默认</Button>
          <Button size="sm" tone="ghost" disabled={!writable} onClick={() => { setMenu(null); requestConvert(shot?.kind === "dynamic" ? "static" : "dynamic"); }}>转为{shot?.kind === "dynamic" ? "静态" : "动态"}镜头</Button>
          <Button size="sm" tone="danger" disabled={!writable} onClick={() => { setMenu(null); remove(); }}>删除</Button>
        </Popover>
      </div>
    </div>
    {collection.clips.length === 0 ? <p className="film-set-object-list__empty">还没有拍摄镜头。新建静态镜头做固定构图，或新建动态镜头加入时长与动作。</p> : null}
    <div className="film-set-shot-picker"><select aria-label="拍摄镜头" value={shot?.id ?? ""} onChange={event => ctx.filmSetPlayback.select(nodeId, event.target.value)}>
      {collection.clips.length === 0 ? <option value="">还没有拍摄镜头</option> : null}
      {collection.clips.map((clip, index) => <option key={clip.id} value={clip.id}>{index + 1}. {clip.name}（{kindLabel(clip.kind)}）{clip.id === collection.defaultClipId ? " · 默认" : ""}</option>)}
    </select>
      <Button size="sm" aria-pressed={playback.preview} disabled={!shot} onClick={() => playback.preview ? ctx.filmSetPlayback.edit() : ctx.filmSetPlayback.preview()}>{playback.preview ? "返回编辑" : "动画预览"}</Button>
    </div>
    {shot ? <>
      <label>名称<input aria-label="拍摄镜头名称" key={shot.id + shot.name} defaultValue={shot.name} maxLength={80} disabled={!writable} onBlur={event => { if (event.target.value.trim() !== shot.name) void mutate({ kind: "rename", name: event.target.value }); }} /></label>
      {shot.kind === "dynamic" ? <>
        <div className="film-set-shot-timing"><label>时长（秒）<input key={shot.id + shot.timeline.duration} type="number" min={0} max={3600} step={0.1} defaultValue={shot.timeline.duration} disabled={!writable} onBlur={event => { const duration = Number(event.target.value); if (duration !== shot.timeline.duration) void mutate({ kind: "timeline", timeline: { ...shot.timeline, duration } }); }} /></label>
        <label><input type="checkbox" checked={shot.timeline.loop} disabled={!writable} onChange={event => void mutate({ kind: "timeline", timeline: { ...shot.timeline, loop: event.target.checked } })} />循环</label></div>
      </> : <p className="film-set-object-hint">静态镜头保持零时长。需要动作或运镜时转换为动态镜头。</p>}
      <div className="film-set-shot-backdrop">
        <label>背景<select aria-label="镜头背景" value={filmSetBackdropIsCustom(shot) ? "custom" : "theme"} disabled={!writable}
          onChange={event => void mutate({ kind: "backdrop", backdrop: event.target.value === "theme" ? "theme" : customBackdropValid(customBackdrop) })}>
          <option value="theme">跟随主题</option><option value="custom">自定义颜色</option>
        </select></label>
        {filmSetBackdropIsCustom(shot) ? <input
          type="color"
          aria-label="镜头背景颜色"
          value={customBackdropValid(shot.backdrop ?? "#000000")}
          disabled={!writable}
          onChange={event => {
            const value = event.target.value;
            setCustomBackdrop(value);
            // 颜色选择器总是给出六位 hex；只接受合法值，非法不写。
            if (readFilmSetBackdrop(value).ok) void mutate({ kind: "backdrop", backdrop: value });
          }}
        /> : null}
      </div>
      <details className="film-set-composition" open={compositionOpen}>
        <summary onClick={onCompositionOpenChange ? event => {
          event.preventDefault();
          onCompositionOpenChange(!compositionOpen);
        } : undefined}>构图<span>{shot.initialCamera.aspect}</span></summary>
        <p className="film-set-object-hint">调整场景视角后，应用到当前拍摄镜头。</p>
        {composition}
        <Button size="sm" disabled={!writable || !cameraId} onClick={replaceComposition}>应用到拍摄镜头</Button>
      </details>
    </> : null}
    {pendingKind ? <div className="film-set-conversion-confirm" role="group" aria-label="类型转换确认">
      <p className="film-set-object-hint">{pendingKind === "static"
        ? `转为静态镜头将清除：${convertImpact.join("、") || "动作与时序"}。`
        : "转为动态镜头需要设置正时长；现有构图与名称保留。"}</p>
      {pendingKind === "dynamic" ? <label>时长（秒）<input type="number" min={0} max={3600} step={0.1} value={pendingDuration} onChange={event => setPendingDuration(Number(event.target.value))} /></label> : null}
      <div className="film-set-animation-actions">
        <Button size="sm" tone="primary" disabled={!writable || (pendingKind === "dynamic" && !(pendingDuration > 0))} onClick={() => void confirmConvert()}>确认转换</Button>
        <Button size="sm" onClick={() => setPendingKind(null)}>取消</Button>
      </div>
    </div> : null}
    {error || playback.error ? <p role="alert">{error ?? playback.error}</p> : null}
  </section>;
}

/** 类型判别守卫的再导出，供测试与调用方复用同一事实源。 */
export { isFilmSetShotKind };
