/**
 * 命令搜索与工作区定制面板（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization，design D1/D3）。
 *
 * 面板只做三件事：搜索并执行已接通命令、编辑本机偏好、保存/应用命名工作区。所有写操作都经
 * `CustomizationStore` 的读-改-写；命令执行仍走工作区控制器 `dispatch` 的同一门禁。
 *
 * 消费端已接通（任务 4.5）：菜单隐藏与组合提示由 `photo-editor-chrome.tsx` 消费，工具栏顺序与隐藏
 * 由 `toolbarRenderGroups` 决定，键盘分派在 `photo-editor-app.tsx` 走 `resolveWithPreferences`，
 * 工具选项在切换工具时恢复/记忆。界面因此不再标注「待外壳接入」。
 *
 * 面板几何工作区通过布局所有者提供的读写端口应用：外壳提供 `applyPanelLayout` 时当次立即重排，
 * 未提供时如实提示「重新打开编辑器后生效」，不假装已实时重排。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { Button } from "../../ui/Button.js";
import { EDITOR_MENUS, type EditorMenuItem } from "../../photo-editor-menu.js";
import { isEditorMac } from "../../photo-editor-shortcuts.js";
import { normalizePanelLayout, readPanelLayout, savePanelLayout } from "../../editor-panel-layout.js";
import {
  CUSTOMIZATION_TOOL_ACTIONS,
  RECENT_COMMANDS_CAP,
  chordConflicts,
  chordFromEvent,
  chordLabel,
  customizationActionsByKind,
  isBrowserReserved,
  defaultCustomizationStore,
  effectiveChord,
  parseChord,
  type ChordConflict,
  type CustomizationStore
} from "./preferences.js";
import { shortcutHint, toolbarOrderedIds } from "./shell-adapter.js";
import { defaultPaletteHits, paletteEntries, pushRecent, searchPalette, type PaletteEntry } from "./command-palette.js";

/** 命令执行的稳定最小面；`EditorWorkspaceController` 结构上满足。 */
export type CustomizationEndpoint = {
  snapshot(): { commands: ReadonlyMap<string, PhotocraftCommand> };
  dispatch(id: string, params?: unknown): { ok: true; value: unknown } | { ok: false; code: string; message: string };
  /**
   * 可选订阅：文档修订变化后命令的 `enabled`/`disabledReason` 会变，面板需要跟着刷新，
   * 否则搜索结果会显示过期状态（点了没反应或该可用的显示为禁用）。`EditorWorkspaceController`
   * 的 `subscribe` 结构上兼容。
   */
  subscribe?(listener: () => void): () => void;
};

export type WorkspaceCustomizationPanelProps = {
  controller: CustomizationEndpoint;
  /**
   * 文档级门禁：笔迹/草稿/只读预览/保存中/无文档时不执行命令。
   *
   * **只挡命令执行**：偏好是工具状态，改快捷键/工作区不写文档、不造 dirty，所以不受此门禁
   * 影响（design D1「工具本机设置/视图不进入内容 hash」）。
   */
  locked: boolean;
  /** 测试注入的仓库；缺省使用与工作区会话共享的本机偏好仓库。 */
  store?: CustomizationStore;
  /** 面板几何读写端口；缺省读写既有面板布局键。 */
  capturePanelLayout?: () => Record<string, unknown> | null;
  /**
   * 应用工作区几何。
   *
   * 外壳接进来（例如 `patch => display.updatePanels?.(patch)`）时当次立即重排；未接入时退回
   * 写入面板布局键，并如实提示「重新打开编辑器后生效」，不假装已实时重排。
   */
  applyPanelLayout?: (layout: Record<string, unknown>) => void;
  /** 偏好导出端口；缺省在浏览器里触发下载，其他宿主可换成自己的保存流程。 */
  exportPreferences?: (text: string) => boolean;
};

type MenuLeaf = { id: string; label: string; menu: string };

function menuLeaves(): MenuLeaf[] {
  const leaves: MenuLeaf[] = [];
  const walk = (menu: string, items: readonly EditorMenuItem[]) => {
    for (const item of items) {
      if (item.children && item.children.length) {
        walk(menu, item.children);
        continue;
      }
      leaves.push({ id: item.id, label: item.label, menu });
    }
  };
  for (const menu of EDITOR_MENUS) walk(menu.label, menu.items);
  return leaves;
}

