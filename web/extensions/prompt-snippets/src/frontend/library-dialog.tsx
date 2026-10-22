/**
 * 片段库 dialog renderer
 * （change: add-prompt-snippet-library，任务 4.2/4.3 / design D9；
 *  change: align-showcase-reference-ux，任务 3.2 补全 library/tags 信息架构）。
 *
 * library/tags 双视图：防抖搜索、固定筛选（全部/内置/无标签）、自定义标签、游标分页、
 * 内置标识、摘要与操作菜单；tags 视图支持创建/重命名/删除与关联数。显式呈现异步状态
 * （loading/empty/error/saving/conflict）。只消费注入的 capability，不直接 fetch。
 *
 * 参考 UX 的信息架构（侧栏导航 + 计数 + 条目更多菜单 + footer 总数/完成/新建）在这里
 * 落地到 Woohaa3 生产组件；showcase 直接组合本组件，不复制 markup。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@woohaa3/frontend/extension-api";
import {
  Button,
  DropdownMenu,
  DropdownMenuItem,
  EllipsisIcon,
  IconButton,
  PlusIcon,
  SegmentedControl,
  Tooltip
} from "@woohaa3/frontend/extension-api";
import type { DialogRendererProps } from "@woohaa3/frontend/extension-api";
import type { SnippetCatalog, CatalogFilter } from "./catalog.js";
import type { PromptSnippet, PromptSnippetTag } from "@woohaa3/contracts";
import type { SnippetTagWithCount } from "@woohaa3/frontend/extension-api";
import { useCatalogState, useTagState } from "./use-catalog.js";

export type LibraryActions = {
  openEditor: (payload: { mode: "create" | "edit"; snippetId?: string; nodeId?: string }) => void;
  requestDelete: (snippet: PromptSnippet) => void;
  requestDeleteTag: (tag: SnippetTagWithCount) => void;
  /** 复制正文；缺省用 `navigator.clipboard`。返回结果用于观察成功/失败。 */
  copyBody?: (snippet: PromptSnippet) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export function createLibraryRenderer(catalog: SnippetCatalog, actions: LibraryActions) {
  return function LibraryRenderer({ instance, requestClose }: DialogRendererProps) {
    const state = useCatalogState(catalog);
    const tagState = useTagState(catalog);
    const [view, setView] = useState<"library" | "tags">("library");
    const [newTagName, setNewTagName] = useState("");
    const [renaming, setRenaming] = useState<{ id: string; revision: number; name: string } | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [openMenu, setOpenMenu] = useState<string | null>(null);

    useEffect(() => {
      void catalog.refresh();
    }, []);

    const activeFilter = state.filter === "all" ? "all" : state.filter === "builtIn" ? "builtIn" : state.filter === "untagged" ? "untagged" : `tag:${state.filter.tagId}`;

    const copySnippet = (snippet: PromptSnippet) => {
      setOpenMenu(null);
      const runner = actions.copyBody ?? defaultCopy;
      void runner(snippet).then((result) => {
        if (result.ok) setCopied(snippet.id);
        else setActionError(result.error);
      });
    };

    return (
      <Dialog.Content
        variant="standard"
        size="lg"
        labelledBy={`${instance.instanceId}-title`}
        instanceId={instance.instanceId}
        onOverlayClick={requestClose}
      >
        <DialogHeader onClose={requestClose}>
          <DialogTitle id={`${instance.instanceId}-title`}>提示词片段</DialogTitle>
        </DialogHeader>
        <DialogBody className="snippet-library">
          <aside className="snippet-library__sidebar">
            <SegmentedControl
              className="snippet-library__views snippet-library__view-switch"
              optionClassName="snippet-library__view-option"
              label="片段视图"
              value={view}
              onValueChange={(next) => setView(next as "library" | "tags")}
              options={[
                { value: "library", label: "片段库" },
                { value: "tags", label: "管理标签" }
              ]}
            />
            <div className="snippet-library__filter-heading" id="snippet-filter-heading">
              筛选
            </div>
            <SegmentedControl
              className="snippet-library__filters"
              optionClassName="snippet-library__filter"
              label="片段筛选"
              value={activeFilter}
              onValueChange={(next) => {
                if (next === "all" || next === "builtIn" || next === "untagged") {
                  catalog.setFilter(next);
                } else if (next.startsWith("tag:")) {
                  catalog.setFilter({ tagId: next.slice("tag:".length) });
                }
                setView("library");
              }}
              options={[
                { value: "all", label: labelWithCount("全部", state.counts.all) },
                { value: "builtIn", label: labelWithCount("内置", state.counts.builtIn) },
                { value: "untagged", label: labelWithCount("无标签", state.counts.untagged) },
                ...tagState.items.map((tag) => ({
                  value: `tag:${tag.id}`,
                  label: labelWithCount(tag.name, tag.snippetCount)
                }))
              ]}
            />
            <div className="snippet-library__filter-heading">
              <span className="snippet-library__filter-heading-text">标签</span>
              <Tooltip content="新建标签">
                <IconButton
                  className="snippet-library__filter-add"
                  label="新建标签"
                  size="sm"
                  onClick={() => {
                    setView("tags");
                    setRenaming(null);
                    setNewTagName("");
                  }}
                >
                  <PlusIcon />
                </IconButton>
              </Tooltip>
            </div>
          </aside>

          <main className="snippet-library__main">
            {actionError ? (
              <p className="dlg__error" role="alert">
                {actionError}
              </p>
            ) : null}
            {view === "library" ? (
              <>
                <input
                  className="snippet-library__search"
                  type="search"
                  value={state.query}
                  placeholder="搜索名称、正文或标签"
                  aria-label="搜索片段"
                  onChange={(event) => catalog.setQuery(event.target.value)}
                />
                <div className="snippet-library__results-meta" data-testid="library-results-meta">
                  <strong>{filterLabel(state.filter, tagState.items)}</strong>
                  <span>{state.total} 个结果</span>
                </div>
                {copied ? (
                  <p className="snippet-library__copy-ok" role="status">
                    已复制正文
                  </p>
                ) : null}
                {state.status === "loading" ? <p role="status">加载中…</p> : null}
                {state.status === "error" ? (
                  <div role="alert">
                    <p>{state.error}</p>
                    <Button size="sm" onClick={() => void catalog.refresh()}>
                      重试
                    </Button>
                  </div>
                ) : null}
                {state.status === "ready" && state.items.length === 0 ? (
                  <p role="status">没有匹配的片段</p>
                ) : null}
                <ul className="snippet-library__list">
                  {state.items.map((snippet) => (
                    <li key={snippet.id} className="snippet-library__item">
                      <div className="snippet-library__meta">
                        <span className="snippet-library__name">{snippet.name}</span>
                        {snippet.builtIn ? <span className="snippet-library__badge">内置</span> : null}
                      </div>
                      <p className="snippet-library__summary">{summarize(snippet.body)}</p>
                      <p className="snippet-library__hint">
                        在提示词输入框键入 <code>#</code> 引用此片段
                      </p>
                      <div className="snippet-library__item-menu">
                        <DropdownMenu
                          label={`${snippet.name} 更多操作`}
                          className="snippet-library__popover"
                          open={openMenu === snippet.id}
                          onOpenChange={(next: boolean) => setOpenMenu(next ? snippet.id : null)}
                          side="bottom"
                          align="end"
                          trigger={
                            <IconButton
                              className="snippet-library__more"
                              label={`${snippet.name} 更多操作`}
                              size="sm"
                              aria-haspopup="menu"
                              aria-expanded={openMenu === snippet.id}
                            >
                              <EllipsisIcon />
                            </IconButton>
                          }
                        >
                          {!snippet.builtIn ? (
                            <DropdownMenuItem
                              onSelect={() => {
                                setOpenMenu(null);
                                actions.openEditor({ mode: "edit", snippetId: snippet.id });
                              }}
                            >
                              编辑
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem onSelect={() => copySnippet(snippet)}>复制正文</DropdownMenuItem>
                          {!snippet.builtIn ? (
                            <DropdownMenuItem
                              className="is-danger"
                              onSelect={() => {
                                setOpenMenu(null);
                                actions.requestDelete(snippet);
                              }}
                            >
                              删除
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenu>
                      </div>
                    </li>
                  ))}
                </ul>
                {state.nextCursor ? (
                  <Button disabled={state.loadingMore} onClick={() => void catalog.loadMore()}>
                    {state.loadingMore ? "加载中…" : "加载更多"}
                  </Button>
                ) : null}
              </>
            ) : (
              <div className="snippet-library__tag-manager">
                <div className="snippet-library__tag-manager-head">
                  <div>
                    <h3>管理标签</h3>
                    <p className="snippet-library__hint">整理片段的分类方式。</p>
                  </div>
                  <div className="snippet-library__tag-create">
                    <input
                      type="text"
                      value={newTagName}
                      placeholder="新标签名称"
                      aria-label="新标签名称"
                      onChange={(event) => setNewTagName(event.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={newTagName.trim() === ""}
                      onClick={() => {
                        void catalog.createTag({ name: newTagName.trim() }).then((result) => {
                          if (result.ok) setNewTagName("");
                          else setActionError(result.error);
                        });
                      }}
                    >
                      创建
                    </Button>
                  </div>
                </div>
                {tagState.status === "error" ? <p role="alert">{tagState.error}</p> : null}
                <ul className="snippet-library__tags">
                  {tagState.items.map((tag) => (
                    <li key={tag.id}>
                      {renaming?.id === tag.id ? (
                        <>
                          <input
                            type="text"
                            value={renaming.name}
                            aria-label="标签名称"
                            onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
                          />
                          <Button
                            size="sm"
                            disabled={renaming.name.trim() === ""}
                            onClick={() => {
                              void catalog
                                .renameTag({ tagId: tag.id, expectedRevision: renaming.revision, name: renaming.name.trim() })
                                .then((result) => {
                                  if (result.ok) setRenaming(null);
                                  else setActionError(result.error);
                                });
                            }}
                          >
                            保存
                          </Button>
                          <Button size="sm" onClick={() => setRenaming(null)}>
                            取消
                          </Button>
                        </>
                      ) : (
                        <>
                          <TagRow tag={tag} />
                          <Button
                            size="sm"
                            disabled={tag.builtIn}
                            title={tag.builtIn ? "内置标签不可重命名" : undefined}
                            onClick={() => setRenaming({ id: tag.id, revision: tag.revision, name: tag.name })}
                          >
                            重命名
                          </Button>
                          <Button
                            size="sm"
                            tone="danger"
                            disabled={tag.builtIn}
                            title={tag.builtIn ? "内置标签不可删除" : undefined}
                            onClick={() => actions.requestDeleteTag(tag)}
                          >
                            删除
                          </Button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </main>
        </DialogBody>
        <DialogFooter className="snippet-library__footer">
          <span className="snippet-library__footer-total">
            {state.counts.all} 个片段 · {tagState.items.length} 个标签
          </span>
          <div className="snippet-library__footer-actions">
            <Button onClick={requestClose}>
              完成
            </Button>
            <Button
              tone="primary"
              onClick={() => actions.openEditor({ mode: "create" })}
            >
              新建片段
            </Button>
          </div>
        </DialogFooter>
      </Dialog.Content>
    );
  };
}

async function defaultCopy(snippet: PromptSnippet): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!navigator.clipboard) return { ok: false, error: "当前环境不支持剪贴板" };
    await navigator.clipboard.writeText(snippet.body);
    return { ok: true };
  } catch (reason) {
    return { ok: false, error: reason instanceof Error ? reason.message : "复制失败" };
  }
}

function filterLabel(filter: CatalogFilter, tags: readonly SnippetTagWithCount[]): string {
  if (filter === "all") return "全部";
  if (filter === "builtIn") return "内置";
  if (filter === "untagged") return "无标签";
  return tags.find((tag) => tag.id === filter.tagId)?.name ?? "标签";
}

function labelWithCount(label: string, count: number): ReactNode {
  return (
    <>
      <span>{label}</span>
      <b>{count}</b>
    </>
  );
}

function TagRow({ tag }: { tag: PromptSnippetTag & { snippetCount: number } }) {
  return (
    <span className="snippet-library__tag-name">
      {tag.name}（{tag.snippetCount}）
      {tag.builtIn ? " · 内置" : ""}
    </span>
  );
}

function summarize(body: string): string {
  const text = body.replace(/\{\{[^}]*\}\}/g, "（素材）").replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
