/**
 * Lexical typeahead 菜单呈现（`@`/`#` 共用）
 * （change: adopt-radix-remaining-canvas-ui，任务 4.1/4.2 / design D6，显式例外）。
 *
 * query 过滤、键盘导航（Arrow/Enter/Escape）与 dismiss 由 Lexical
 * `LexicalTypeaheadMenuPlugin` 拥有，且菜单必须 `createPortal` 进 Lexical 自有的锚点容器，
 * 因此**不能用** Radix 菜单/listbox primitive 接管其生命周期。这里把 `@`/`#` 两个 typeahead
 * 的重复 markup 收敛为一个本地组件，保持 `role="listbox"`/`role="option"` 契约与既有
 * `.mention-menu*` class（E2E 选择器）。
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";

export type LexicalTypeaheadMenuOption = MenuOption & {
  /** `@` 候选的可选 disabled 标记。 */
  candidate?: { disabled?: boolean };
};

export function LexicalTypeaheadMenu<T extends LexicalTypeaheadMenuOption>({
  label,
  anchor,
  editorRoot,
  options,
  selectedIndex,
  setHighlightedIndex,
  selectOptionAndCleanUp,
  renderLabel
}: {
  label: string;
  anchor?: HTMLElement;
  editorRoot?: HTMLElement | null;
  options: readonly T[];
  selectedIndex: number | null;
  setHighlightedIndex: (index: number) => void;
  selectOptionAndCleanUp: (option: T) => void;
  renderLabel: (option: T) => ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const selection = window.getSelection();
      const range = selection?.rangeCount && editorRoot?.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
      const rect = range && typeof range.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : (editorRoot ?? anchor).getBoundingClientRect();
      const height = menuRef.current?.getBoundingClientRect().height ?? 220;
      const bottomDock = Boolean(editorRoot?.closest('.mc-panel[data-surface="dock"]'));
      setPosition(typeaheadMenuPosition(rect, height, window.innerWidth, window.innerHeight, bottomDock));
    };
    let active = true;
    place();
    // Lexical may attach its portal anchor after our layout effect. Re-measure after attachment.
    queueMicrotask(() => { if (active) place(); });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (menuRef.current) observer?.observe(menuRef.current);
    if (editorRoot) observer?.observe(editorRoot);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, editorRoot, options]);
  return (
    <div ref={menuRef} style={position} className="mention-menu" role="listbox" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.key}
          type="button"
          role="option"
          aria-selected={selectedIndex === index}
          className={
            selectedIndex === index ? "mention-menu__item mention-menu__item--active" : "mention-menu__item"
          }
          onMouseEnter={() => setHighlightedIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => selectOptionAndCleanUp(option)}
          disabled={option.candidate?.disabled}
        >
          {renderLabel(option)}
        </button>
      ))}
    </div>
  );
}

/** Place the caret-anchored list above bottom docks and keep its readable width inside the viewport. */
export function typeaheadMenuPosition(anchor: { left: number; top: number; bottom: number }, height: number, viewportWidth: number, viewportHeight: number, preferAbove: boolean): CSSProperties {
  const margin = 12, gap = 8;
  const width = Math.min(360, viewportWidth - margin * 2);
  const availableAbove = Math.max(0, anchor.top - margin - gap);
  const availableBelow = Math.max(0, viewportHeight - anchor.bottom - margin - gap);
  const above = preferAbove || (availableBelow < Math.min(height, 220) && availableAbove > availableBelow);
  const maxHeight = Math.min(220, above ? availableAbove : availableBelow);
  const visibleHeight = Math.min(height, maxHeight);
  return {
    position: "fixed", width,
    left: Math.max(margin, Math.min(anchor.left, viewportWidth - width - margin)),
    top: above ? Math.max(margin, anchor.top - visibleHeight - gap) : anchor.bottom + gap,
    maxHeight
  };
}