/** 宿主文档能力注入的菜单项（`editorMenusFor`）；静态表里没有，但同样可按 id 隐藏。 */
const HOST_MENU_LEAVES: readonly MenuLeaf[] = [
  { id: "file.open", label: "打开文件…", menu: "文件" },
  { id: "file.save", label: "保存", menu: "文件" },
  { id: "file.place", label: "置入图片…", menu: "文件" },
  { id: "file.openPsd", label: "导入 PSD…", menu: "文件" },
  { id: "file.exportPsd", label: "导出 PSD…", menu: "文件" },
  { id: "file.exportPng", label: "导出 PNG…", menu: "文件" },
  { id: "file.close", label: "关闭", menu: "文件" }
];

const MENU_LEAVES = [...HOST_MENU_LEAVES, ...menuLeaves()];

/**
 * 命令 id → 界面中文标签。
 *
 * 内核命令表自报英文名，菜单与快捷键面板用中文。搜索必须以用户看到的同一套名字出现，
 * 否则「撤销」这类中文查询完全搜不到。
 */
const MENU_LABELS = new Map(MENU_LEAVES.map((leaf) => [leaf.id, leaf.label]));

function defaultCapturePanelLayout(): Record<string, unknown> | null {
  try {
    return { ...readPanelLayout() };
  } catch {
    return null;
  }
}

function defaultApplyPanelLayout(layout: Record<string, unknown>): void {
  savePanelLayout(normalizePanelLayout(layout));
}

/** 偏好导出文件名；宿主/浏览器下载都用同一个名字，便于往返导入。 */
export const CUSTOMIZATION_EXPORT_FILENAME = "photocraft-customization.json";

/**
 * 触发浏览器下载。
 *
 * 返回 `false` 表示当前环境不支持 Blob 下载（例如没有 DOM 的宿主）：调用方保留「JSON 已生成」
 * 的文本回执，由宿主自行保存，不假装文件已写出。
 */
