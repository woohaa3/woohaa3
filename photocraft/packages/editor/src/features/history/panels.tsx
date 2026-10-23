import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { supports } from "../shared/panels.js";
import { fileStem, fromBase64, toBase64 } from "./bytes.js";
import type { ActionsStateView, BatchProgressView, DataSetView, HistorySampleView, HistoryStateView, ScriptReportView, VariableDefView, VariablesStateView } from "./model.js";

/**
 * 历史/动作/数据驱动面板
 * （change: 2026-10-22-add-photocraft-history-automation-workflows）。
 *
 * 面板只通过控制器公开的 `features.history` 访问域会话；端口缺失时**不渲染**（design D11：
 * 端口不可用就禁用入口，而不是调用时抛错）。所有写入都由域会话过草稿门禁并刷新视图，面板
 * 自己不复制文档、历史或命令表。
 *
 * 三条不可替代的界面约束：
 * 1. 清理先展示范围说明，再让用户显式确认——不可恢复的操作不能一键完成；
 * 2. ATN 导入的未知步骤报告必须显示（默认整组回滚时把原因与首个事件说清楚）；
 * 3. 批处理逐文件显示结果，取消按钮在**当前项**结束后生效，界面不假装剩余项跑完了。
 */

type HistorySession = NonNullable<EditorWorkspaceController["features"]["history"]>;

/**
 * 取出域会话，并核对面板要用的那个方法存在。
 *
 * 精简宿主或测试替身可能只实现部分端口：缺哪个方法就只停用用到它的面板（design D11），
 * 而不是让所有面板一起消失，也不是在调用时抛错。
 */
function historySession(controller: EditorWorkspaceController | undefined, method: keyof HistorySession): HistorySession | null {
  if (!controller || !supports(controller, "dispatch")) return null;
  const features = (controller as unknown as { features?: { history?: HistorySession } }).features;
  const session = features?.history;
  if (!session || typeof session[method] !== "function") return null;
  return session;
}

function errorText(result: { ok: boolean; message?: string }): string | null {
  return result.ok ? null : result.message ?? "操作失败";
}

/**
 * 把取样的 RGBA8 画出来。
 *
 * 取样端口返回的是**像素**，只显示「128×128」等于把结果丢掉：用户无法判断这一份源到底是
 * 归档的那一刻还是当前画面，历史画笔的「取错源」就看不出来。这里画到 canvas 上，并且
 * 先核对字节数（`width × height × 4`）——长度对不上时宁可报错，也不把半张图当成整张。
 */
function HistorySamplePreview({ sample }: { sample: HistorySampleView }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const bytes = fromBase64(sample.pixels);
    if (!bytes) {
      setError("取样像素不是合法的 base64");
      return;
    }
    const expected = sample.width * sample.height * 4;
    if (bytes.length !== expected) {
      setError(`取样像素长度不符（期望 ${expected}，收到 ${bytes.length}）`);
      return;
    }
    setError(null);
    // jsdom 没有 2D 上下文：测试环境只核对上面的长度，不要求真的画出来。
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = sample.width;
    canvas.height = sample.height;
    const image = context.createImageData(sample.width, sample.height);
    image.data.set(bytes);
    context.putImageData(image, 0, 0);
  }, [sample]);

  return (
    <div className="photo-editor__row" data-history-sample-preview={`${sample.state}`}>
      <canvas ref={ref} className="photo-editor__history-sample" width={sample.width} height={sample.height} title={`历史源第 ${sample.state + 1} 步`} />
      {error ? <span className="photo-editor__brush-note photo-editor__brush-note--error" data-history-sample-error="true">{error}</span> : null}
    </div>
  );
}

