/**
 * 参考素材 media tile strip 与 panel-owned picker
 * （change: 2026-09-28-align-execution-reference-and-expansion，task 2 / 3；
 *   前身：add-reference-inputs-and-mentions 的 ReferenceTileStrip）。
 *
 * - `ReferenceTileStrip`：按 canonical mapping 顺序渲染稳定 48px 方形 tile，始终保留同尺寸
 *   虚线 add tile；单行横向滚动，不折叠、不换行。删除只在 hover/focus 出现；图片/视频可
 *   悬浮预览。
 * - `ReferencePicker`：非模态 anchored listbox，缩略图 + 名称 + 类型 + 禁用原因，roving focus。
 *
 * 纯 UI：不读 Canvas Store、不发命令。数据与回调由宿主（`NodeExecutionPanel`）注入。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ReferenceItem, ReferenceItemStatus } from "./reference-items.js";
import { ReferenceMediaPreview } from "./reference-media-preview.js";
import {
	Button,
	CloseIcon,
	FileTextIcon,
	FilmIcon,
	HourglassIcon,
	ImageIcon,
	MusicIcon,
	PlusIcon,
	Popover,
	WarningIcon
} from "@woohaa3/ui";

export type ReferenceTileStripProps = {
  items: readonly ReferenceItem[];
  /** 移除某个参考（提交 edge 删除）。 */
  onRemove?: (item: ReferenceItem) => void;
  /** 打开 picker；回调携带 add tile 元素作为锚点。 */
  onAdd?: (anchor: HTMLElement) => void;
  disabled?: boolean;
  /**
   * 当前 panel presentation；变化时销毁悬浮预览（design D2 / task 2.4）。
   */
  presentation?: string;
  /** 受控 picker 内容（由宿主渲染）；提供时 add tile 作为其 Popover trigger。 */
  picker?: ReactNode;
  /** picker 是否打开。 */
  pickerOpen?: boolean;
  /** 打开/关闭 picker（受控）。 */
  onPickerOpenChange?: (open: boolean) => void;
};

