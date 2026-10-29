/**
 * Mention prompt editor（change: add-reference-inputs-and-mentions，任务 4.1–4.4 / design D7）。
 *
 * 受控 Lexical 纯文本编辑器 + mention 节点：
 * - `value` 是规范 token string（事实源）；`onChange` 回传 token string；
 * - 外部 value 变化时重建文档（token string 是唯一事实源）；
 * - 支持 IME composition、键盘导航、撤销重做、整 token 删除；
 * - `@` 触发候选菜单，只列出宿主提供的当前节点直接输入候选。
 *
 * 关键 Lexical 约束：
 * - root 只能包含 **element 节点**（ParagraphNode）；文本/mention 必须放进段落。
 * - typeahead 的 `anchorElementRef` 是 Lexical 自有的容器，菜单必须 `createPortal`
 *   进去，不能把它当成自己元素的 ref（否则 React 与 Lexical 争抢同一 DOM）。
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalTypeaheadMenuPlugin, MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND
} from "lexical";
import type { LexicalEditor } from "lexical";
import { $createMentionNode, MentionNode } from "./mention-node.js";
import { setEditorFromTokenString } from "./mention-token-writer.js";
import { LexicalTypeaheadMenu } from "./lexical-typeahead-menu.js";
import { NumberedReferencePlugin, normalizeNumberedReferences } from "./numbered-reference-plugin.js";
import { SnippetTypeaheadPlugin } from "./snippet-typeahead.js";
import { MentionClipboardPlugin } from "./clipboard-plugin.js";
import { resolvePromptSubmitKey } from "../prompt-keyboard.js";
import type { MentionCandidate, MentionSelectionApi, SnippetTrigger } from "./mention-types.js";

export type {
  MentionCandidate,
  MentionSelectionApi,
  SnippetCandidate,
  SnippetTrigger
} from "./mention-types.js";

export type MentionEditorProps = {
  value: string;
  onChange: (next: string) => void;
  candidates: readonly MentionCandidate[];
  placeholder?: string;
  disabled?: boolean;
  onSubmit?: () => void;
  ariaLabel?: string;
  /** 选区 API 变更通知；卸载时以 null 调用。 */
  onSelectionApi?: (api: MentionSelectionApi | null) => void;
  /**
   * `#` 片段引用触发器（change: add-prompt-snippet-library，design D10 修订）。
   * 提供时在编辑器中键入 `#` 打开片段候选；缺省（如片段插件未装配）不出现该入口。
   */
  snippetTrigger?: SnippetTrigger;
  /**
   * 平台与提交门禁（change: 2026-10-09-improve-canvas-workflow，任务 3.2）。
   * 缺省时按非 macOS、可提交处理，保持既有调用可用。
   */
  isMac?: boolean;
  readOnly?: boolean;
  blocked?: boolean;
};

/**
 * 把 token string 写入编辑器：root 只挂 ParagraphNode；换行拆成新段落，
 * 段落内依次追加文本节点与 mention 节点。
 */
export { setEditorFromTokenString } from "./mention-token-writer.js";
/**
 * 从编辑器读出 token string。
 *
 * Lexical 的 root.getTextContent() 用两个换行分隔段落；这里用单个换行，
 * 与写入时逐行创建段落的规则一致。段落内仍调用 MentionNode.getTextContent()
 * 返回规范 token，保留用户输入的空行及首尾换行。
 */
function readTokenString(editor: LexicalEditor): string {
  let result = "";
  editor.getEditorState().read(() => {
    result = $getRoot().getChildren().map((paragraph) => paragraph.getTextContent()).join("\n");
  });
  return result;
}

class CandidateOption extends MenuOption {
  candidate: MentionCandidate;
  constructor(candidate: MentionCandidate) {
    // key 必须是稳定唯一值；label 可能重名，用 slotId。
    super(candidate.slotId);
    this.candidate = candidate;
  }
}

/** 外部受控 value → 编辑器文档。仅在编辑器当前值与 value 不一致时重建。 */
function TokenSyncPlugin({ value, candidates }: { value: string; candidates: readonly MentionCandidate[] }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (readTokenString(editor) === value) return;
    setEditorFromTokenString(editor, normalizeNumberedReferences(value, candidates));
  }, [editor, value, candidates]);
  return null;
}

