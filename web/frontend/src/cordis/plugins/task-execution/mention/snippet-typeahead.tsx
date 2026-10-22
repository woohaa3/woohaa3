/**
 * `#` 片段候选菜单（change: add-prompt-snippet-library，design D10 修订；
 * change: 2026-10-09-improve-canvas-workflow：抽出独立模块以保持文件体积守卫）。
 *
 * 与 `@` mention 菜单并列：`#` 触发片段搜索，选中后把宿主 materialize 出的正文插入当前
 * 选区（无选区插入光标）。片段正文是普通 token 文本，插入后即成为普通编辑内容。
 */
import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalTypeaheadMenuPlugin, MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $getSelection, $isRangeSelection } from "lexical";
import { LexicalTypeaheadMenu } from "./lexical-typeahead-menu.js";
import type { SnippetCandidate, SnippetTrigger } from "./mention-types.js";

class SnippetOption extends MenuOption {
  snippet: SnippetCandidate;
  constructor(snippet: SnippetCandidate) {
    super(snippet.id);
    this.snippet = snippet;
  }
}

export function SnippetTypeaheadPlugin({ trigger, menuOpenRef }: { trigger: SnippetTrigger; menuOpenRef: MutableRefObject<boolean> }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [results, setResults] = useState<readonly SnippetCandidate[]>([]);

  useEffect(() => {
    menuOpenRef.current = query !== null;
    return () => {
      menuOpenRef.current = false;
    };
  }, [query, menuOpenRef]);

  useEffect(() => {
    if (query === null) return undefined;
    let cancelled = false;
    void trigger.search(query).then((found) => {
      if (!cancelled) setResults(found);
    });
    return () => {
      cancelled = true;
    };
  }, [query, trigger]);

  const options = useMemo(() => results.map((snippet) => new SnippetOption(snippet)), [results]);

  const onSelectOption = useCallback(
    (
      option: SnippetOption,
      nodeToRemove: { remove: () => void } | null,
      closeMenu: () => void
    ) => {
      const text = trigger.select(option.snippet.id);
      if (text !== null) {
        editor.update(() => {
          nodeToRemove?.remove();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) selection.insertText(text);
        });
      } else {
        nodeToRemove?.remove();
      }
      closeMenu();
      setQuery(null);
    },
    [editor, trigger]
  );

  return (
    <LexicalTypeaheadMenuPlugin<SnippetOption>
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={(text) => {
        const match = /(?:^|\s)#([^\s#]*)$/.exec(text);
        return match
          ? { leadOffset: match.index, matchingString: match[1] ?? "", replaceableString: match[0] }
          : null;
      }}
      options={options}
      menuRenderFn={(anchorElementRef, itemProps) => {
        if (!anchorElementRef.current || itemProps.options.length === 0) return null;
        return createPortal(
          <LexicalTypeaheadMenu
            label="片段候选"
            anchor={anchorElementRef.current}
            editorRoot={editor.getRootElement()}
            options={itemProps.options}
            selectedIndex={itemProps.selectedIndex}
            setHighlightedIndex={itemProps.setHighlightedIndex}
            selectOptionAndCleanUp={itemProps.selectOptionAndCleanUp}
            renderLabel={(option) => (option as SnippetOption).snippet.name}
          />,
          anchorElementRef.current
        );
      }}
    />
  );
}