export function ReferenceTileStrip(props: ReferenceTileStripProps) {
  const addButton = (
    <button
      type="button"
      className="ref-tile ref-tile--add"
      aria-label="选择参考素材节点"
      title="选择参考素材节点"
      data-role="add"
      onClick={(event) => props.onAdd?.(event.currentTarget)}
      disabled={props.disabled}
    >
      <PlusGlyph />
    </button>
  );
  return (
    <div className="ref-tile-strip" role="list" aria-label="参考素材" data-count={props.items.length}>
      {props.onAdd ? (
        props.picker ? (
          // 受控 Popover：add tile 作为 trigger，portal/碰撞/outside dismiss 交 primitive。
          <Popover
            open={props.pickerOpen ?? false}
            onOpenChange={(next) => props.onPickerOpenChange?.(next)}
            side="top"
            align="start"
            className="ref-picker-popover"
            trigger={addButton}
          >
            {props.picker}
          </Popover>
        ) : (
          addButton
        )
      ) : null}
      {props.items.map((item) => (
        <ReferenceTile
          key={item.slotId || item.sourceNodeId}
          item={item}
          {...(props.onRemove ? { onRemove: props.onRemove } : {})}
          {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
          {...(props.presentation !== undefined ? { presentation: props.presentation } : {})}
        />
      ))}
    </div>
  );
}

function ReferenceTile({
  item,
  onRemove,
  disabled,
  presentation
}: {
  item: ReferenceItem;
  onRemove?: (item: ReferenceItem) => void;
  disabled?: boolean;
  presentation?: string;
}) {
  const [surface, setSurface] = useState<"idle" | "hover" | "focus">("idle");
  const anchorRef = useRef<HTMLDivElement | null>(null);

  // presentation 切换时销毁预览（design D2）。
  useEffect(() => {
    setSurface("idle");
  }, [presentation]);

  const previewable = item.status === "ready" && item.previewUrl !== null && (item.mediaKind === "image" || item.mediaKind === "video");
  const showPreview = surface !== "idle" && previewable;
  // 缩略图只用于图片；视频预览地址是视频文件本身（不是 poster），tile 用视频图标，悬浮时才
  // 用受控 `<video preload=metadata>` 呈现首帧，绝不自动播放完整媒体（design D2）。
  const showImageThumb = item.status === "ready" && item.mediaKind === "image" && Boolean(item.previewUrl);
  const accessibleName = `${item.label}，角色 ${item.role}，${statusText(item)}${item.blockingReason ? `：${item.blockingReason}` : ""}`;

  return (
    <div
      ref={anchorRef}
      className={`ref-tile ref-tile--${item.status}`}
      role="listitem"
      tabIndex={0}
      data-slot-id={item.slotId}
      data-role={item.role}
      data-media-kind={item.mediaKind ?? "none"}
      data-status={item.status}
      aria-label={accessibleName}
      title={item.blockingReason ?? item.label}
      onMouseEnter={() => setSurface("hover")}
      onMouseLeave={() => setSurface((current) => (current === "hover" ? "idle" : current))}
      onFocus={(event) => {
        setSurface("focus");
        event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }}
      onBlur={() => setSurface((current) => (current === "focus" ? "idle" : current))}
      onKeyDown={(event) => {
        // 删除键是显式动作；避免 tile 被点开时误触发。
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          if (!disabled) onRemove?.(item);
        }
      }}
    >
      <span className="ref-tile__media" aria-hidden="true">
        {showImageThumb && item.previewUrl ? (
          <img className="ref-tile__image" src={item.previewUrl} alt="" />
        ) : (
          <GlyphFor item={item} />
        )}
      </span>
      <span className="ref-tile__role" aria-hidden="true">
        {item.label}
      </span>
      {onRemove ? (
        <button
          type="button"
          className="ref-tile__remove"
          aria-label={`移除参考 ${item.label}`}
          data-testid="reference-remove"
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(item);
          }}
        >
          <CloseGlyph />
        </button>
      ) : null}
      {showPreview && item.previewUrl ? (
        <ReferenceMediaPreview
          kind={item.mediaKind === "video" ? "video" : "image"}
          url={item.previewUrl}
          alt={item.label}
          anchor={anchorRef.current}
        />
      ) : null}
    </div>
  );
}

export type ReferencePickerCandidate = {
  nodeId: string;
  label: string;
  mediaKind: string;
  /** 稳定同源缩略图（仅展示，不写入命令）。 */
  previewUrl?: string | null;
  disabled?: boolean;
  reason?: string;
};
export type ReferencePickerProps = {
  candidates: readonly ReferencePickerCandidate[];
  /** 受控 active index（roving focus）；由宿主在打开/过滤时重置。 */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onPick: (nodeId: string) => void;
  onClose: () => void;
};

/**
 * 参考素材 picker 内容（listbox + roving focus）。
 *
 * 迁移后由 `ReferencePicker` 用受控 Popover 承载 portal/碰撞/outside dismiss；
 * 本组件只负责 listbox 结构与键盘导航，保留 `.ref-picker*` class 与 `data-testid`
 * 以稳定测试与 E2E 选择器。
 */