/**
 * 选区 API 插件：把 Lexical 选区映射为 token-string 字符偏移，并支持按偏移替换。
 *
 * 采用「读 token string → 字符级 splice → 重建文档」的策略：mention 节点的
 * `getTextContent()` 就是规范 token，因此字符偏移与受控 value 同一空间，避免 Lexical
 * 节点级 offset 的歧义。
 */
function SelectionApiPlugin({ onSelectionApi }: { onSelectionApi?: (api: MentionSelectionApi | null) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!onSelectionApi) return undefined;
    const api: MentionSelectionApi = {
      getSelection: () => {
        let selection: { start: number; end: number } | null = null;
        editor.getEditorState().read(() => {
          const range = $getSelection();
          if (!$isRangeSelection(range)) return;
          const anchor = absoluteOffset(range.anchor.key, range.anchor.offset);
          const focus = absoluteOffset(range.focus.key, range.focus.offset);
          if (anchor === null || focus === null || anchor === focus) return;
          selection = { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
        });
        return selection;
      },
      replaceSelection: (text: string) => {
        let next = "";
        editor.getEditorState().read(() => {
          const current = readTokenString(editor);
          const range = $getSelection();
          let start = current.length;
          let end = current.length;
          if ($isRangeSelection(range)) {
            const anchor = absoluteOffset(range.anchor.key, range.anchor.offset);
            const focus = absoluteOffset(range.focus.key, range.focus.offset);
            if (anchor !== null && focus !== null) {
              start = Math.min(anchor, focus);
              end = Math.max(anchor, focus);
            }
          }
          next = `${current.slice(0, start)}${text}${current.slice(end)}`;
        });
        setEditorFromTokenString(editor, next);
      }
    };
    onSelectionApi(api);
    return () => onSelectionApi(null);
  }, [editor, onSelectionApi]);
  return null;
}

/** 计算某个 Lexical 节点 key 在整篇 token string 中的绝对字符偏移。 */
function absoluteOffset(key: string, offset: number): number | null {
  let cursor = 0;
  let found: number | null = null;
  for (const paragraph of $getRoot().getChildren()) {
    if (paragraph.getKey() === key) {
      found = cursor + offset;
      break;
    }
    if ($isElementNode(paragraph)) {
      let advance = 0;
      let hit = false;
      for (const child of paragraph.getChildren()) {
        if (child.getKey() === key) {
          found = cursor + advance + offset;
          hit = true;
          break;
        }
        advance += child.getTextContent().length;
      }
      if (hit) break;
    }
    cursor += paragraph.getTextContent().length + 1;
  }
  return found;
}

/**
 * Enter 提交策略（change: 2026-10-09-improve-canvas-workflow，任务 3.2）。
 *
 * 与 textarea 共用 `resolvePromptSubmitKey`：Enter 生成、Shift+Enter 换行；
 * 中文输入法组合与 `@`/`#` 候选菜单优先消费 Enter。
 */
function SubmitPlugin({
  onSubmit,
  isMac,
  disabled,
  blocked,
  candidateMenuOpen,
}: {
  onSubmit?: () => void;
  isMac: boolean;
  disabled: boolean;
  blocked: boolean;
  candidateMenuOpen: MutableRefObject<boolean>;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!onSubmit) return undefined;
    return editor.registerCommand<KeyboardEvent | null>(
      KEY_ENTER_COMMAND,
      (event) => {
        const decision = resolvePromptSubmitKey(
          {
            key: "Enter",
            ctrlKey: event?.ctrlKey ?? false,
            metaKey: event?.metaKey ?? false,
            shiftKey: event?.shiftKey ?? false,
            altKey: event?.altKey ?? false,
            repeat: event?.repeat ?? false,
            isComposing: event?.isComposing ?? false,
            keyCode: event?.keyCode
          },
          {
            isMac,
            readOnly: disabled,
            blocked: blocked || disabled,
            busy: blocked,
            candidateMenuOpen: candidateMenuOpen.current === true
          }
        );
        if (decision.action === "submit") {
          onSubmit();
          event?.preventDefault?.();
          return true;
        }
        // newline/ime/candidate/none 交回 Lexical 默认处理（换行或候选选择）。
        return false;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, onSubmit, isMac, disabled, blocked, candidateMenuOpen]);
  return null;
}

