/**
 * 插件详情里的「生成的模型」：启用比例、搜索/筛选、批量启用与关闭、撤销。
 *
 * 交互要点（2026-10-20 用户确认的 demo）：
 * - 模型很多时，批量动作只作用于当前筛选结果，按钮直接显示「启用/关闭 N 个」；
 * - 「全部关闭」先内联确认，执行后 6 秒内可撤销；
 * - 搜索、仅看已启用、清除入口与空态都在同一块面板里，不把状态、动作、筛选堆成三行。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionManagerFacade, ExtensionModelRow } from "../../extension-manager/contract.js";
import { Button } from "@woohaa3/ui/primitives";
import { Switch } from "@woohaa3/ui/primitives";
import {
  CheckIcon,
  CloseIcon,
  EyeIcon,
  SearchIcon,
  UnavailableIcon,
  WarningIcon
} from "@woohaa3/ui/icons";
import "../settings.css";

const MODEL_TYPE_LABEL: Record<string, string> = {
  language: "文本",
  image: "图像",
  audio: "语音",
  video: "视频"
};

const MODEL_TYPE_CLASS: Record<string, string> = {
  language: "is-text",
  image: "is-image",
  audio: "is-audio",
  video: "is-video"
};

type ModelToast = {
  seq: number;
  message: string;
  before: readonly { key: string; enabled: boolean }[];
};

type PendingDisable = {
  keys: readonly string[];
  scoped: boolean;
};

export type GeneratedModelsSectionProps = {
  groupId: string;
  models: readonly ExtensionModelRow[];
  manager: ExtensionManagerFacade;
  siteManageable: boolean;
};

export function GeneratedModelsSection({ groupId, models, manager, siteManageable }: GeneratedModelsSectionProps) {
  const [modelQuery, setModelQuery] = useState("");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [pendingDisable, setPendingDisable] = useState<PendingDisable | null>(null);
  const [toast, setToast] = useState<ModelToast | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);

  const modelByKey = useMemo(() => new Map(models.map((row) => [row.modelKey, row])), [models]);
  const total = models.length;
  const canFilter = total > 8;
  const query = canFilter ? modelQuery.trim().toLowerCase() : "";
  const onlyEnabledActive = canFilter && onlyEnabled;
  const enabledModels = models.filter((row) => row.enabled && !row.tombstone).length;
  const ratio = total === 0 ? 0 : Math.round((enabledModels / total) * 100);
  const visibleModels = models.filter((row) => {
    if (onlyEnabledActive && !row.enabled) return false;
    if (!query) return true;
    const haystack = `${row.title} ${row.modelKey} ${row.modelType} ${MODEL_TYPE_LABEL[row.modelType] ?? ""}`.toLowerCase();
    return haystack.includes(query);
  });
  const actionableModels = visibleModels.filter((row) => !row.tombstone);
  const visibleEnabled = actionableModels.filter((row) => row.enabled).length;
  const allEnabled = actionableModels.length > 0 && visibleEnabled === actionableModels.length;
  const allDisabled = actionableModels.length > 0 && visibleEnabled === 0;
  const scopeActive = Boolean(query || onlyEnabledActive);

  useEffect(() => {
    if (pendingDisable) confirmRef.current?.focus();
  }, [pendingDisable]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    },
    []
  );

  const dismissToast = () => {
    if (toastTimer.current !== null) {
      clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
    setToast(null);
  };

  const showToast = (message: string, before: readonly { key: string; enabled: boolean }[]) => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastSeq.current += 1;
    setToast({ seq: toastSeq.current, message, before });
    toastTimer.current = setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 6000);
  };

  const applyBulk = (keys: readonly string[], enabled: boolean) => {
    if (!siteManageable || keys.length === 0) return;
    const before = keys.flatMap((key) => {
      const row = modelByKey.get(key);
      return row ? [{ key, enabled: row.enabled }] : [];
    });
    manager.setModelsEnabled(keys, enabled);
    setPendingDisable(null);
    showToast(`${enabled ? "已启用" : "已关闭"} ${keys.length} 个模型`, before);
  };

  const requestDisableAll = () => {
    if (!siteManageable || actionableModels.length === 0) return;
    setPendingDisable({
      keys: actionableModels.map((row) => row.modelKey),
      scoped: Boolean(query || onlyEnabledActive)
    });
  };

  const undo = () => {
    if (!toast) return;
    const restoreEnabled = toast.before.filter((item) => item.enabled && modelByKey.has(item.key)).map((item) => item.key);
    const restoreDisabled = toast.before.filter((item) => !item.enabled && modelByKey.has(item.key)).map((item) => item.key);
    if (restoreEnabled.length > 0) manager.setModelsEnabled(restoreEnabled, true);
    if (restoreDisabled.length > 0) manager.setModelsEnabled(restoreDisabled, false);
    dismissToast();
  };

  const clearFilters = () => {
    setModelQuery("");
    setOnlyEnabled(false);
    setPendingDisable(null);
    searchRef.current?.focus();
  };

  const handleModelToggle = () => {
    dismissToast();
    setPendingDisable(null);
  };

  const resultCountLabel =
    actionableModels.length === visibleModels.length
      ? `${visibleModels.length} 个结果`
      : `${visibleModels.length} 个结果（${actionableModels.length} 个可操作）`;

  let emptyTitle = "没有匹配的模型";
  let emptyHint = "换个关键词，或清除当前筛选。";
  if (onlyEnabledActive && enabledModels === 0) {
    emptyTitle = "还没有启用的模型";
    emptyHint = "关掉「仅看已启用」后可以重新选择。";
  }

  if (total === 0) {
    return (
      <>
        <h3 className="settings-page__group-title">生成的模型</h3>
        <p className="settings-page__hint" data-testid={`plugin-config-model-summary-${groupId}`}>
          还没有模型。刷新后会出现在这里，再用开关选择启用哪些。
        </p>
      </>
    );
  }

  return (
    <>
      <div className="plugin-config__model-head">
        <h3 className="settings-page__group-title">生成的模型</h3>
        <div className="plugin-config__model-meter">
          <span className="plugin-config__model-meter-track" aria-hidden="true">
            <span className="plugin-config__model-meter-fill" style={{ width: `${ratio}%` }} />
          </span>
          <span className="settings-page__hint" data-testid={`plugin-config-model-summary-${groupId}`}>
            已启用 <strong>{enabledModels}</strong> / {total}
          </span>
        </div>
      </div>

      <div
        className="plugin-config__model-panel"
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.key !== "/") return;
          const target = event.target as HTMLElement;
          const tag = target.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <div className="plugin-config__model-toolbar">
          {canFilter ? (
            <label className="plugin-config__model-search">
              <SearchIcon size={15} />
              <input
                ref={searchRef}
                type="search"
                value={modelQuery}
                placeholder="搜索模型名称、ID 或类型"
                autoComplete="off"
                spellCheck={false}
                aria-label="搜索模型"
                data-testid={`plugin-config-model-filter-${groupId}`}
                onChange={(event) => {
                  setModelQuery(event.target.value);
                  setPendingDisable(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.stopPropagation();
                  if (pendingDisable) setPendingDisable(null);
                  else if (modelQuery) setModelQuery("");
                }}
              />
              {modelQuery ? (
                <button
                  type="button"
                  className="plugin-config__model-search-clear"
                  aria-label="清除搜索"
                  data-testid={`plugin-config-models-clear-filter-${groupId}`}
                  onClick={() => {
                    setModelQuery("");
                    setPendingDisable(null);
                    searchRef.current?.focus();
                  }}
                >
                  <CloseIcon size={11} />
                </button>
              ) : (
                <kbd className="plugin-config__model-search-kbd">/</kbd>
              )}
            </label>
          ) : (
            <span className="plugin-config__model-toolbar-hint">共 {total} 个模型</span>
          )}

          {canFilter ? (
            <button
              type="button"
              className={`plugin-config__model-filter${onlyEnabledActive ? " is-active" : ""}`}
              aria-pressed={onlyEnabledActive}
              data-testid={`plugin-config-models-only-enabled-${groupId}`}
              onClick={() => {
                setOnlyEnabled((value) => !value);
                setPendingDisable(null);
              }}
            >
              <EyeIcon size={14} />
              仅看已启用
              <span className="plugin-config__model-filter-count">{enabledModels}</span>
            </button>
          ) : null}

          <div className="plugin-config__model-bulk">
            <button
              type="button"
              className="plugin-config__model-bulk-btn"
              disabled={!siteManageable || allEnabled}
              data-testid={`plugin-config-models-enable-all-${groupId}`}
              onClick={() => applyBulk(actionableModels.map((row) => row.modelKey), true)}
            >
              <CheckIcon size={14} />
              <span>{scopeActive ? `启用 ${actionableModels.length} 个` : "全部启用"}</span>
            </button>
            <button
              type="button"
              className="plugin-config__model-bulk-btn plugin-config__model-bulk-btn--danger"
              disabled={!siteManageable || allDisabled}
              data-testid={`plugin-config-models-disable-all-${groupId}`}
              onClick={requestDisableAll}
            >
              <UnavailableIcon size={14} />
              <span>{scopeActive ? `关闭 ${actionableModels.length} 个` : "全部关闭"}</span>
            </button>
          </div>
        </div>

        {scopeActive ? (
          <div className="plugin-config__model-scope">
            <span className="plugin-config__model-scope-text">
              {onlyEnabledActive ? "仅看已启用" : null}
              {onlyEnabledActive && query ? " · " : null}
              {query ? `筛选 “${modelQuery.trim()}” · ` : null}
              {resultCountLabel}
            </span>
            <span className="plugin-config__model-scope-hint">批量操作只作用于这些模型</span>
            <button
              type="button"
              className="plugin-config__model-scope-clear"
              onClick={clearFilters}
            >
              清除筛选
            </button>
          </div>
        ) : null}

        {pendingDisable ? (
          <div
            className="plugin-config__model-confirm"
            data-testid={`plugin-config-models-confirm-${groupId}`}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setPendingDisable(null);
            }}
          >
            <span className="plugin-config__model-confirm-icon" aria-hidden="true">
              <WarningIcon size={13} />
            </span>
            <div className="plugin-config__model-confirm-text">
              <strong>
                {pendingDisable.scoped ? "关闭匹配的" : "关闭全部"} {pendingDisable.keys.length} 个模型？
              </strong>
              <span>模型会立即从可用目录中移除；执行后 6 秒内可撤销。</span>
            </div>
            <div className="plugin-config__model-confirm-actions">
              <Button
                size="sm"
                tone="ghost"
                data-testid={`plugin-config-models-cancel-disable-${groupId}`}
                onClick={() => setPendingDisable(null)}
              >
                取消
              </Button>
              <Button
                ref={confirmRef}
                size="sm"
                tone="danger"
                data-testid={`plugin-config-models-confirm-disable-${groupId}`}
                onClick={() => applyBulk(pendingDisable.keys, false)}
              >
                确认关闭
              </Button>
            </div>
          </div>
        ) : null}

        {visibleModels.length > 0 ? (
          <ul className="settings-page__list plugin-config__models" data-testid={`plugin-config-models-${groupId}`}>
            {visibleModels.map((row) => (
              <ModelRow
                key={row.modelKey}
                row={row}
                manager={manager}
                siteManageable={siteManageable}
                onToggle={handleModelToggle}
              />
            ))}
          </ul>
        ) : (
          <div className="plugin-config__model-empty" data-testid={`plugin-config-models-empty-${groupId}`}>
            <SearchIcon size={22} />
            <p className="plugin-config__model-empty-title">{emptyTitle}</p>
            <p className="plugin-config__model-empty-hint">{emptyHint}</p>
            <Button
              size="sm"
              tone="neutral"
              data-testid={`plugin-config-models-clear-filters-${groupId}`}
              onClick={clearFilters}
            >
              清除筛选
            </Button>
          </div>
        )}
      </div>

      {toast ? (
        <div
          key={toast.seq}
          className="plugin-config__model-toast"
          role="status"
          data-testid={`plugin-config-models-toast-${groupId}`}
        >
          <span className="plugin-config__model-toast-icon" aria-hidden="true">
            <CheckIcon size={13} />
          </span>
          <span className="plugin-config__model-toast-text">{toast.message}</span>
          <button
            type="button"
            className="plugin-config__model-toast-undo"
            data-testid={`plugin-config-models-undo-${groupId}`}
            onClick={undo}
          >
            撤销
          </button>
          <span className="plugin-config__model-toast-progress" aria-hidden="true" />
        </div>
      ) : null}
    </>
  );
}

function ModelRow({
  row,
  manager,
  siteManageable,
  onToggle
}: {
  row: ExtensionModelRow;
  manager: ExtensionManagerFacade;
  siteManageable: boolean;
  onToggle: () => void;
}) {
  const typeLabel = MODEL_TYPE_LABEL[row.modelType] ?? row.modelType;
  const typeClass = MODEL_TYPE_CLASS[row.modelType] ?? "is-default";
  return (
    <li className="plugin-config__model" data-model-key={row.modelKey}>
      <div className="plugin-config__model-text">
        <div className="plugin-config__model-title">
          <span className="plugin-config__model-name">{row.title}</span>
          {row.isDefault ? <span className="plugin-config__model-default">默认</span> : null}
        </div>
        <div className="plugin-config__model-meta">
          <span className={`plugin-config__model-type ${typeClass}`}>{typeLabel}</span>
          {row.executable ? null : <span className="plugin-config__model-flag">不可执行</span>}
        </div>
      </div>
      <div className="plugin-state">
        <Switch
          checked={row.enabled}
          disabled={!siteManageable || row.tombstone}
          onCheckedChange={(next) => {
            onToggle();
            manager.setModelEnabled(row.modelKey, next);
          }}
          aria-label={`${row.title}：${row.enabled ? "已启用" : "已停用"}`}
          testId={`plugin-config-model-switch-${row.modelKey}`}
        />
      </div>
    </li>
  );
}