export function ReferencePickerContent(props: {
  candidates: readonly ReferencePickerCandidate[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onPick: (nodeId: string) => void;
  onClose: () => void;
}) {
  const { candidates, activeIndex } = props;
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();

  useEffect(() => {
    const node = optionRefs.current[activeIndex];
    node?.focus();
  }, [activeIndex, candidates.length]);

  const move = useCallback(
    (delta: number) => {
      const total = candidates.length;
      if (total === 0) return;
      let next = activeIndex;
      for (let step = 0; step < total; step += 1) {
        next = (next + delta + total) % total;
        if (!candidates[next]?.disabled) break;
      }
      props.onActiveIndexChange(next);
    },
    [activeIndex, candidates, props]
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      const index = candidates.findIndex((candidate) => !candidate.disabled);
      if (index >= 0) props.onActiveIndexChange(index);
    } else if (event.key === "End") {
      event.preventDefault();
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (!candidates[index]?.disabled) {
          props.onActiveIndexChange(index);
          break;
        }
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const candidate = candidates[activeIndex];
      if (candidate && !candidate.disabled) props.onPick(candidate.nodeId);
    }
  };

  return (
    <div
      className="ref-picker"
      role="listbox"
      id={listboxId}
      aria-label="选择参考素材节点"
      onKeyDown={onKeyDown}
      data-testid="reference-picker"
    >
      {candidates.length === 0 ? (
        <p className="ref-picker__empty">没有可连接的素材节点</p>
      ) : candidates.every((candidate) => candidate.disabled) ? (
        <p className="ref-picker__empty" role="status">
          没有可用候选：{candidates[0]?.reason ?? "候选节点尚无可用输出"}
        </p>
      ) : (
        <ul className="ref-picker__list">
          {candidates.map((candidate, index) => (
            <li key={candidate.nodeId}>
              <button
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={index === activeIndex ? 0 : -1}
                className="ref-picker__item"
                data-node-id={candidate.nodeId}
                disabled={candidate.disabled}
                title={candidate.reason}
                onClick={() => props.onPick(candidate.nodeId)}
                onFocus={() => props.onActiveIndexChange(index)}
              >
                <span className="ref-picker__thumb" aria-hidden="true">
                  {candidate.previewUrl && (candidate.mediaKind === "image" || candidate.mediaKind === "video") ? (
                    <img src={candidate.previewUrl} alt="" />
                  ) : (
                    <span className="ref-picker__thumb-glyph">{candidate.mediaKind.slice(0, 1).toUpperCase()}</span>
                  )}
                </span>
                <span className="ref-picker__copy">
                  <span className="ref-picker__label">{candidate.label}</span>
                  <span className="ref-picker__kind">{candidate.mediaKind}</span>
                </span>
                {candidate.disabled && candidate.reason ? (
                  <span className="ref-picker__reason">{candidate.reason}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" className="ref-picker__close" onClick={props.onClose}>
        关闭
      </Button>
    </div>
  );
}

function statusText(item: ReferenceItem): string {
  if (item.status === "ready") return "就绪";
  if (item.status === "waiting") return "等待中";
  return "不可用";
}

function GlyphFor({ item }: { item: ReferenceItem }) {
	if (item.status === "waiting") return <WaitingGlyph />;
	if (item.status === "invalid") return <InvalidGlyph />;
	if (item.mentionType === "input_video") return <VideoGlyph />;
	if (item.mentionType === "input_audio") return <AudioGlyph />;
	if (item.mentionType === "input_text") return <TextGlyph />;
	return <ImageGlyph />;
}

/** tile 图标统一走生产 icon facade；保留 `data-glyph` 稳定标识与 `ref-tile__glyph` class。 */
function Glyph({ testid, children }: { testid: string; children: React.ReactNode }) {
	return (
		<span className="ref-tile__glyph" data-glyph={testid}>
			{children}
		</span>
	);
}

function PlusGlyph() {
	return (
		<Glyph testid="add">
			<PlusIcon className="ref-tile__glyph-icon" />
		</Glyph>
	);
}
function ImageGlyph() {
	return (
		<Glyph testid="image">
			<ImageIcon className="ref-tile__glyph-icon" />
		</Glyph>
	);
}
function VideoGlyph() {
	return (
		<Glyph testid="video">
			<FilmIcon className="ref-tile__glyph-icon" />
		</Glyph>
	);
}
function AudioGlyph() {
	return (
		<Glyph testid="audio">
			<MusicIcon className="ref-tile__glyph-icon" />
		</Glyph>
	);
}
function TextGlyph() {
	return (
		<Glyph testid="text">
			<FileTextIcon className="ref-tile__glyph-icon" />
		</Glyph>
	);
}
function WaitingGlyph() {
	return (
		<Glyph testid="waiting">
			<HourglassIcon className="ref-tile__glyph-icon" />
		</Glyph>
	);
}
function InvalidGlyph() {
	return (
		<Glyph testid="invalid">
			<WarningIcon className="ref-tile__glyph-icon" />
		</Glyph>
	);
}
function CloseGlyph() {
	return <CloseIcon className="ref-tile__remove-icon" strokeWidth={2.4} />;
}

export type { ReferenceItemStatus };