function MentionTypeaheadPlugin({ candidates, menuOpenRef }: { candidates: readonly MentionCandidate[]; menuOpenRef: MutableRefObject<boolean> }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => {
    menuOpenRef.current = query !== null;
    return () => {
      menuOpenRef.current = false;
    };
  }, [query, menuOpenRef]);
  const options = useMemo(
    () =>
      candidates
        .filter((candidate) => candidate.label.toLowerCase().includes((query ?? "").toLowerCase()))
        .map((candidate) => new CandidateOption(candidate)),
    [candidates, query]
  );

  const onSelectOption = useCallback(
    (
      option: CandidateOption,
      nodeToRemove: { remove: () => void } | null,
      closeMenu: () => void
    ) => {
      editor.update(() => {
        nodeToRemove?.remove();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertNodes([
            $createMentionNode({
              type: option.candidate.type,
              slotId: option.candidate.slotId,
              label: option.candidate.label
            })
          ]);
        }
      });
      closeMenu();
      setQuery(null);
    },
    [editor]
  );

  return (
    <LexicalTypeaheadMenuPlugin<CandidateOption>
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={(text) => {
        const match = /@([^\s@]*)$/.exec(text);
        return match
          ? { leadOffset: match.index, matchingString: match[1] ?? "", replaceableString: match[0] }
          : null;
      }}
      options={options}
      menuRenderFn={(anchorElementRef, itemProps) => {
        if (!anchorElementRef.current || itemProps.options.length === 0) return null;
        // 必须 portal 进 Lexical 自有的锚点容器，避免与 React 争抢 DOM。
        return createPortal(
          <LexicalTypeaheadMenu
            label="参考候选"
            anchor={anchorElementRef.current}
            editorRoot={editor.getRootElement()}
            options={itemProps.options}
            selectedIndex={itemProps.selectedIndex}
            setHighlightedIndex={itemProps.setHighlightedIndex}
            selectOptionAndCleanUp={itemProps.selectOptionAndCleanUp}
            renderLabel={(option) => (option as CandidateOption).candidate.label}
          />,
          anchorElementRef.current
        );
      }}
    />
  );
}

export function MentionEditor(props: MentionEditorProps) {
  const candidateMenuOpen = useRef(false);
  const initialConfig = useMemo(
    () => ({
      namespace: "woohaa3-mention",
      nodes: [MentionNode],
      editable: !props.disabled,
      onError: (error: Error) => {
        // 编辑器错误不得中断页面。
        console.error("[mention-editor]", error);
      },
      theme: {
        paragraph: "mention-editor__paragraph",
        text: { base: "mention-editor__text" }
      }
    }),
    [props.disabled]
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="mention-editor" data-disabled={props.disabled ? "true" : undefined}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="mention-editor__input"
              aria-label={props.ariaLabel ?? "提示词"}
              aria-multiline="true"
              spellCheck={false}
            />
          }
          placeholder={<div className="mention-editor__placeholder">{props.placeholder ?? "输入提示词，@ 引用已连接素材"}</div>}
          ErrorBoundary={MentionEditorErrorBoundary as never}
        />
        <HistoryPlugin />
        <OnChangePlugin
          ignoreSelectionChange
          onChange={(_state, editor) => {
            props.onChange(readTokenString(editor));
          }}
        />
        <TokenSyncPlugin value={props.value} candidates={props.candidates} />
        <NumberedReferencePlugin candidates={props.candidates} />
        <MentionClipboardPlugin />
        <MentionTypeaheadPlugin candidates={props.candidates} menuOpenRef={candidateMenuOpen} />
        {props.snippetTrigger ? <SnippetTypeaheadPlugin trigger={props.snippetTrigger} menuOpenRef={candidateMenuOpen} /> : null}
        <SubmitPlugin
          onSubmit={props.onSubmit}
          isMac={props.isMac ?? false}
          disabled={props.disabled ?? false}
          blocked={props.blocked ?? false}
          candidateMenuOpen={candidateMenuOpen}
        />
        <SelectionApiPlugin onSelectionApi={props.onSelectionApi} />
      </div>
    </LexicalComposer>
  );
}

/** 编辑器错误边界：捕获 Lexical 渲染错误，避免中断页面。 */
class MentionEditorErrorBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error): void {
    this.props.onError(error);
    console.error("[mention-editor]", error);
  }
  render(): ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}
