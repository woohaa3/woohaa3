/**
 * 生图对话框里的「提示词」面板（参考 PS 插件的提示词工具）。
 *
 * 形态：搜索 + 分类筛选 + 卡片网格，点「使用」把**整段正文**交给调用方写进草稿。
 * 与 PS 插件的差别只有一处：那边点「复制」进剪贴板，这里直接写进当前对话框 ——
 * 用户要的是「用这段提示词生成」，多一步粘贴没有意义。
 *
 * 面板本身**不持有草稿**：`onUse(text)` 由宿主决定怎么合并（见 `mergePromptText`）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon, StarIcon } from "@woohaa3/ui";
import { getAppPublicFetch } from "../../../services/app-base-path.js";
import {
  fetchPromptLibrary,
  filterPrompts,
  readFavorites,
  writeFavorites,
  type PromptEntry,
  type PromptLibrarySnapshot
} from "./prompt-library.js";
import "./prompt-library-panel.css";

type Tab = "presets" | "favorites";

export type PromptLibraryPanelProps = {
  /** 选中一条提示词。`text` 是完整正文。 */
  onUse: (text: string) => void;
  /** 覆盖取数实现（测试注入，不联网）。 */
  fetchImpl?: typeof globalThis.fetch;
  /** 覆盖初次加载的时序（测试用）。 */
  loadOnMount?: boolean;
};

export function PromptLibraryPanel({ onUse, fetchImpl, loadOnMount = true }: PromptLibraryPanelProps) {
  const [tab, setTab] = useState<Tab>("presets");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [snapshot, setSnapshot] = useState<PromptLibrarySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => readFavorites());
  const [usedId, setUsedId] = useState<string | null>(null);
  // StrictMode 下 effect 会跑两遍；用 ref 挡住第二次请求（面板是一次性的，不需要取消语义）。
  const requested = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await fetchPromptLibrary(fetchImpl ?? getAppPublicFetch());
    setLoading(false);
    if (result.ok) setSnapshot(result.snapshot);
    else setError(result.error);
  }, [fetchImpl]);

  useEffect(() => {
    if (!loadOnMount || requested.current) return;
    requested.current = true;
    void load();
  }, [load, loadOnMount]);

  const all = snapshot?.prompts ?? [];
  const source = tab === "favorites" ? all.filter((p) => favorites.has(p.id)) : all;
  const visible = useMemo(
    () => filterPrompts(source, { keyword, ...(category !== "" ? { category } : {}) }),
    [source, keyword, category]
  );

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeFavorites(next);
      return next;
    });
  }, []);

  const use = useCallback(
    (entry: PromptEntry) => {
      onUse(entry.text);
      // 用过的卡片给一次短暂反馈：面板不关，用户可以接着试下一条。
      setUsedId(entry.id);
      window.setTimeout(() => setUsedId((current) => (current === entry.id ? null : current)), 900);
    },
    [onUse]
  );

  return (
    <div className="prompt-library" role="dialog" aria-label="提示词库">
      <div className="prompt-library__tabs" role="tablist" aria-label="提示词来源">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "presets"}
          className="prompt-library__tab"
          data-active={tab === "presets" ? "true" : undefined}
          onClick={() => setTab("presets")}
        >
          插件预设
          <span className="prompt-library__count">{all.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "favorites"}
          className="prompt-library__tab"
          data-active={tab === "favorites" ? "true" : undefined}
          onClick={() => setTab("favorites")}
        >
          我的收藏
          <span className="prompt-library__count">{favorites.size}</span>
        </button>
      </div>

      <label className="prompt-library__search">
        <SearchIcon className="prompt-library__search-icon" />
        <input
          type="search"
          value={keyword}
          placeholder="搜索标题、内容、标签…"
          aria-label="搜索提示词"
          onChange={(event) => setKeyword(event.target.value)}
        />
      </label>

      {snapshot ? (
        <div className="prompt-library__categories" role="group" aria-label="分类筛选">
          <button
            type="button"
            className="prompt-library__category"
            data-active={category === "" ? "true" : undefined}
            aria-pressed={category === ""}
            onClick={() => setCategory("")}
          >
            全部
          </button>
          {snapshot.categories.map((item) => (
            <button
              key={item}
              type="button"
              className="prompt-library__category"
              data-active={category === item ? "true" : undefined}
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
      ) : null}

      <div className="prompt-library__body">
        {loading && all.length === 0 ? <p className="prompt-library__hint" role="status">正在加载提示词…</p> : null}
        {error !== null ? (
          <div className="prompt-library__hint" role="alert">
            <span>{error}</span>
            <button type="button" className="prompt-library__retry" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : null}
        {!loading && error === null && visible.length === 0 ? (
          <p className="prompt-library__hint">
            {tab === "favorites"
              ? "还没有收藏。在「插件预设」里点心形收藏，之后会出现在这里。"
              : keyword.trim() !== ""
                ? "没有匹配的提示词，换个关键词试试。"
                : "这里还没有提示词。"}
          </p>
        ) : null}
        <div className="prompt-library__grid">
          {visible.map((entry) => (
            <PromptCard
              key={entry.id}
              entry={entry}
              favorited={favorites.has(entry.id)}
              used={usedId === entry.id}
              onToggleFavorite={() => toggleFavorite(entry.id)}
              onUse={() => use(entry)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PromptCard({
  entry,
  favorited,
  used,
  onToggleFavorite,
  onUse
}: {
  entry: PromptEntry;
  favorited: boolean;
  used: boolean;
  onToggleFavorite: () => void;
  onUse: () => void;
}) {
  // 缩略图加载失败就整块去掉：上游的 data URI 偶尔会缺，破图标比空白更难看。
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = entry.imageUrl !== undefined && !imageFailed;
  return (
    <article className="prompt-library__card" data-used={used ? "true" : undefined}>
      <header className="prompt-library__card-head">
        <span className="prompt-library__badge">{entry.category}</span>
        <button
          type="button"
          className="prompt-library__favorite"
          data-active={favorited ? "true" : undefined}
          aria-pressed={favorited}
          aria-label={favorited ? `取消收藏 ${entry.title}` : `收藏 ${entry.title}`}
          title={favorited ? "取消收藏" : "收藏"}
          onClick={onToggleFavorite}
        >
          {/* 收藏用星形（与图片库的收藏同一个图形）；填充交给 CSS 的 currentColor */}
          <StarIcon className="prompt-library__heart" fill="currentColor" />
        </button>
      </header>
      <h4 className="prompt-library__title">{entry.title}</h4>
      <p className="prompt-library__text">{entry.text}</p>
      {showImage ? (
        <img
          className="prompt-library__thumb"
          src={entry.imageUrl}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : null}
      {entry.tags.length > 0 ? (
        <p className="prompt-library__tags">
          {entry.tags.slice(0, 4).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </p>
      ) : null}
      <footer className="prompt-library__card-foot">
        <button type="button" className="prompt-library__use" onClick={onUse}>
          {used ? "已写入" : "使用"}
        </button>
      </footer>
    </article>
  );
}