export function downloadPreferences(text: string, filename = CUSTOMIZATION_EXPORT_FILENAME): boolean {
  try {
    // 用 globalThis 取值：非浏览器宿主可能完全没有 document/URL/Blob。
    if (typeof document === "undefined" || typeof Blob === "undefined") return false;
    const urlApi = globalThis.URL;
    if (typeof urlApi?.createObjectURL !== "function") return false;
    const url = urlApi.createObjectURL(new Blob([text], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // 延迟回收，避免部分浏览器在下载真正开始前就失效。
    setTimeout(() => urlApi.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

export function WorkspaceCustomizationPanel({
  controller,
  locked,
  store,
  capturePanelLayout = defaultCapturePanelLayout,
  applyPanelLayout,
  exportPreferences: exportPort
}: WorkspaceCustomizationPanelProps) {
  const applyLayout = useMemo(() => applyPanelLayout ?? defaultApplyPanelLayout, [applyPanelLayout]);
  // 外壳提供端口才算「当次生效」；默认实现只写布局键，需要重开编辑器。
  const shellAppliesLayout = applyPanelLayout !== undefined;
  const preferencesStore = useMemo(() => store ?? defaultCustomizationStore(), [store]);
  const state = useSyncExternalStore(preferencesStore.subscribe, preferencesStore.snapshot);
  const preferences = state.preferences;
  const isMac = useMemo(() => isEditorMac(), []);

  // 命令表随文档修订变化（可用性/禁用原因）；订阅控制器快照并计数，避免搜索显示过期状态。
  // 用版本号而不是直接订阅快照对象：`getSnapshot` 必须引用稳定，而替身控制器的 `snapshot()`
  // 允许每次返回新对象。
  const [commandRevision, setCommandRevision] = useState(0);
  useEffect(() => {
    if (!controller.subscribe) return;
    return controller.subscribe(() => setCommandRevision((revision) => revision + 1));
  }, [controller]);
  // 修订号变化后重新读取命令表；控制器在状态未变时返回同一引用，因此这里不会自触发。
  const commands = useMemo(() => controller.snapshot().commands, [controller, commandRevision]);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [capture, setCapture] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{ actionId: string; chord: string; conflicts: ChordConflict[] } | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const captureRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(
    () => paletteEntries(commands, {
      shortcutFor: (id, fallback) => shortcutHint(preferences, id, isMac, fallback),
      // 内核自报英文名（Undo/Redo），界面菜单是中文；用同一 id 换成中文标签，英文仍作关键字。
      labelFor: (id, fallback) => MENU_LABELS.get(id) ?? fallback
    }),
    [commands, preferences, isMac]
  );
  const hits = useMemo(
    () => (query.trim() ? searchPalette(entries, query, { recentIds, limit: 12 }) : defaultPaletteHits(entries, recentIds, 12)),
    [entries, query, recentIds]
  );
  const conflicts = useMemo(() => chordConflicts(preferences), [preferences]);
  // 设置界面必须列出全部工具（含已隐藏的），否则隐藏后就再也无法取消隐藏。
  const toolbarOrder = useMemo(() => toolbarOrderedIds(preferences), [preferences]);

  useEffect(() => {
    if (capture) captureRef.current?.focus({ preventScroll: true });
  }, [capture]);
  useEffect(() => {
    if (activeIndex >= hits.length) setActiveIndex(0);
  }, [activeIndex, hits.length]);

  const report = useCallback((result: { ok: boolean; message?: string; warnings?: string[] }, success?: string) => {
    if (result.ok) {
      setMessage(null);
      // 成功但有条目被丢弃（例如导入含未知动作/非法组合的文件）时必须说出来，不能静默少设置。
      if (success) setNotice(result.warnings?.length ? `${success}；${result.warnings.join("；")}` : success);
      else if (result.warnings?.length) setNotice(result.warnings.join("；"));
      return true;
    }
    setMessage(result.message ?? "操作失败");
    return false;
  }, []);

  const execute = (entry: PaletteEntry) => {
    // 只读/草稿/忙碌是外壳级门禁，搜索不能成为绕过它的第二条写入口。
    if (locked) {
      setMessage("当前不可执行命令（只读预览、草稿未结算或正在保存）");
      return;
    }
    const result = controller.dispatch(entry.id);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setNotice(`已执行「${entry.label}」`);
    setRecentIds((current) => pushRecent(current, entry.id, RECENT_COMMANDS_CAP));
  };

  const changeShortcut = (actionId: string, text: string) => {
    setPendingConflict(null);
    const result = preferencesStore.setShortcut(actionId, text);
    if (!result.ok && result.code === "conflict") {
      const parsed = parseChord(text);
      setPendingConflict({ actionId, chord: parsed.ok && parsed.chord ? chordLabel(parsed.chord, isMac) : text, conflicts: result.conflicts ?? [] });
      setMessage(result.message);
      return;
    }
    if (report(result, "快捷键已保存")) setCapture(null);
  };

  const captureChord = (actionId: string, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setCapture(null);
      setMessage(null);
      return;
    }
    const chord = chordFromEvent(event.nativeEvent, isMac);
    if (!chord.ok) {
      setMessage(chord.reason);
      return;
    }
    setMessage(null);
    changeShortcut(actionId, chord.chord);
  };

  const saveWorkspace = () => {
    const layout = capturePanelLayout();
    const result = preferencesStore.saveWorkspace(workspaceName, { panelLayout: layout });
    if (report(result, `已保存工作区「${workspaceName.trim()}」`)) setWorkspaceName("");
  };

  const applyWorkspace = (id: string) => {
    const result = preferencesStore.applyWorkspace(id);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    if (result.panelLayout) applyLayout(result.panelLayout);
    setMessage(null);
    // 只有外壳提供了实时重排端口才宣称「已应用」；写布局键的默认实现仍需重开编辑器。
    const immediate = result.panelLayout ? shellAppliesLayout : false;
    setNotice(result.panelLayout ? (immediate ? "工作区已应用" : "工作区已应用；面板几何在重新打开编辑器后生效") : "工作区已应用");
  };

  const exportPreferences = () => {
    const text = preferencesStore.exportJson();
    const written = exportPort ? exportPort(text) : downloadPreferences(text);
    setNotice(written
      ? `偏好 JSON 已保存为 ${CUSTOMIZATION_EXPORT_FILENAME}`
      : `偏好 JSON 已生成（${text.length} 字符）；当前离线无法自动下载，可由宿主保存为文件`);
    setMessage(null);
    return text;
  };

  return (
    <section className="photo-editor__advanced-group" aria-label="命令搜索与工作区定制" data-customization-panel="true">
      <span className="photo-editor__options-title">命令搜索与工作区</span>
      {state.loadError ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-customization-storage>{state.loadError}</p> : null}

      <fieldset className="photo-editor__advanced-group" data-customization-section="commands">
        <legend>命令搜索</legend>
        <label className="photo-editor__customization-search">
          搜索命令
          <input
            type="search"
            value={query}
            data-command-search="true"
            placeholder="输入命令或关键字，回车执行"
            onChange={(event) => { setQuery(event.currentTarget.value); setActiveIndex(0); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(hits.length - 1, index + 1)); return; }
              if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)); return; }
              if (event.key === "Escape") { event.preventDefault(); setQuery(""); return; }
              if (event.key === "Enter") {
                event.preventDefault();
                const hit = hits[activeIndex];
                if (!hit) return;
                if (!hit.enabled) { setMessage(hit.reason ?? "该命令当前不可用"); return; }
                execute(hit);
              }
            }}
          />
        </label>
        {hits.length ? (
          <ul className="photo-editor__customization-results" data-command-results="true">
            {hits.map((hit, index) => (
              <li key={hit.id} data-command-hit={hit.id} data-active={index === activeIndex ? "true" : undefined}>
                <button
                  type="button"
                  className="photo-editor__layer-name"
                  disabled={!hit.enabled || locked}
                  title={hit.reason ?? hit.menu}
                  onClick={() => { setActiveIndex(index); if (!hit.enabled) { setMessage(hit.reason ?? "该命令当前不可用"); return; } execute(hit); }}
                >
                  <span>{hit.label}</span>
                  <span className="photo-editor__option-hint">{hit.menu || "已接通命令"}</span>
                  {hit.shortcut ? <kbd className="photo-editor__shortcut">{hit.shortcut}</kbd> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="photo-editor__option-hint" data-command-empty="true">{query.trim() ? "没有匹配的已接通命令" : "编辑器就绪后，这里列出可执行命令"}</p>
        )}
      </fieldset>

      <fieldset className="photo-editor__advanced-group" data-customization-section="shortcuts">
        <legend>快捷键</legend>
        <p className="photo-editor__option-hint">只列出已接通动作的出厂组合；浏览器保留键可以保存，但可能被浏览器先拦截。</p>
        {conflicts.length ? (
          <p className="photo-editor__brush-note photo-editor__brush-note--error" data-shortcut-conflicts="true">
            {conflicts.map((conflict) => `${conflict.chord}：${conflict.labels.join("、")}`).join("；")}
          </p>
        ) : null}
        {(["command", "tool", "display"] as const).map((kind) => (
          <div key={kind} data-shortcut-group={kind}>
            <span className="photo-editor__option-hint">{kind === "command" ? "菜单命令" : kind === "tool" ? "工具" : "显示"}</span>
            {customizationActionsByKind(kind).map((action) => {
              const chord = effectiveChord(preferences, action.id);
              const overridden = preferences.shortcuts[action.id] !== undefined;
              const parsed = chord ? parseChord(chord) : null;
              const label = parsed?.ok && parsed.chord ? chordLabel(parsed.chord, isMac) : "未绑定";
              const reserved = parsed?.ok && parsed.chord ? isBrowserReserved(parsed.chord) : false;
              return (
                <div key={action.id} className="photo-editor__customization-row" data-shortcut-action={action.id}>
                  <span>{action.label}</span>
                  {capture === action.id ? (
                    <div
                      ref={captureRef}
                      tabIndex={0}
                      role="textbox"
                      data-shortcut-capture={action.id}
                      className="photo-editor__customization-capture"
                      onKeyDown={(event) => captureChord(action.id, event)}
                      onBlur={() => setCapture(null)}
                    >按下新的组合键…（Esc 取消）</div>
                  ) : (
                    <kbd className="photo-editor__shortcut" title={reserved ? "浏览器可能先拦截这个组合，可改用菜单或命令搜索" : undefined}>
                      {label}{reserved ? "（浏览器可能拦截）" : ""}
                    </kbd>
                  )}
                  <Button size="sm" tone="ghost" disabled={false} onClick={() => { setPendingConflict(null); setMessage(null); setCapture(action.id); }}>绑定</Button>
                  <Button size="sm" tone="ghost" disabled={!overridden} onClick={() => report(preferencesStore.resetShortcut(action.id))}>出厂</Button>
                  {/*
                   显式解绑：保留动作的鼠标/菜单入口，只清掉键盘组合（与「出厂」不同）。
                   出厂组合也要能直接解绑——`setShortcut(id, "")` 本来就支持，之前却要求先改绑一次，
                   等于给最常用的「我不想要这个快捷键」加了一道无意义的步骤。只有当前已经空绑时才禁用。
                  */}
                  <Button size="sm" tone="ghost" disabled={chord === ""}
                    onClick={() => report(preferencesStore.setShortcut(action.id, ""), "已解除该动作的快捷键")}>解绑</Button>
                </div>
              );
            })}
          </div>
        ))}
        {pendingConflict ? (
          <div className="photo-editor__customization-row" data-shortcut-conflict-prompt="true">
            <span>
              {pendingConflict.chord} 已被「
              {[...new Set(pendingConflict.conflicts.flatMap((conflict) => conflict.labels))].join("、")}
              」使用
            </span>
            <Button size="sm" tone="danger" disabled={false} onClick={() => {
              const result = preferencesStore.setShortcut(pendingConflict.actionId, pendingConflict.chord, { force: true });
              if (report(result, "快捷键已覆盖原有绑定")) { setPendingConflict(null); setCapture(null); }
            }}>覆盖</Button>
            <Button size="sm" tone="ghost" onClick={() => { setPendingConflict(null); setMessage(null); }}>取消</Button>
          </div>
        ) : null}
        <Button size="sm" tone="ghost" disabled={false} onClick={() => report(preferencesStore.resetShortcuts(), "快捷键已恢复出厂")}>全部恢复出厂</Button>
      </fieldset>

      <fieldset className="photo-editor__advanced-group" data-customization-section="toolbar">
        <legend>工具栏</legend>
        <p className="photo-editor__option-hint">保存隐藏与顺序偏好；工具栏按此顺序显示并隐藏对应工具。</p>
        {toolbarOrder.map((id, index) => {
          const action = CUSTOMIZATION_TOOL_ACTIONS.find((entry) => entry.id === id);
          const hidden = preferences.toolbarHidden.includes(id);
          return (
            <div key={id} className="photo-editor__customization-row" data-toolbar-tool={id}>
              <label>
                <input type="checkbox" checked={!hidden} disabled={false}
                  onChange={(event) => {
                    const hiddenIds = event.currentTarget.checked
                      ? preferences.toolbarHidden.filter((entry) => entry !== id)
                      : [...preferences.toolbarHidden, id];
                    report(preferencesStore.setToolbarHidden(hiddenIds));
                  }} />
                {action?.label ?? id}
              </label>
              <Button size="sm" tone="ghost" disabled={index === 0} onClick={() => {
                const next = [...toolbarOrder];
                [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                report(preferencesStore.setToolbarOrder(next));
              }}>上移</Button>
              <Button size="sm" tone="ghost" disabled={index === toolbarOrder.length - 1} onClick={() => {
                const next = [...toolbarOrder];
                [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
                report(preferencesStore.setToolbarOrder(next));
              }}>下移</Button>
            </div>
          );
        })}
        <Button size="sm" tone="ghost" disabled={false} onClick={() => report(preferencesStore.resetToolbar(), "工具栏已恢复出厂")}>恢复出厂</Button>
      </fieldset>

      <fieldset className="photo-editor__advanced-group" data-customization-section="menus">
        <legend>菜单</legend>
        <p className="photo-editor__option-hint">隐藏常用菜单项；命令仍可用快捷键或命令搜索执行。</p>
        {MENU_LEAVES.map((leaf) => (
          <div key={leaf.id} className="photo-editor__customization-row" data-menu-item={leaf.id}>
            <label>
              <input type="checkbox" checked={!preferences.menuHidden.includes(leaf.id)} disabled={false}
                onChange={(event) => {
                  const hidden = event.currentTarget.checked
                    ? preferences.menuHidden.filter((entry) => entry !== leaf.id)
                    : [...preferences.menuHidden, leaf.id];
                  report(preferencesStore.setMenuHidden(hidden));
                }} />
              {leaf.menu} ▸ {leaf.label}
            </label>
          </div>
        ))}
        <Button size="sm" tone="ghost" disabled={false} onClick={() => report(preferencesStore.resetMenus(), "菜单已恢复出厂")}>恢复出厂</Button>
      </fieldset>

      <fieldset className="photo-editor__advanced-group" data-customization-section="workspaces">
        <legend>工作区</legend>
        <p className="photo-editor__option-hint">
          {shellAppliesLayout
            ? "工作区保存快捷键、工具栏、菜单与面板几何；应用时立即重排面板。"
            : "工作区保存快捷键、工具栏、菜单与面板几何；面板几何在重新打开编辑器后生效。"}
        </p>
        <label>
          名称
          <input type="text" value={workspaceName} maxLength={40} disabled={false}
            onChange={(event) => setWorkspaceName(event.currentTarget.value)} />
        </label>
        <Button size="sm" disabled={false} onClick={saveWorkspace}>保存当前工作区</Button>
        {preferences.workspaces.length ? (
          <ul className="photo-editor__customization-results" data-workspace-list="true">
            {preferences.workspaces.map((preset) => (
              <li key={preset.id} data-workspace={preset.id} data-active={preferences.activeWorkspace === preset.id ? "true" : undefined}>
                <span>{preset.name}</span>
                <Button size="sm" disabled={false} onClick={() => applyWorkspace(preset.id)}>应用</Button>
                <Button size="sm" tone="ghost" disabled={false} onClick={() => report(preferencesStore.deleteWorkspace(preset.id), "工作区已删除")}>删除</Button>
              </li>
            ))}
          </ul>
        ) : <p className="photo-editor__option-hint" data-workspace-empty="true">还没有保存的工作区</p>}
      </fieldset>

      {Object.keys(preferences.toolOptions).length ? (
        <fieldset className="photo-editor__advanced-group" data-customization-section="toolOptions">
          <legend>工具选项记忆</legend>
          <p className="photo-editor__option-hint">工具状态，不进入工程内容；切换工具时按其恢复上次设置。</p>
          {Object.entries(preferences.toolOptions).map(([tool, options]) => (
            <div key={tool} className="photo-editor__customization-row" data-tool-options={tool}>
              <span>{tool}：{Object.entries(options).map(([key, value]) => `${key}=${String(value)}`).join("，")}</span>
              <Button size="sm" tone="ghost" disabled={false} onClick={() => report(preferencesStore.clearToolOptions(tool), "已清除该工具的选项记忆")}>清除</Button>
            </div>
          ))}
          <Button size="sm" tone="ghost" disabled={false} onClick={() => report(preferencesStore.clearToolOptions(), "已清除全部工具选项记忆")}>全部清除</Button>
        </fieldset>
      ) : null}

      <fieldset className="photo-editor__advanced-group" data-customization-section="storage">
        <legend>偏好存储</legend>
        <p className="photo-editor__option-hint" data-customization-persistence={state.persistence}>
          {state.persistence === "local" ? "偏好保存在本机浏览器存储；不写入工程、历史或内容指纹。" : "当前环境不允许本机存储，偏好只在本次会话内保留。"}
        </p>
        <div className="photo-editor__customization-row">
          <Button size="sm" tone="ghost" onClick={exportPreferences}>导出 JSON</Button>
          <label className="photo-editor__customization-import" data-customization-import="true">
            导入 JSON
            <input type="file" accept="application/json,.json" disabled={false}
              onChange={async (event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                try {
                  const text = await file.text();
                  report(preferencesStore.importJson(text), "偏好已导入");
                } catch {
                  setMessage("无法读取偏好文件");
                }
              }} />
          </label>
          <Button size="sm" tone="danger" disabled={false} onClick={() => report(preferencesStore.resetAll(), "偏好已全部恢复出厂")}>全部恢复出厂</Button>
        </div>
      </fieldset>

      {notice ? <p className="photo-editor__brush-note" data-customization-notice="true">{notice}</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error" data-customization-message="true">{message}</p> : null}
    </section>
  );
}
