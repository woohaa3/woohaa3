/**
 * Showcase 自有侧栏（change: 2026-09-29-refresh-showcase-shell，design D1/D7；
 *  change: adopt-radix-lucide-canvas-ui 任务 8.1：改为消费生产 Collapsible/IconButton/
 *  Tooltip 与 icon facade，删除 Showcase 平行 Radix/Lucide 实现）。
 *
 * Ladle 只负责 story 发现 / 构建 / `mode=preview` 下渲染当前 story；本组件取代 Ladle
 * 自带侧栏，用与顶部工具栏同一套设计语言（生产 primitives + `--app-*` token）。
 *
 * 数据与导航：
 * - story 清单来自 Ladle `/meta.json`（dev 与 build 都有），不复制 story 逻辑；
 * - 切换 story 走 Ladle Context 的 `UpdateStory`（URL/返回键仍由 Ladle 维护），脱离 Ladle 时退化为直接改 URL。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLadleContext } from "@ladle/react";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger, IconButton, Tooltip } from "@woohaa3/ui/primitives";
import { ChevronRightIcon, CloseIcon, FileImageIcon, FileTextIcon, FilmIcon, LayoutGridIcon, MusicIcon, SearchIcon, SettingsIcon, SparklesIcon } from "@woohaa3/ui/icons";
import {
  buildStoryTree,
  parseStoryMeta,
  storyFromSearch,
  type StoryMetaEntry,
  type StoryTreeNode
} from "./story-nav.js";

/**
 * Ladle 的 `useLink()` 要求 Provider 位于 Ladle Context 内（真实 Ladle 渲染时成立）。
 * 单元测试等脱离 Ladle 的场景退化为「直接用 URL 导航」，避免硬依赖内部 context。
 */
function useStoryNavigation(): (story: string) => void {
  const context = useLadleContext() as { dispatch?: (action: unknown) => void } | undefined;
  return useCallback(
    (story: string) => {
      if (context?.dispatch) {
        context.dispatch({ type: "update-story", value: story });
        return;
      }
      const url = new URL(window.location.href);
      url.searchParams.set("story", story);
      window.history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [context]
  );
}

/**
 * 分组的 story 前缀：取该分组下第一个叶子的 story ID 去掉最后一段。
 *
 * 不能从分组标题拼：Ladle 的 story ID 会小写 ASCII 并把空格换成 `-`，而标题保留
 * 原文（如「公共 UI/Dialog 与 portal」）；标题拼出的 `公共-UI--...` 与 ID 不匹配，
 * 当前 story 在组内时祖组不会自动展开，侧栏就没有可见的 active 叶子。
 */
function groupPrefix(node: StoryTreeNode, depth: number): string {
  let cursor: StoryTreeNode = node;
  while (cursor.children.length > 0) cursor = cursor.children[0]!;
  if (!cursor.storyId) return "";
  const segments = cursor.storyId.split("--");
  return `${segments.slice(0, depth + 1).join("--")}--`;
}

/** 按 story 名字猜一个叶子图标，让树可快速扫读（纯装饰）。 */
function leafIcon(name: string) {
  const has = (...tokens: string[]) => tokens.some((token) => name.includes(token));
  if (has("图", "图片")) return FileImageIcon;
  if (has("视频", "抽帧", "截帧")) return FilmIcon;
  if (has("音频", "音乐", "语音")) return MusicIcon;
  if (has("文本", "prompt", "提示词")) return FileTextIcon;
  if (has("参数", "菜单", "设置")) return SettingsIcon;
  if (has("shot", "镜头", "生成")) return SparklesIcon;
  return LayoutGridIcon;
}

export function ShowcaseSidebar({ currentStory }: { currentStory?: string | null }) {
  const linkTo = useStoryNavigation();
  const [entries, setEntries] = useState<StoryMetaEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("meta.json")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((json) => {
        if (!cancelled) setEntries(parseStoryMeta(json));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = currentStory ?? storyFromSearch(window.location.search);
  const filter = search.trim().toLowerCase();
  const visibleEntries = useMemo(() => {
    if (!entries) return null;
    if (!filter) return entries;
    return entries.filter(
      (entry) => entry.name.toLowerCase().includes(filter) || entry.id.toLowerCase().includes(filter)
    );
  }, [entries, filter]);

  const tree = useMemo(() => (visibleEntries ? buildStoryTree(visibleEntries) : []), [visibleEntries]);

  const onSearchKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && search.length > 0) {
      event.preventDefault();
      setSearch("");
    }
  }, [search]);

  return (
    <nav className="showcase__sidebar" aria-label="组件导航">
      <div className="showcase__search">
        <SearchIcon className="showcase__search-icon" />
        <input
          ref={searchRef}
          className="showcase__search-input"
          type="search"
          value={search}
          placeholder="搜索 story"
          aria-label="搜索 story"
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        {search ? (
          <Tooltip content="清除搜索">
            <IconButton
              className="showcase__search-clear"
              label="清除搜索"
              size="sm"
              onClick={() => {
                setSearch("");
                searchRef.current?.focus();
              }}
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        ) : null}
      </div>

      {failed ? (
        <p className="showcase__sidebar-state" role="alert">
          无法加载 story 清单（meta.json）。
        </p>
      ) : tree.length === 0 ? (
        <p className="showcase__sidebar-state">{entries === null ? "加载中…" : "没有匹配的 story"}</p>
      ) : (
        <ul className="showcase__tree" role="tree">
          {tree.map((node) => (
            <StoryTreeView
              key={node.id}
              node={node}
              current={current}
              onNavigate={linkTo}
              depth={0}
              forceOpen={filter !== ""}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}

function StoryTreeView({
  node,
  current,
  onNavigate,
  depth,
  forceOpen = false
}: {
  node: StoryTreeNode;
  current: string | null;
  onNavigate: (story: string) => void;
  depth: number;
  /** 搜索过滤时强制展开匹配路径。 */
  forceOpen?: boolean;
}) {
  if (node.storyId !== null) {
    const Icon = leafIcon(node.name);
    const active = node.storyId === current;
    return (
      <li className="showcase__tree-leaf">
        <a
          className="showcase__tree-item"
          data-active={active || undefined}
          aria-current={active ? "page" : undefined}
          href={`?story=${encodeURIComponent(node.storyId)}`}
          title={node.name}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (!active) onNavigate(node.storyId!);
          }}
        >
          <Icon className="showcase__tree-leaf-icon" />
          <span className="showcase__tree-label">{node.name}</span>
        </a>
      </li>
    );
  }

  const opened = forceOpen || Boolean(current && current.startsWith(groupPrefix(node, depth)));
  return (
    <li className="showcase__tree-group">
      <CollapsibleRoot defaultOpen={opened} key={`${node.id}:${opened}`}>
        <CollapsibleTrigger asChild>
          <button type="button" className="showcase__tree-trigger" data-depth={depth}>
            <ChevronRightIcon className="showcase__tree-chevron" />
            <span className="showcase__tree-label">{node.name}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="showcase__tree-children">
          <ul role="group">
            {node.children.map((child) => (
              <StoryTreeView
                key={child.id}
                node={child}
                current={current}
                onNavigate={onNavigate}
                depth={depth + 1}
                forceOpen={forceOpen}
              />
            ))}
          </ul>
        </CollapsibleContent>
      </CollapsibleRoot>
    </li>
  );
}