/** 把字节交给宿主交付（浏览器里用下载，等价于「导出到用户选择的文件」）。 */
function download(fileName: string, bytes: Uint8Array, type = "application/octet-stream"): boolean {
  const url = globalThis.URL?.createObjectURL;
  if (!url) return false;
  const href = url(new Blob([bytes as unknown as BlobPart], { type }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.click();
  globalThis.URL.revokeObjectURL?.(href);
  return true;
}

function downloadText(fileName: string, text: string, type = "text/csv"): boolean {
  return download(fileName, new TextEncoder().encode(text), type);
}

/**
 * 解析插入步骤的参数 JSON。
 *
 * 非法输入返回 `null` 而不是 `{}`：把写错的参数当成空对象提交，会静默插入一条与用户意图
 * 不同的步骤。空串按「无参数」处理（等价 `{}`）。
 */
function parseParams(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * `actions.conditional` 支持的条件（与内核 `CONDITIONS` 同序）。
 *
 * 这是**只读列举**：条件是否成立由内核在播放时按当前文档判定，界面不重复实现判定逻辑。
 */
const CONDITIONS = [
  "always", "never", "isOpen", "landscape", "square", "portrait",
  "modeIsRGB", "modeIsCMYK", "modeIsGrayscale", "modeIsLab", "modeIsBitmap",
  "modeIsIndexed", "modeIsDuotone", "modeIsMultichannel",
  "depth8", "depth16", "depth32", "unsaved", "hasSelection", "hasLayers",
  "hasAlphaChannels", "isBackground", "isPixelLayer", "isAdjustmentLayer",
  "isShapeLayer", "isTypeLayer", "isSmartObject", "isLayerGroup", "isLocked",
  "isVisible", "hasPixelMask", "hasVectorMask", "hasEffects"
] as const;

// ------------------------------------------------------------------- U74 历史与快照

/** 历史记录、命名快照与按范围清理（含确认门）。 */
export function HistoryPanel({ controller, readonly, onChanged }: { controller: EditorWorkspaceController; readonly: boolean; onChanged?: () => void }) {
  const session = historySession(controller, "historyState");
  const [view, setView] = useState<HistoryStateView | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // 成功提示与失败原因分开：原先都写进同一个 `data-history-error` 槽，成功也会被渲染成红色
  // 错误行，用户分不清「做成了」还是「失败了」。
  const [notice, setNotice] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ what: string; scope: string; bytes: number; available: boolean; reason: string | null; approximate: boolean } | null>(null);
  const [snapshotName, setSnapshotName] = useState("");
  const [selectedSnapshot, setSelectedSnapshot] = useState<number | null>(null);
  const [snapshotFrom, setSnapshotFrom] = useState<"fullDocument" | "mergedLayers" | "currentLayer">("fullDocument");
  const [newDocState, setNewDocState] = useState<number | null>(null);
  const [newDocName, setNewDocName] = useState("");
  // 删除状态不是「删一行记录」：上游会先退回该状态之前，再清空其后的所有状态（内容回退且不可
  // 重做）。因此和清理一样，必须先把后果说清楚再让用户确认。
  const [pendingDeleteState, setPendingDeleteState] = useState<number | null>(null);
  // 历史源句柄：取样时把取源时的 `epoch` 一起送回去，由内核判定是否仍指向同一个状态。
  // 这是 U74「清理后正确失效历史画笔源」在界面上的可见证据——清理后取样的旧源会被拒绝并
  // 说明原因，而不是悄悄画出新内容。
  const [sourceState, setSourceState] = useState<number | null>(null);
  const [pinnedEpoch, setPinnedEpoch] = useState<string | null>(null);
  const [sample, setSample] = useState<HistorySampleView | null>(null);
  // 历史画笔在**落笔前**只需要问「这个源还能用吗」：走内核的校验但不合成缩略图。
  const [sourceCheck, setSourceCheck] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const result = session.historyState();
    if (result.ok) setView(result.value);
  }, [session, controller]);

  const refresh = () => {
    if (!session) return;
    const result = session.historyState();
    if (result.ok) setView(result.value);
    else setMessage(errorText(result));
    onChanged?.();
  };

  const run = (result: { ok: boolean; message?: string }) => {
    setMessage(errorText(result));
    if (result.ok) { setNotice(null); refresh(); }
  };

  if (!session) return null;

  const target = selectedSnapshot ?? view?.snapshots[0]?.id ?? null;

  const takeSnapshot = () => {
    // `from` 决定快照固定什么内容：整份文档、合并图层或当前图层（与上游语义一致）。
    const params: { name?: string; from?: typeof snapshotFrom } = { from: snapshotFrom };
    if (name.trim()) params.name = name.trim();
    const result = session.newSnapshot(params);
    if (result.ok) setName("");
    run(result);
  };

  const newDocument = () => {
    const params: { state?: number; name?: string } = {};
    if (newDocState !== null) params.state = newDocState;
    if (newDocName.trim()) params.name = newDocName.trim();
    const result = session.newDocumentFromHistory(params);
    if (!result.ok) {
      setNotice(null);
      setMessage(errorText(result));
      return;
    }
    // 内核会切走活动文档；域会话取走字节后已把它关掉，这里交付的是一份独立工程文件。
    // 交付失败（环境不支持下载）也要如实说，不能留下「点了没反应」。
    const created = result.value as { name?: unknown; bytes?: unknown };
    const name = typeof created.name === "string" && created.name ? created.name : "派生文档";
    const bytes = created.bytes instanceof Uint8Array ? created.bytes : new Uint8Array();
    const delivered = download(`${fileStem(name)}.pcraft`, bytes,
      "application/vnd.woohaa.photocraft-project");
    setNewDocName("");
    if (delivered) {
      setMessage(null);
      setNotice(`已新建独立工程「${name}」并交付文件；当前文档未受影响`);
    } else {
      // 交付失败不是「已经建好了」：文档内容确实抽出来了，但用户拿不到文件，必须说清楚。
      setNotice(null);
      setMessage("当前环境不能交付文件，派生工程没有保存");
    }
    refresh();
  };

  const requestPurge = (what: string) => {
    const result = session.purgePlan(what);
    if (!result.ok) {
      setPlan(null);
      setMessage(errorText(result));
      return;
    }
    setMessage(null);
    setPlan({
      what,
      scope: result.value.scope,
      bytes: result.value.bytes,
      // 只有内核**明确**说不可用才收起「确认清理」。缺字段（精简宿主/老运行时）按可用处理，
      // 否则界面会凭空宣布「没有可清理的内容」，把一个本来能清的范围挡住。
      available: result.value.available !== false,
      reason: result.value.reason,
      approximate: result.value.approximate === true
    });
  };

  const confirmPurge = () => {
    if (!plan) return;
    const scope = plan.scope;
    const result = session.purge(plan.what, true);
    setPlan(null);
    // 清理后旧的历史源句柄一律失效：丢掉预览，但**保留**取源时的 epoch。
    // 不把 epoch 清掉是刻意的：一清空，下一次取样就会悄悄改绑到新状态——用户以为还在看
    // 原来那份归档，实际已经换成了别的状态。保留 epoch 后取样会如实报「源已失效」，
    // 要换源必须显式按「重新取源」。
    setSample(null);
    setSourceCheck(null);
    run(result);
    // 成功也必须有回执：确认框一消失就什么都不说，用户无法区分「清掉了」和「点了没反应」
    // ——尤其视频缓存这类清理后列表不变的 0 字节范围。
    if (result.ok) setNotice(`已清理「${scope}」`);
  };

  /**
   * 取样当前历史源。
   *
   * 第一次取样会「记住」当时的 epoch；之后每次都把那个 epoch 送回内核。这样清理/删除状态
   * 之后再次取样会被拒绝，用户看到的是一条明确的「源已失效」而不是一张新图。
   */
  const takeSample = () => {
    if (!session || !view) return;
    // 精简宿主可能没有取样端口：只停用取样，不影响历史面板其余功能。
    if (typeof session.sampleHistory !== "function") {
      setMessage("当前宿主没有历史源取样端口");
      return;
    }
    const epoch = pinnedEpoch ?? view.epoch;
    const params: { epoch: string; state?: number; maxSide?: number } = { epoch, maxSide: 128 };
    if (sourceState !== null) params.state = sourceState;
    const result = session.sampleHistory(params);
    if (!result.ok) {
      setSample(null);
      setNotice(null);
      setMessage(result.message);
      return;
    }
    setPinnedEpoch(epoch);
    setSample(result.value);
    setMessage(null);
    setNotice(null);
  };

  /**
   * 只校验历史源句柄（历史画笔落笔前的检查）。
   *
   * 与取样走**同一套**内核拒绝条件，但不合成像素：过期句柄同样被拒。历史画笔每次落笔都问
   * 一遍也不会分配 RGBA 缓冲，而且判定在内核里，不会出现「界面以为可用、落笔按旧索引取新内容」。
   */
  const checkSource = () => {
    if (!session || !view) return;
    if (typeof session.checkHistorySource !== "function") {
      setMessage("当前宿主没有历史源校验端口");
      return;
    }
    const epoch = pinnedEpoch ?? view.epoch;
    const params: { epoch: string; state?: number } = { epoch };
    if (sourceState !== null) params.state = sourceState;
    const result = session.checkHistorySource(params);
    if (!result.ok) {
      setSourceCheck(null);
      setNotice(null);
      setMessage(result.message);
      return;
    }
    setPinnedEpoch(epoch);
    setSourceCheck(`第 ${result.value.state + 1} 步「${result.value.label}」可用（${result.value.width}×${result.value.height}）`);
    setMessage(null);
    setNotice(null);
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="历史记录与快照" data-history-panel="true">
      <span className="photo-editor__options-title">历史记录</span>
      {view ? (
        <>
          <ol className="photo-editor__history-list" data-history-list="true">
            {view.entries.map((entry) => (
              <li key={`${entry.index}-${entry.label}`} data-history-entry={entry.index} aria-current={entry.current ? "step" : undefined}>
                {entry.label}
                {entry.current ? "（当前）" : null}
              </li>
            ))}
          </ol>
          <p className="photo-editor__brush-note">重做：{view.redo.length ? view.redo.join("、") : "无"}；历史源 {view.epoch.slice(0, 8)}（共 {view.sources.length} 个状态，当前为活文档）</p>
          {/* 历史源句柄：取样会记住取源时的 epoch，清理/删除状态后再取样会被内核拒绝。 */}
          <div className="photo-editor__row">
            <label>取样状态<select value={sourceState ?? "live"} disabled={readonly} data-sample-state
              onChange={(event) => {
                setSourceState(event.currentTarget.value === "live" ? null : Number(event.currentTarget.value));
                setSample(null);
                setSourceCheck(null);
              }}>
              <option value="live">当前状态</option>
              {view.entries.map((entry) => (
                <option key={entry.index} value={entry.index}>{entry.index + 1}. {entry.label}</option>
              ))}
            </select></label>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={takeSample}>取样历史源</Button>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={checkSource} data-history-source-check>检查源可用</Button>
            {pinnedEpoch !== null ? (
              <Button size="sm" tone="ghost" disabled={readonly} onClick={() => { setPinnedEpoch(null); setSample(null); setSourceCheck(null); }}>重新取源</Button>
            ) : null}
          </div>
          {sample ? (
            <>
              <p className="photo-editor__brush-note" data-history-sample={`${sample.state}`}>
                已取样第 {sample.state + 1} 步「{sample.label}」{sample.live ? "（活文档）" : "（归档状态）"}，
                源身份 {sample.epoch.slice(0, 8)}，{sample.width}×{sample.height}
              </p>
              <HistorySamplePreview sample={sample} />
            </>
          ) : null}
          {sourceCheck ? (
            <p className="photo-editor__brush-note" data-history-source-usable="true">{sourceCheck}</p>
          ) : null}
        </>
      ) : <p className="photo-editor__brush-note">读取历史…</p>}

      <label>快照名称<input value={name} placeholder="Snapshot N" disabled={readonly} onChange={(event) => setName(event.currentTarget.value)} /></label>
      <label>快照内容<select value={snapshotFrom} disabled={readonly} data-snapshot-from
        onChange={(event) => setSnapshotFrom(event.currentTarget.value as typeof snapshotFrom)}>
        <option value="fullDocument">整份文档</option>
        <option value="mergedLayers">合并图层</option>
        <option value="currentLayer">当前图层</option>
      </select></label>
      <div className="photo-editor__row">
        <Button size="sm" disabled={readonly} onClick={takeSnapshot}>新建快照</Button>
        <Button size="sm" tone="ghost" disabled={readonly || view === null || view.current === 0}
          onClick={() => view && setPendingDeleteState(view.current)}>删除当前状态…</Button>
      </div>
      {pendingDeleteState !== null ? (
        <div className="photo-editor__advanced-group" role="alertdialog" aria-label="删除状态确认"
          data-delete-state-confirm={pendingDeleteState}>
          <p>删除后文档会退回上一个状态，第 {pendingDeleteState + 1} 步及其后的历史与重做都会丢掉，
            这一步不可撤销。改动过图层后通常用「撤销」而不是删除状态。</p>
          <div className="photo-editor__row">
            <Button size="sm" tone="danger" onClick={() => {
              const state = pendingDeleteState;
              setPendingDeleteState(null);
              run(session.deleteState(state));
            }}>确认删除状态</Button>
            <Button size="sm" tone="ghost" onClick={() => setPendingDeleteState(null)}>取消</Button>
          </div>
        </div>
      ) : null}

      {/* 自历史新建：可以指定入口状态与名称；不给就用当前状态和历史标签。 */}
      <label>自历史状态<select value={newDocState ?? "current"} disabled={readonly} data-new-document-state
        onChange={(event) => setNewDocState(event.currentTarget.value === "current" ? null : Number(event.currentTarget.value))}>
        <option value="current">当前状态</option>
        {(view?.entries ?? []).map((entry) => (
          <option key={entry.index} value={entry.index}>{entry.index + 1}. {entry.label}</option>
        ))}
      </select></label>
      <label>新文档名称<input value={newDocName} placeholder="留空则用状态标签" disabled={readonly}
        onChange={(event) => setNewDocName(event.currentTarget.value)} /></label>
      <div className="photo-editor__row">
        <Button size="sm" tone="ghost" disabled={readonly} onClick={newDocument}>自历史新建文档</Button>
      </div>

      <span className="photo-editor__options-title">命名快照（{view?.snapshots.length ?? 0}）</span>
      {view?.snapshots.length ? (
        <ul className="photo-editor__history-list" data-snapshot-list="true">
          {view.snapshots.map((snapshot) => (
            <li key={snapshot.id} data-snapshot={snapshot.id} aria-current={snapshot.id === target ? "true" : undefined}>
              <span>{snapshot.name}</span>
              <Button size="sm" tone="ghost" disabled={readonly}
                onClick={() => { setSelectedSnapshot(snapshot.id); run(session.selectSnapshot(snapshot.id)); }}>回到</Button>
              <Button size="sm" tone="ghost" disabled={readonly} onClick={() => {
                if (snapshot.id === selectedSnapshot) setSelectedSnapshot(null);
                run(session.deleteSnapshot(snapshot.id));
              }}>删除</Button>
            </li>
          ))}
        </ul>
      ) : <p className="photo-editor__brush-note">还没有快照。</p>}
      <label>重命名<input value={snapshotName} disabled={readonly || target === null}
        placeholder={target === null ? "先建快照" : "输入新名称后回车"}
        onChange={(event) => setSnapshotName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || target === null || !snapshotName.trim()) return;
          run(session.renameSnapshot(target, snapshotName.trim()));
          setSnapshotName("");
        }} /></label>

      <span className="photo-editor__options-title">清理（不可恢复）</span>
      <div className="photo-editor__row">
        {[
          ["undo", "撤销记录"],
          ["clipboard", "剪贴板"],
          ["histories", "所有历史"],
          // 视频缓存也要有入口：命令已进命令门，隐藏它等于让用户以为没有这个范围。
          ["videoCache", "视频缓存"],
          ["all", "全部"],
        ].map(([what, label]) => (
          <Button key={what} size="sm" tone="ghost" disabled={readonly} onClick={() => requestPurge(what)}>{label}</Button>
        ))}
      </div>
      {plan ? (
        <div className="photo-editor__advanced-group" role="alertdialog" aria-label="清理确认" data-purge-confirm={plan.what}>
          {/* 三种情况必须分开说：
              1. 不可用（`available === false`）→ 下面单独说明「没有可清理的内容」；
              2. 可用但字节为 0 → 不是「当前为空」，而是「不会腾出空间但仍会丢掉这些状态」，
                 否则用户以为点确认什么也不会发生，实际撤销栈被清空；
              3. 有字节 → 精确范围说「正好」，`all` 说「约」（形状描边缓存没有公开读数）。 */}
          <p>
            将永久丢弃「{plan.scope}」
            {plan.available && plan.bytes > 0
              ? `（${plan.approximate ? "约" : "正好"} ${Math.max(1, Math.round(plan.bytes / 1024))} KiB）`
              : ""}
            {plan.available && plan.bytes === 0
              ? plan.what === "videoCache"
                ? "（本工程没有视频图层，不会释放空间）"
                : plan.approximate
                  // `all` 里含读不到字节的缓存（形状描边）：0 不等于「没东西可放」，
                  // 不能顺着「共用像素」的理由把实际会释放的空间说成不存在。
                  ? "（部分缓存没有公开大小，实际上仍可能腾出空间）"
                  : "（不会腾出空间：这些状态与更早的状态共用像素）"
              : ""}
            。这一步不可撤销。
          </p>
          {/* `available` 来自内核的前置条件：为空的范围在这里就说清楚，而不是让用户确认后
              才收到 `nothing to purge`。这时只留「取消」，因为没有东西可确认。 */}
          {!plan.available ? (
            <>
              <p className="photo-editor__brush-note" data-purge-unavailable="true">
                这个范围现在没有可清理的内容{plan.reason ? `（${plan.reason}）` : ""}。
              </p>
              <div className="photo-editor__row">
                <Button size="sm" tone="ghost" onClick={() => setPlan(null)}>知道了</Button>
              </div>
            </>
          ) : (
            <div className="photo-editor__row">
              <Button size="sm" tone="danger" onClick={confirmPurge}>确认清理</Button>
              <Button size="sm" tone="ghost" onClick={() => setPlan(null)}>取消</Button>
            </div>
          )}
        </div>
      ) : null}
      {notice ? <p className="photo-editor__brush-note" data-history-notice="true">{notice}</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-history-error="true">{message}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------- U75 动作与 ATN

/** 动作面板：录制/停止、逐步骤预检、播放、动作集与 ATN 字节往返。 */
export function ActionsPanel({ controller, readonly, onChanged }: { controller: EditorWorkspaceController; readonly: boolean; onChanged?: () => void }) {
  const session = historySession(controller, "actionsState");
  const [state, setState] = useState<ActionsStateView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [recordName, setRecordName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<Array<{ event: string; name: string; step: number }>>([]);
  // `.atn` 的解析警告（例如「N 个尾部字节被忽略」）：文件能导入但内容可能不完整，必须说出来。
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  // 跳过导出时被丢掉的步骤：内核会返回 `skipped`，不显示等于让用户以为文件是完整的。
  const [skipped, setSkipped] = useState<Array<{ action: string; step: number; id: string }>>([]);
  const [acceptUnsupported, setAcceptUnsupported] = useState(false);
  const [insertId, setInsertId] = useState("");
  const [insertParams, setInsertParams] = useState("");
  const [condition, setCondition] = useState("always");
  const [actionSet, setActionSet] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [playFrom, setPlayFrom] = useState("");
  const [shortcuts, setShortcuts] = useState<Array<{ action: string; shortcut: string }>>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const readState = (action?: string) => {
    if (!session) return;
    const result = session.actionsState(action ?? selected ?? undefined);
    if (result.ok) {
      setState(result.value);
      if (action) setSelected(action);
    } else setMessage(errorText(result));
  };

  const readShortcuts = () => {
    if (!session || typeof session.actionShortcuts !== "function") return;
    const result = session.actionShortcuts();
    if (result.ok) setShortcuts(result.value);
  };

  useEffect(() => {
    if (!session) return;
    const result = session.actionsState();
    if (result.ok) setState(result.value);
    readShortcuts();
  }, [session, controller]);

  if (!session) return null;

  const refresh = (action?: string) => {
    readState(action);
    onChanged?.();
  };

  const run = (result: { ok: boolean; message?: string }, action?: string) => {
    setNotice(null);
    setMessage(errorText(result));
    if (result.ok) refresh(action);
  };

  const importAtn = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    setSkipped([]);
    const result = session.loadActions({ data: toBase64(bytes), acceptUnsupported });
    if (!result.ok) {
      setImportReport([]);
      setImportWarnings([]);
      setNotice(null);
      setMessage(result.message);
      return;
    }
    setImportReport(result.value.unsupported);
    // 精简宿主的会话可能没有这个字段：缺它按「没有警告」处理，不因缺字段把面板打崩。
    setImportWarnings(result.value.warnings ?? []);
    setMessage(null);
    // 「保留成功但有未知步骤」不是错误：独立一行说明，避免和失败混成同一类提示。
    setNotice(result.value.unsupported.length
      ? `已保留 ${result.value.unsupported.length} 个当前运行时没有等价命令的 Photoshop 步骤；播放会在该步失败`
      : result.value.warnings.length
        ? `已导入，但解析时有 ${result.value.warnings.length} 条警告（文件可能不完整）`
        : null);
    // `actions.load` 还会把 `.atn` 里的功能键绑定写进偏好（内核 `edit_prefs`），
    // 只刷新动作列表会让「快捷键」一栏继续显示导入前的旧绑定。
    refresh(result.value.actions[0]);
    readShortcuts();
  };

  const exportAtn = () => {
    // 含非 Photoshop 等价步骤的动作默认导出会被内核拒绝（会静默丢步骤的导出不能默认开）。
    // 用户必须先看到这条拒绝理由，再用同一勾选框显式同意跳过；不做自动重试。
    setSkipped([]);
    const result = session.saveActions(selected ? { action: selected } : {});
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    const bytes = fromBase64(result.value.data);
    if (!bytes) {
      setMessage("导出的 .atn 不是合法 base64");
      return;
    }
    setMessage(download(`${fileStem(selected ?? "actions")}.atn`, bytes) ? null : "当前环境不能交付文件");
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="动作" data-actions-panel="true">
      <span className="photo-editor__options-title">动作（{state?.actions.length ?? 0}）</span>
      <p className="photo-editor__brush-note">录制中：{state?.recording ?? "无"}</p>
      <ul className="photo-editor__history-list" data-action-list="true">
        {(state?.actions ?? []).map((action) => (
          <li key={action.name} data-action={action.name} aria-current={action.name === selected ? "true" : undefined}>
            <button type="button" className="photo-editor__link" onClick={() => refresh(action.name)}>{action.name}</button>
            <span className="photo-editor__brush-note">{action.steps} 步{action.set ? ` · ${action.set}` : ""}</span>
          </li>
        ))}
      </ul>
      <div className="photo-editor__row">
        <label>名称<input value={recordName} disabled={readonly || state?.recording !== null} onChange={(event) => setRecordName(event.currentTarget.value)} /></label>
        <Button size="sm" disabled={readonly || state?.recording !== null}
          onClick={() => run(session.startRecording(recordName.trim() ? recordName.trim() : undefined))}>录制</Button>
        <Button size="sm" tone="ghost" disabled={readonly || !state?.recording}
          onClick={() => {
            // 停止后选中刚录的那条：否则「播放」「删除」「重命名」和步骤列表都要再点一次
            // 动作名才可用，录制完看起来像「录了但用不了」。
            const recorded = state?.recording;
            run(session.stopRecording(), recorded ?? undefined);
          }}>停止</Button>
        <Button size="sm" disabled={readonly || !selected} onClick={() => selected && run(session.playAction(selected))}>播放</Button>
        <Button size="sm" tone="ghost" disabled={readonly || !selected}
          onClick={() => selected && run(session.actionCommand("actions.delete", { action: selected }))}>删除动作</Button>
      </div>
      <div className="photo-editor__row">
        <label>从第几步播放<input value={playFrom} disabled={readonly || !selected} placeholder="空=从头" style={{ width: "5rem" }}
          onChange={(event) => setPlayFrom(event.currentTarget.value.replace(/[^0-9]/g, ""))} /></label>
        <Button size="sm" tone="ghost" disabled={readonly || !selected} onClick={() => {
          if (!selected) return;
          // 空输入是「从头播放」，不是第 0 步之外的特殊语义；只有填了数字才传 `from`。
          const from = playFrom.trim() === "" ? undefined : Number(playFrom);
          run(session.playAction(selected, from));
        }}>从该步播放</Button>
        <label>重命名为<input value={renameTo} disabled={readonly || !selected} placeholder={selected ?? "先选动作"}
          onChange={(event) => setRenameTo(event.currentTarget.value)} /></label>
        <Button size="sm" tone="ghost" disabled={readonly || !selected || !renameTo.trim()} onClick={() => {
          if (!selected) return;
          run(session.actionCommand("actions.rename", { action: selected, name: renameTo.trim() }), renameTo.trim());
          setRenameTo("");
        }}>重命名</Button>
      </div>

      {state?.detail ? (
        <div data-action-detail={state.detail.name}>
          <span className="photo-editor__options-title">步骤与预检</span>
          <ol className="photo-editor__history-list" data-action-steps="true">
            {state.detail.steps.map((step, index) => {
              const check = state.preflight?.steps.find((entry) => entry.step === index);
              const off = state.detail!.disabled.includes(index);
              const dialog = state.detail!.dialogs.includes(index);
              return (
                <li key={`${index}-${step.id}`} data-step={index} data-playable={check?.playable !== false} data-disabled={off}>
                  {check?.playable === false ? "⚠ " : ""}{step.id}
                  {off ? <span className="photo-editor__brush-note">（播放时跳过）</span> : null}
                  {dialog ? <span className="photo-editor__brush-note">（显示对话框）</span> : null}
                  {check?.reason ? <span className="photo-editor__brush-note">（{check.reason}）</span> : null}
                  <Button size="sm" tone="ghost" disabled={readonly}
                    onClick={() => run(session.actionCommand("actions.toggle", { action: state.detail!.name, step: index }), state.detail!.name)}>{off ? "启用" : "停用"}</Button>
                  <Button size="sm" tone="ghost" disabled={readonly}
                    onClick={() => run(session.actionCommand("actions.dialog", { action: state.detail!.name, step: index }), state.detail!.name)}>{dialog ? "取消对话框" : "加对话框"}</Button>
                  <Button size="sm" tone="ghost" disabled={readonly}
                    onClick={() => run(session.actionCommand("actions.delete", { action: state.detail!.name, step: index }), state.detail!.name)}>删除</Button>
                  <Button size="sm" tone="ghost" disabled={readonly || index === 0}
                    onClick={() => run(session.actionCommand("actions.move", { action: state.detail!.name, step: index, to: index - 1 }), state.detail!.name)}>上移</Button>
                  <Button size="sm" tone="ghost" disabled={readonly || index === state.detail!.steps.length - 1}
                    onClick={() => run(session.actionCommand("actions.move", { action: state.detail!.name, step: index, to: index + 1 }), state.detail!.name)}>下移</Button>
                </li>
              );
            })}
          </ol>
          {state.preflight && !state.preflight.playable
            ? <p className="photo-editor__brush-note photo-editor__brush-note--error">有 {state.preflight.blocked.length} 步不可播放，播放会整组拒绝。</p>
            : null}

          {/* 插入步骤与条件：都是会话状态编辑，不改文档内容。 */}
          <div className="photo-editor__row">
            <label>插入命令<input value={insertId} disabled={readonly} placeholder="layer.new.layer"
              onChange={(event) => setInsertId(event.currentTarget.value)} /></label>
            <label>参数 JSON<input value={insertParams} disabled={readonly} placeholder="{}"
              onChange={(event) => setInsertParams(event.currentTarget.value)} /></label>
            <Button size="sm" disabled={readonly || !insertId.trim()} onClick={() => {
              const params = parseParams(insertParams);
              if (params === null) {
                setMessage("参数必须是 JSON 对象");
                return;
              }
              run(session.actionCommand("actions.insert", { action: state.detail!.name, id: insertId.trim(), params }), state.detail!.name);
              setInsertId("");
              setInsertParams("");
            }}>插入步骤</Button>
          </div>
          <div className="photo-editor__row">
            <label>条件<select value={condition} disabled={readonly} onChange={(event) => setCondition(event.currentTarget.value)}>
              {CONDITIONS.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select></label>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={() => {
              // 条件会**播放命中的分支**，因此走域会话的写入路径（草稿门禁 + 刷新视图），
              // 不走 `actionCommand`：后者把结果当成纯会话状态，界面会显示旧文档。
              const result = session.testCondition({ if: condition, then: state.detail!.name, else: null });
              setMessage(errorText(result));
              if (result.ok) {
                setNotice(result.value.holds
                  ? `条件 ${condition} 成立，已播放「${result.value.played}」`
                  : `条件 ${condition} 不成立，没有播放分支`);
                refresh(state.detail!.name);
              }
            }}>测试条件</Button>
          </div>
          <div className="photo-editor__row">
            <label>动作集<input value={actionSet} disabled={readonly} placeholder="常用"
              onChange={(event) => setActionSet(event.currentTarget.value)} /></label>
            <Button size="sm" tone="ghost" disabled={readonly} onClick={() => {
              run(session.actionCommand("actions.assignSet", {
                action: state.detail!.name,
                set: actionSet.trim() ? actionSet.trim() : null,
              }), state.detail!.name);
            }}>归入动作集</Button>
            <label>按钮颜色<select value={state.detail.color} disabled={readonly} data-action-color
              onChange={(event) => run(session.actionCommand("actions.setColor", {
                action: state.detail!.name, color: event.currentTarget.value,
              }), state.detail!.name)}>
              {["", "red", "orange", "yellow", "green", "blue", "violet", "gray"]
                .map((entry) => <option key={entry || "none"} value={entry}>{entry || "无"}</option>)}
            </select></label>
          </div>
        </div>
      ) : null}

      {/* 快捷键：只显示，不在这里改绑（改绑属共享快捷键宿主）。 */}
      <span className="photo-editor__options-title">快捷键</span>
      {shortcuts.length ? (
        <ul className="photo-editor__history-list" data-shortcut-list="true">
          {shortcuts.map((entry) => (
            <li key={entry.action} data-shortcut-action={entry.action}><span>{entry.action}</span><kbd className="photo-editor__shortcut">{entry.shortcut}</kbd></li>
          ))}
        </ul>
      ) : <p className="photo-editor__brush-note">还没有动作快捷键绑定。</p>}

      <span className="photo-editor__options-title">ATN</span>
      <input ref={fileInput} type="file" accept=".atn,application/octet-stream" hidden data-atn-file
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) await importAtn(file);
        }} />
      <label><input type="checkbox" checked={acceptUnsupported} disabled={readonly} onChange={(event) => setAcceptUnsupported(event.currentTarget.checked)} />保留无等价命令的 Photoshop 步骤</label>
      <div className="photo-editor__row">
        <Button size="sm" disabled={readonly} onClick={() => fileInput.current?.click()}>导入 .atn…</Button>
        <Button size="sm" tone="ghost" disabled={readonly} onClick={exportAtn}>导出 .atn…</Button>
        <Button size="sm" tone="ghost" disabled={readonly || !selected}
          title="跳过没有 Photoshop 等价命令的步骤后导出；导出的 .atn 会缺少这些步骤"
          onClick={() => {
            if (!selected) return;
            // 跳过导出是**独立动作**：它产出的 .atn 少了步骤，不能和普通导出走同一个按钮，
            // 否则用户在不知情时就会得到一份「看着导出成功、实际少了几步」的文件。
            const result = session.saveActions({ action: selected, skipUnsupported: true });
            if (!result.ok) { setMessage(result.message); return; }
            const bytes = fromBase64(result.value.data);
            if (!bytes) { setMessage("导出的 .atn 不是合法 base64"); return; }
            // 被跳过的步骤逐条说出来：这份文件确实少了这些步骤，用户要能核对。
            setNotice(null);
            setImportReport([]);
            setSkipped(result.value.skipped);
            setMessage(download(`${fileStem(selected)}.atn`, bytes) ? null : "当前环境不能交付文件");
          }}>跳过无等价步骤导出…</Button>
      </div>
      {importReport.length ? (
        <ul className="photo-editor__history-list" data-atn-unsupported="true">
          {importReport.map((step) => (
            <li key={`${step.step}-${step.event}`}>第 {step.step + 1} 步：{step.name}（{step.event}）没有等价命令</li>
          ))}
        </ul>
      ) : null}
      {importWarnings.length ? (
        <ul className="photo-editor__history-list" data-atn-warnings="true">
          {importWarnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      {skipped.length ? (
        <ul className="photo-editor__history-list" data-atn-skipped="true">
          {skipped.map((step) => (
            <li key={`${step.action}-${step.step}-${step.id}`}>{step.action} 第 {step.step + 1} 步：{step.id} 没有等价命令，已从导出的 .atn 中省略</li>
          ))}
        </ul>
      ) : null}
      {notice ? <p className="photo-editor__brush-note" data-actions-notice="true">{notice}</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-actions-error="true">{message}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------- U76 变量与数据集

/**
 * 变量定义：把图层绑定到变量，供数据集按列填值。
 *
 * **`image.variables.define` 是「替换整份定义」而不是「追加一条」**（上游 `set_vars` 直接赋值
 * `defs`），所以这里每次都用「当前定义 + 这次改动」的**完整列表**提交；只发新增那一条会把
 * 先前的变量一起丢掉。这正是必须在面板层处理、不能让用户自己拼参数的地方。
 */
function VariableEditor({ session, readonly, defs, layers, onChanged, onMessage }: {
  session: HistorySession;
  readonly: boolean;
  defs: VariableDefView[];
  layers: Array<{ id: number; name: string }>;
  onChanged: () => void;
  onMessage: (value: string | null) => void;
}) {
  const [name, setName] = useState("");
  // 新建变量只允许三种已知种类（`VariableDefView["kind"]` 还含 `null`，那是解码出的未知种类）。
  const [kind, setKind] = useState<"visibility" | "textReplacement" | "pixelReplacement">("visibility");
  const [layer, setLayer] = useState<number | null>(null);
  const [method, setMethod] = useState("fit");
  const [align, setAlign] = useState("center");
  const [clip, setClip] = useState(false);

  const target = layer ?? layers[0]?.id ?? null;

  /** 把一条 def 列表提交给内核（整份替换语义）。 */
  const commit = (next: Array<Record<string, unknown>>) => {
    const result = session.defineVariables(next);
    onMessage(errorText(result));
    if (result.ok) onChanged();
  };

  /**
   * 把「现有定义」还原成内核参数。
   *
   * 必须带上像素变量的 `method`/`align`/`clip`：`define` 是整份替换，漏掉就等于把用户设过的
   * 选项重置成默认值（`fit`/`center`/无裁切）。
   */
  const asParams = (entry: VariableDefView): Record<string, unknown> => {
    const params: Record<string, unknown> = { name: entry.name, layer: entry.layer, type: entry.kind };
    if (entry.kind === "pixelReplacement") {
      if (entry.method) params.method = entry.method;
      if (entry.align) params.align = entry.align;
      if (entry.clip !== undefined) params.clip = entry.clip;
    }
    return params;
  };

  /**
   * 存在本客户端不认识的变量种类时，**不允许**重发整份定义。
   *
   * `define` 是整份替换：猜一个种类写回去等于把用户的变量改坏（例如把未来版本的「图层样式」
   * 变量改成显隐）。宁可拒绝并说明，也不要静默损坏工程。
   */
  const unknown = defs.filter((entry) => entry.kind === null);
  const blocked = unknown.length > 0
    ? `有 ${unknown.length} 个变量的种类本版本不认识（${unknown.map((entry) => `\`${entry.name}\`：${entry.rawKind ?? "未知"}`).join("、")}）；`
      + "改动定义会整份重发，可能把它们改坏，因此已停用。请用支持这些种类的新版本编辑。"
    : null;

  const add = () => {
    if (blocked) {
      onMessage(blocked);
      return;
    }
    if (target === null) {
      onMessage("先选择要绑定的图层");
      return;
    }
    if (!name.trim()) {
      onMessage("变量需要一个名字");
      return;
    }
    if (defs.some((def) => def.name === name.trim())) {
      // 内核也会拒绝重名，但提前说明比让它报「duplicate variable」更直接。
      onMessage(`变量 \`${name.trim()}\` 已存在`);
      return;
    }
    const def: Record<string, unknown> = { name: name.trim(), layer: target, type: kind };
    if (kind === "pixelReplacement") {
      def.method = method;
      def.align = align;
      def.clip = clip;
    }
    commit([
      ...defs.map(asParams),
      def
    ]);
    setName("");
  };

  const remove = (variable: string) => {
    if (blocked) {
      onMessage(blocked);
      return;
    }
    commit(defs.filter((entry) => entry.name !== variable).map(asParams));
  };

  return (
    <div data-variable-editor="true">
      <div className="photo-editor__row">
        <label>名称<input value={name} disabled={readonly} placeholder="showTitle"
          onChange={(event) => setName(event.currentTarget.value)} /></label>
        <label>图层<select value={target ?? ""} disabled={readonly || layers.length === 0}
          onChange={(event) => setLayer(Number(event.currentTarget.value))}>
          {layers.length === 0 ? <option value="">没有图层</option> : null}
          {layers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        <label>种类<select value={kind} disabled={readonly}
          onChange={(event) => setKind(event.currentTarget.value as typeof kind)}>
          <option value="visibility">显隐</option>
          <option value="textReplacement">文字替换</option>
          <option value="pixelReplacement">像素替换</option>
        </select></label>
        <Button size="sm" disabled={readonly || layers.length === 0 || blocked !== null} onClick={add}>添加变量</Button>
      </div>
      {kind === "pixelReplacement" ? (
        <div className="photo-editor__row">
          <label>方式<select value={method} disabled={readonly} onChange={(event) => setMethod(event.currentTarget.value)}>
            {["fit", "fill", "asIs", "conform"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select></label>
          <label>对齐<select value={align} disabled={readonly} onChange={(event) => setAlign(event.currentTarget.value)}>
            {["topLeft", "topCenter", "topRight", "centerLeft", "center", "centerRight", "bottomLeft", "bottomCenter", "bottomRight"]
              .map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select></label>
          <label><input type="checkbox" checked={clip} disabled={readonly} onChange={(event) => setClip(event.currentTarget.checked)} />按图层蒙版裁切</label>
        </div>
      ) : null}
      {defs.length ? (
        <ul className="photo-editor__history-list" data-variable-list="true">
          {defs.map((def) => (
            <li key={def.name} data-variable={def.name} data-variable-kind={def.kind ?? "unknown"}>
              {def.name} · 图层 {def.layer} · {def.kind ?? `未知种类（${def.rawKind ?? "?"}）`}
              <Button size="sm" tone="ghost" disabled={readonly || blocked !== null}
                onClick={() => remove(def.name)}>删除变量</Button>
            </li>
          ))}
        </ul>
      ) : <p className="photo-editor__brush-note">还没有变量：变量把图层的显隐/文字/像素绑定到数据集的一列。</p>}
      {blocked ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-variable-unknown="true">{blocked}</p> : null}
    </div>
  );
}

/** 变量、数据集与 CSV/字节往返。像素变量的值是宿主资源键，应用时交出对应字节。 */
export function DataSetsPanel({ controller, readonly, onChanged }: { controller: EditorWorkspaceController; readonly: boolean; onChanged?: () => void }) {
  const session = historySession(controller, "variablesState");
  const [state, setState] = useState<VariablesStateView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 成功但需要额外说明的事（例如删掉当前生效的数据集）走独立提示槽，不与错误混在一起。
  const [notice, setNotice] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Array<{ column: string; reason: string }>>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [exportFormat, setExportFormat] = useState<"png" | "jpg" | "tif">("png");
  const [exportNaming, setExportNaming] = useState("{name}");
  const csvInput = useRef<HTMLInputElement | null>(null);
  const pixelInput = useRef<HTMLInputElement | null>(null);
  const pixelKeys = useMemo(() => Object.keys(images).sort(), [images]);
  // 图层清单来自工作区视图（本域不另存图层树）；只在有文档时有值。
  // 精简宿主/测试替身可能没有 `currentView`：缺它就退化为「没有可选图层」，
  // 变量编辑器自己禁用添加按钮并说明原因（design D11），而不是调用时抛错。
  const layers = useMemo(() => {
    const view = typeof controller.currentView === "function" ? controller.currentView() : null;
    return (view?.document?.layers ?? []).map((entry) => ({ id: entry.id, name: entry.name }));
  }, [controller, state]);

  useEffect(() => {
    if (!session) return;
    const result = session.variablesState();
    if (result.ok) setState(result.value);
  }, [session, controller]);

  if (!session) return null;

  const readState = () => {
    const result = session.variablesState();
    if (result.ok) setState(result.value);
  };

  const apply = (name: string) => {
    const result = session.applyDataSet({ name, images });
    setMessage(errorText(result));
    if (result.ok) {
      readState();
      onChanged?.();
    }
  };

  // 只有每个数据集都拿到了原始取值，才能安全地「删一行」——否则重发全集会用编造的取值覆盖
  // 别处的内容。缺端口或缺取值时按钮禁用并说明，不做半套。
  const canResend = typeof session.setDataSets === "function";
  const hasRawValues = (state?.dataSets.length ?? 0) > 0
    && state!.dataSets.every((set) => set.entries.length === set.values);
  const deletable = canResend && hasRawValues;
  // 两种「不能删」的原因不一样，说错会让人去查解码：缺端口是宿主没实现，缺取值是视图给的是摘要。
  const undeletableReason = !canResend
    ? "当前宿主没有实现 setDataSets，无法整份重发数据集"
    : "当前视图没有返回数据集的原始取值，无法安全重发整份列表";

  /**
   * 删除一个数据集：重发**其余全部**数据集（`image.variables.dataSets` 是整份替换）。
   *
   * 这是 `setDataSets` 端口唯一的用途：内核没有单项删除命令，而增量语义在这里会误删。
   */
  const removeSet = (target: DataSetView) => {
    if (!state) return;
    // 删掉正在生效的那组要说明后果：画布上还留着它最后一次应用的像素，但「当前生效」会被清空，
    // 后来的人无法从界面看出这份文档是照哪一组渲染的。删除本身仍可做（用户可能就是要重来）。
    if (state.active !== null && state.dataSets[state.active]?.name === target.name) {
      setNotice(`已删除当前生效的数据集「${target.name}」：画布保留它最后一次应用的像素，但此后没有生效的数据集`);
    } else {
      setNotice(null);
    }
    const rest = state.dataSets
      .filter((set) => set.name !== target.name)
      .map((set) => ({ name: set.name, values: set.entries }));
    // 全部删完时内核要求 `dataSets` 是数组（空数组是合法的「删空」）。
    const result = session.setDataSets(rest);
    setMessage(errorText(result));
    if (result.ok) {
      readState();
      onChanged?.();
    } else {
      // 删除失败时不能留着「已删除…」的说明，否则界面同时说「删了」和「没删掉」。
      setNotice(null);
    }
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="变量与数据集" data-data-sets-panel="true">
      <span className="photo-editor__options-title">变量（{state?.defs.length ?? 0}）</span>
      <VariableEditor session={session} readonly={readonly} defs={state?.defs ?? []} layers={layers}
        onChanged={() => { readState(); onChanged?.(); }} onMessage={setMessage} />

      <span className="photo-editor__options-title">数据集（{state?.dataSets.length ?? 0}）</span>
      {state?.dataSets.length ? (
        <ul className="photo-editor__history-list" data-data-set-list="true">
          {state.dataSets.map((set, index) => (
            <li key={set.name} data-data-set={set.name} data-active={index === state.active}>
              <span>{set.name}（{set.values} 个值）{index === state.active ? "（当前生效）" : ""}</span>
              <Button size="sm" disabled={readonly} onClick={() => apply(set.name)}>应用</Button>
              {/* 删除必须走「整份替换」：`image.variables.dataSets` 没有单项删除命令，重发全集时
                  其余数据集要**原样带回**（含 `kind`/`value`）。解码没拿到原始取值时宁可不给这个
                  按钮，也不能用编造的取值覆盖别人的数据集。 */}
              <Button size="sm" tone="ghost" disabled={readonly || !deletable}
                title={deletable ? undefined : undeletableReason}
                onClick={() => removeSet(set)}>删除</Button>
            </li>
          ))}
        </ul>
      ) : <p className="photo-editor__brush-note">还没有数据集。可导入 CSV，或先定义变量。</p>}

      <span className="photo-editor__options-title">字节往返</span>
      <input ref={csvInput} type="file" accept=".csv,text/csv" hidden data-csv-file
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          // 读进内存之前先看预算：`file.text()` 会把整个文件展开，超预算就不该读。
          const limit = state?.budget?.maxCsvBytes ?? 0;
          if (limit > 0 && file.size > limit) {
            setSkipped([]);
            setMessage(`CSV 有 ${file.size} 字节，超过上限 ${Math.round(limit / 1024 / 1024)} MiB`);
            return;
          }
          const result = session.importDataSets(await file.text(), {});
          if (!result.ok) {
            setSkipped([]);
            setNotice(null);
            setMessage(result.message);
            return;
          }
          setSkipped(result.value.skipped);
          // 成功的回执走提示槽：放在 `data-data-sets-error` 里会让成功提示套上错误样式，
          // 用户看到红色一行会以为导入失败。
          setMessage(null);
          setNotice(`导入 ${result.value.imported} 个数据集`);
          readState();
          // 数据集属于文档内容：导入后要让共享预览/修订刷新，否则界面显示的是旧文档。
          onChanged?.();
        }} />
      <input ref={pixelInput} type="file" accept="image/png,image/jpeg,image/webp" hidden multiple data-pixel-files
        onChange={async (event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          const next: Record<string, string> = { ...images };
          for (const file of files) next[file.name] = toBase64(new Uint8Array(await file.arrayBuffer()));
          setImages(next);
        }} />
      <div className="photo-editor__row">
        <Button size="sm" disabled={readonly} onClick={() => csvInput.current?.click()}>导入 CSV…</Button>
        <Button size="sm" tone="ghost" onClick={() => {
          const result = session.exportDataSetsCsv();
          if (!result.ok) {
            setMessage(result.message);
            return;
          }
          if (downloadText("data-sets.csv", result.value.text)) {
            setMessage(null);
            setNotice(`已导出 ${result.value.dataSets} 个数据集的 CSV`);
          } else {
            setNotice(null);
            setMessage("当前环境不能交付文件");
          }
        }}>导出 CSV…</Button>
        <Button size="sm" tone="ghost" disabled={readonly} onClick={() => pixelInput.current?.click()}>替换图片…</Button>
        <label>交付格式<select value={exportFormat} disabled={readonly} data-export-format
          onChange={(event) => setExportFormat(event.currentTarget.value as typeof exportFormat)}>
          <option value="png">PNG</option>
          <option value="jpg">JPEG</option>
          <option value="tif">TIFF</option>
        </select></label>
        <label>命名<input value={exportNaming} disabled={readonly} placeholder="{name}" data-export-naming
          onChange={(event) => setExportNaming(event.currentTarget.value)} /></label>
        <Button size="sm" tone="ghost" disabled={readonly} onClick={() => {
          // 格式与命名模板交给内核：它才负责编码与撞名预检，界面不重复实现。
          const result = session.exportDataSetsAsFiles({
            format: exportFormat,
            naming: exportNaming.trim() ? exportNaming.trim() : "{name}",
            images
          });
          if (!result.ok) {
            setMessage(result.message);
            return;
          }
          const mime = exportFormat === "jpg" ? "image/jpeg" : exportFormat === "tif" ? "image/tiff" : "image/png";
          let delivered = 0;
          for (const file of result.value) {
            const bytes = fromBase64(file.data);
            if (bytes && download(file.fileName, bytes, mime)) delivered += 1;
          }
          if (delivered === result.value.length) {
            setMessage(null);
            setNotice(`已交付 ${delivered} 个文件`);
          } else {
            setNotice(null);
            setMessage(`只交付了 ${delivered}/${result.value.length} 个文件`);
          }
        }}>导出数据集为文件…</Button>
      </div>
      {pixelKeys.length ? <p className="photo-editor__brush-note">已选图片：{pixelKeys.join("、")}</p> : null}
      {skipped.length ? (
        <ul className="photo-editor__history-list" data-csv-skipped="true">
          {skipped.map((column) => <li key={column.column}>{column.column}：{column.reason}</li>)}
        </ul>
      ) : null}
      {notice ? <p className="photo-editor__brush-note" data-data-sets-notice="true">{notice}</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-data-sets-error="true">{message}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------- U76 前台自动化

const BATCH_MODES = [
  { id: "batch", label: "批处理（逐文件处理）" },
  { id: "imageProcessor", label: "图像处理器" },
  { id: "contactSheet", label: "联系表 II" },
  { id: "loadStack", label: "载入堆栈" },
] as const;

/**
 * 循环上限：内核的队列文件数与步骤数都有上限，界面再加一层防御只是为了避免在契约被破坏时
 * 无限循环。真正的上限校验在内核（超预算在 `beginBatch` 就拒绝）。
 */
const MAX_BATCH_STEPS = 2048;

/**
 * 前台自动化外壳：批处理与受限脚本是两个独立端口。
 *
 * 精简宿主可能只实现其中一个（例如只给队列、不给脚本），因此两者各自探测方法、
 * 各自挂载；缺一个不影响另一个（design D11）。
 */
export function AutomationPanel({ controller, readonly }: { controller: EditorWorkspaceController; readonly: boolean }) {
  const batch = historySession(controller, "beginBatch");
  const scripts = historySession(controller, "runScript");
  if (!batch && !scripts) return null;
  return (
    <section className="photo-editor__advanced-group" aria-label="批处理与脚本" data-automation-panel="true">
      {batch ? <BatchGroup session={batch} readonly={readonly} /> : null}
      {scripts ? <ScriptGroup session={scripts} readonly={readonly} /> : null}
    </section>
  );
}

/**
 * 前台批处理：逐文件报告、取消后不再启动下一项。每项一次 `step`，界面不并发。
 *
 * 队列在收尾前一直保留：逐项结果可以随时「领取」交付字节，点「收尾」才释放内核队列槽位。
 * 卸载面板时也释放，避免一个关掉的面板占住队列。
 */
function BatchGroup({ session, readonly }: { session: HistorySession; readonly: boolean }) {
  const [mode, setMode] = useState<string>("batch");
  const [format, setFormat] = useState("png");
  const [fit, setFit] = useState("");
  /**
   * 处理步骤与命名模板。
   *
   * 内核的 `beginBatch` 收 `steps`（逐文件执行的命令）与 `naming`（`{name}`/`{index}` 模板），
   * 但面板此前只发模式/格式/边长：于是「批处理」只会打开每个文件再导出，做不了 Photoshop
   * 批处理真正的用途——把同一串动作套到一批文件上。这里把两个参数接出来。
   */
  const [stepsText, setStepsText] = useState("");
  const [naming, setNaming] = useState("");
  /**
   * 联系表网格。内核按 `columns × rows`（默认 5×6=30 格，上限 64 格）排版，并**在开始前**拒绝
   * 「输入张数超过格子数」。面板不放出这两个参数的话，选 31 张就会得到一句无法自救的拒绝。
   */
  const [columns, setColumns] = useState("5");
  const [rows, setRows] = useState("6");
  const [files, setFiles] = useState<Array<{ name: string; data: string }>>([]);
  const [progress, setProgress] = useState<BatchProgressView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const queue = useRef<number | null>(null);
  const cancelled = useRef(false);
  // 已领取的下标。`takeBatchFile` 会从内核队列里移除字节，重复领取必然失败；这里只是为了在
  // 「收尾」前数出还有多少项没交付——收尾会连同未领取的字节一起丢掉。
  const [delivered, setDelivered] = useState<number[]>([]);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const sessionRef = useRef<HistorySession | null>(session);
  sessionRef.current = session;

  useEffect(() => () => {
    // 卸载时释放内核队列：未收尾的队列会一直占住一个槽位。
    const id = queue.current;
    if (id === null) return;
    sessionRef.current?.cancelBatch(id);
    sessionRef.current?.finishBatch(id);
    queue.current = null;
  }, []);

  /**
   * 收尾：释放队列。未领取的交付字节会**一起丢掉**（内核的 `finish` 直接移除队列），所以有
   * 未领取项时先说明并要求确认，而不是让用户以为「收尾」只是整理列表。
   */
  // 收尾会丢掉的项：有交付字节、成功、还没领取。
  const unclaimed = (progress?.results ?? [])
    .map((result, index) => ({ result, index }))
    .filter(({ result, index }) => result.ok && (result.bytes ?? 0) > 0 && !delivered.includes(index))
    .map(({ index }) => index);

  const release = (id: number) => {
    const pending = unclaimed.length;
    if (pending > 0 && !confirmFinish) {
      setConfirmFinish(true);
      return;
    }
    const finished = session.finishBatch(id);
    if (finished.ok) setProgress(finished.value);
    else setMessage(errorText(finished));
    queue.current = null;
    setOpen(false);
    setConfirmFinish(false);
    setDelivered([]);
  };

  const cancelQueue = () => {
    cancelled.current = true;
    const id = queue.current;
    if (id === null) return;
    const result = session.cancelBatch(id);
    if (result.ok) setProgress(result.value);
    else setMessage(errorText(result));
    setRunning(false);
  };

  const start = async () => {
    if (!files.length) {
      setMessage("先选择输入文件");
      return;
    }
    // 步骤先本地解析成 JSON 数组再交给内核：写错的 JSON 在这里就说清楚，不必等一次网络/内核往返。
    let steps: unknown = undefined;
    if (stepsText.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stepsText);
      } catch (failure) {
        setMessage(`处理步骤不是合法 JSON：${failure instanceof Error ? failure.message : String(failure)}`);
        return;
      }
      if (!Array.isArray(parsed)) {
        setMessage("处理步骤必须是数组，例如 [[\"image.imageSize\", {\"width\":800}]]");
        return;
      }
      steps = parsed;
    }
    // 联系表的容量在**开始前**就够不够：内核的拒绝理由能读，但用户没法在面板里改网格。
    if (mode === "contactSheet") {
      const cells = Math.max(1, Number(columns) || 0) * Math.max(1, Number(rows) || 0);
      if (files.length > cells) {
        setMessage(`联系表网格 ${columns}×${rows} 只有 ${cells} 格，装不下 ${files.length} 张；先调大列/行`);
        return;
      }
    }
    cancelled.current = false;
    setProgress(null);
    setDelivered([]);
    setConfirmFinish(false);
    const begun = session.beginBatch({
      mode,
      format,
      input: files,
      ...(steps === undefined ? {} : { steps }),
      ...(naming.trim() ? { naming: naming.trim() } : {}),
      ...(fit.trim() ? { width: Number(fit), height: Number(fit) } : {}),
      ...(mode === "contactSheet"
        ? { columns: Math.max(1, Number(columns) || 1), rows: Math.max(1, Number(rows) || 1) }
        : {}),
    });
    if (!begun.ok) {
      setMessage(begun.message);
      return;
    }
    const id = begun.value;
    queue.current = id;
    setOpen(true);
    setRunning(true);
    setMessage(null);
    // 一项一次：每次 step 之后界面都能读到逐文件结果，并把控制权交回浏览器一帧，让「取消」
    // 能真正被点到；取消后循环退出，不再启动下一项。`guard` 只是防御：正常队列的项数有上限。
    for (let guard = 0; guard < MAX_BATCH_STEPS; guard += 1) {
      if (cancelled.current) break;
      const step = session.stepBatch(id);
      if (!step.ok) {
        setMessage(step.message);
        break;
      }
      setProgress(step.value);
      if (cancelled.current || !step.value.running) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    setRunning(false);
  };

  /** 领取一项交付字节：收尾后队列已释放，因此只在队列打开时可用。 */
  const deliver = (index: number) => {
    const id = queue.current;
    if (id === null) {
      setMessage("队列已收尾：结果字节只在收尾前可领取，请重新运行");
      return;
    }
    const result = session.takeBatchFile(id, index);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    const bytes = fromBase64(result.value.data);
    if (!bytes) {
      setMessage("交付的字节不是合法 base64");
      return;
    }
    const name = result.value.output ?? result.value.file;
    setMessage(download(name, bytes) ? null : "当前环境不能交付文件");
    setDelivered((previous) => (previous.includes(index) ? previous : [...previous, index]));
  };

  return (
    <div className="photo-editor__advanced-group" data-batch-group="true">
      <span className="photo-editor__options-title">前台批处理</span>
      <label>模式<select value={mode} disabled={readonly || running} onChange={(event) => setMode(event.currentTarget.value)}>
        {BATCH_MODES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select></label>
      <label>交付格式<select value={format} disabled={readonly || running} onChange={(event) => setFormat(event.currentTarget.value)}>
        {["png", "jpg", "tif"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}
      </select></label>
      <label>适应边长<input value={fit} inputMode="numeric" placeholder="不缩放" disabled={readonly || running}
        onChange={(event) => setFit(event.currentTarget.value.replace(/[^\d]/g, ""))} /></label>
      <label>命名模板<input value={naming} placeholder="{name}（默认）" disabled={readonly || running} data-batch-naming
        onChange={(event) => setNaming(event.currentTarget.value)} /></label>
      <label>处理步骤<input value={stepsText} placeholder={'留空=只转换；[[\"image.imageSize\",{\"width\":800}]]'} disabled={readonly || running} data-batch-steps
        onChange={(event) => setStepsText(event.currentTarget.value)} /></label>
      {mode === "contactSheet" ? (
        <div className="photo-editor__row">
          <label>列<input value={columns} inputMode="numeric" disabled={readonly || running} data-contact-columns
            onChange={(event) => setColumns(event.currentTarget.value.replace(/[^\d]/g, ""))} /></label>
          <label>行<input value={rows} inputMode="numeric" disabled={readonly || running} data-contact-rows
            onChange={(event) => setRows(event.currentTarget.value.replace(/[^\d]/g, ""))} /></label>
          <span className="photo-editor__brush-note">共 {Math.max(1, Number(columns) || 0) * Math.max(1, Number(rows) || 0)} 格</span>
        </div>
      ) : null}
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/tiff,image/webp" hidden multiple data-batch-files
        onChange={async (event) => {
          const picked = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          const read: Array<{ name: string; data: string }> = [];
          for (const file of picked) read.push({ name: file.name, data: toBase64(new Uint8Array(await file.arrayBuffer())) });
          setFiles(read);
        }} />
      <div className="photo-editor__row">
        <Button size="sm" disabled={readonly || running} onClick={() => fileInput.current?.click()}>选择文件…</Button>
        <Button size="sm" disabled={readonly || running || files.length === 0} onClick={() => void start()}>开始</Button>
        <Button size="sm" tone="ghost" disabled={!running} onClick={cancelQueue}>取消</Button>
        <Button size="sm" tone="ghost" disabled={!open || running} onClick={() => queue.current !== null && release(queue.current)}>收尾</Button>
      </div>
      {confirmFinish ? (
        <div className="photo-editor__advanced-group" role="alertdialog" aria-label="收尾确认" data-finish-confirm="true">
          <p>还有 {unclaimed.length} 项结果没有领取；收尾会把它们连同队列一起丢掉，之后不能重新领取。</p>
          <div className="photo-editor__row">
            <Button size="sm" tone="danger" onClick={() => queue.current !== null && release(queue.current)}>确认收尾</Button>
            {/* 不能叫「取消」：同一面板里「取消」是取消队列，同名按钮会让用户点错。 */}
            <Button size="sm" tone="ghost" onClick={() => setConfirmFinish(false)}>继续领取</Button>
          </div>
        </div>
      ) : null}
      <p className="photo-editor__brush-note">
        {mode === "contactSheet"
          ? "联系表的一次合成按版面排版，处理步骤不会套用（内核会清空步骤）。"
          : mode === "loadStack"
            ? "载入堆栈先合成成一份文档，处理步骤套用在**合成结果**上（不是每个输入各套一遍）。"
            : stepsText.trim()
            ? "每项依次执行这些步骤；任一步不可执行会在「开始」前整组拒绝，不会先跑一半。"
            : "没有处理步骤：每项只做解码、可选缩放与重新编码（图像处理器/纯格式转换即属此类）。"}
      </p>
      <p className="photo-editor__brush-note">输入 {files.length} 个文件；上限 64 个 / 单文件 64 MiB。{files.length ? `（${files.map((file) => file.name).join("、")}）` : ""}</p>
      {progress ? (
        <div data-batch-progress={progress.cancelled ? "cancelled" : progress.running ? "running" : "done"}>
          <p>进度 {progress.completed}/{progress.total}；交付 {Math.round(progress.outputBytes / 1024)} KiB{progress.cancelled ? "；已取消" : ""}</p>
          <ul className="photo-editor__history-list" data-batch-results="true">
            {progress.results.map((result, index) => (
              <li key={`${index}-${result.file}`} data-batch-result={result.file} data-ok={result.ok}>
                {result.ok ? "✓" : "✗"} {result.file}
                {result.output ? ` → ${result.output}` : ""}
                {result.error ? `（${result.error}）` : ""}
                {result.ok && open ? <Button size="sm" tone="ghost" onClick={() => deliver(index)}>领取</Button> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-automation-error="true">{message}</p> : null}
    </div>
  );
}

/**
 * 受限声明式脚本：每行 `command.id {json}`，或 `#`/`//` 注释。
 *
 * 脚本只能调用已开放命令；未知或未开放步骤由内核在**执行前**整组拒绝，所以这里不需要
 * 逐个校验命令名——界面只负责把文本交给内核并把逐步报告显示出来。
 */
function ScriptGroup({ session, readonly }: { session: HistorySession; readonly: boolean }) {
  const [text, setText] = useState("");
  const [report, setReport] = useState<ScriptReportView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = () => {
    if (!text.trim()) {
      setMessage("先写脚本：每行 `command.id {json}`");
      return;
    }
    setRunning(true);
    const result = session.runScript({ script: text });
    setRunning(false);
    setReport(result.ok ? result.value : null);
    setMessage(errorText(result));
  };

  return (
    <div className="photo-editor__advanced-group" data-script-group="true">
      <span className="photo-editor__options-title">受限脚本</span>
      <label>脚本<textarea value={text} rows={4} spellCheck={false} disabled={readonly || running}
        placeholder={"# 每行一条已开放命令\nlayer.selectByName {\"name\":\"背景\"}"}
        onChange={(event) => setText(event.currentTarget.value)} /></label>
      <div className="photo-editor__row">
        <Button size="sm" disabled={readonly || running} onClick={run}>运行脚本</Button>
        <Button size="sm" tone="ghost" disabled={running} onClick={() => { setText(""); setReport(null); setMessage(null); }}>清空</Button>
      </div>
      {report ? (
        <div data-script-report={report.ok ? "ok" : "failed"}>
          <p>预检 {report.preflight?.steps.length ?? 0} 步，已执行 {report.results.length} 步{report.ok ? "" : "（中途失败）"}</p>
          <ul className="photo-editor__history-list" data-script-results="true">
            {report.results.map((step) => (
              <li key={step.step} data-script-step={step.step} data-ok={step.error === undefined}>
                {step.error === undefined ? "✓" : "✗"} {step.step + 1}. {step.id}
                {step.error === undefined ? "" : `（${step.error}）`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-script-error="true">{message}</p> : null}
    </div>
  );
}
