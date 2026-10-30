/**
 * 开发期报错助手浮标与面板（change: 2026-10-30-add-dev-error-assistant）。
 *
 * 左下角一颗圆钮：没出错时只有图标，出错后带红色计数；点开是一列记录。
 *
 * 位置与「任务活动」浮层错开：那个占 `left/bottom: 16~18px`，这里抬到它上方，
 * 两者同时出现时不叠在一起。做法是**读取同一组设计常量**而不是各自写死数值 —— 见 CSS。
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import type { CapturedError, DevErrorLog } from "./store.js";

/**
 * 样式**只能**在开发构建里加载。
 *
 * 静态 `import "./dev-error-assistant.css"` 是副作用导入，Rollup 不会因为 JS 被摇掉而
 * 丢掉它 —— 实测生产产物里仍留着整套 `.dev-error-assistant*` 规则（约 5 KB）。
 * 包在 `import.meta.env.DEV` 里之后，生产构建时整条语句变成 `if (false)`，
 * 动态 import 与它指向的 CSS 一起消失。与 `main.tsx` 加载开发助手的写法一致。
 */
if (import.meta.env.DEV) {
  void import("./dev-error-assistant.css");
}

const EMPTY: readonly CapturedError[] = [];

type SourceFilter = "all" | "page" | "renderer";

export function DevErrorAssistant({ log }: { log: DevErrorLog }) {
  const entries = useSyncExternalStore(log.subscribe, log.getSnapshot, () => EMPTY);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<SourceFilter>("all");

  const visible = useMemo(
    () => (filter === "all" ? entries : entries.filter(entry => entry.origin === filter)),
    [entries, filter]
  );
  // 计数按**条目数**而不是出现次数：用户关心「有几种问题」，
  // 同一条错误重复一千次仍然只算一个问题。
  const count = entries.length;
  const rendererCount = entries.filter(entry => entry.origin === "renderer").length;

  return (
    <div className="dev-error-assistant" data-open={open ? "true" : undefined}>
      {open ? (
        <section className="dev-error-assistant__panel" aria-label="开发期报错">
          <header className="dev-error-assistant__header">
            <span className="dev-error-assistant__title">报错 {count > 0 ? `(${count})` : ""}</span>
            <div className="dev-error-assistant__actions">
              <button
                type="button"
                className="dev-error-assistant__text-button"
                onClick={() => log.clear()}
                disabled={count === 0}
              >
                清空
              </button>
              <button
                type="button"
                className="dev-error-assistant__text-button"
                onClick={() => setOpen(false)}
                aria-label="收起报错面板"
              >
                收起
              </button>
            </div>
          </header>

          {count > 0 ? (
            <div className="dev-error-assistant__filters" role="group" aria-label="按来源筛选">
              {(
                [
                  ["all", "全部"],
                  ["page", "页面"],
                  ["renderer", "渲染器"]
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  className="dev-error-assistant__filter"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {text}
                </button>
              ))}
            </div>
          ) : null}

          {count === 0 ? (
            <p className="dev-error-assistant__empty">还没有捕获到报错。</p>
          ) : visible.length === 0 ? (
            <p className="dev-error-assistant__empty">这个来源下没有记录。</p>
          ) : (
            <ol className="dev-error-assistant__list">
              {/* 最新的在最上面：排障时最想先看刚发生的那条。 */}
              {[...visible].reverse().map(entry => (
                <ErrorRow key={entry.id} entry={entry} />
              ))}
            </ol>
          )}

          <p className="dev-error-assistant__hint">
            开发环境专用，不进打包产物。渲染器错误 {rendererCount} 条。
          </p>
        </section>
      ) : null}

      <button
        type="button"
        className="dev-error-assistant__trigger"
        aria-expanded={open}
        aria-label={count > 0 ? `开发期报错：${count} 条，点开查看` : "开发期报错：暂无，点开查看"}
        data-tone={count > 0 ? "danger" : "idle"}
        onClick={() => setOpen(value => !value)}
      >
        <span className="dev-error-assistant__icon" aria-hidden="true">
          {/* 警告三角：与状态点同样的 16px 栅格，不引图标库 —— 这是开发工具，不该为它加依赖。 */}
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 2.2 14.2 13H1.8L8 2.2Z" strokeLinejoin="round" />
            <path d="M8 6.2v3.1" strokeLinecap="round" />
            <circle cx="8" cy="11.3" r="0.75" fill="currentColor" stroke="none" />
          </svg>
        </span>
        {count > 0 ? <span className="dev-error-assistant__badge">{count > 99 ? "99+" : count}</span> : null}
      </button>
    </div>
  );
}

function ErrorRow({ entry }: { entry: CapturedError }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(entry.stack) || Boolean(entry.source);
  return (
    <li className="dev-error-assistant__row" data-kind={entry.kind} data-origin={entry.origin}>
      <button
        type="button"
        className="dev-error-assistant__row-head"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={hasDetail ? expanded : undefined}
        disabled={!hasDetail}
      >
        <span className="dev-error-assistant__meta">
          <span className="dev-error-assistant__time">{formatTime(entry.at)}</span>
          <span className="dev-error-assistant__tag" data-origin={entry.origin}>
            {entry.origin === "renderer" ? "渲染器" : "页面"}
          </span>
          <span className="dev-error-assistant__tag" data-kind={entry.kind}>
            {entry.kind === "rejection" ? "Promise" : entry.kind === "console" ? "console" : "异常"}
          </span>
          {entry.count > 1 ? <span className="dev-error-assistant__count">×{entry.count}</span> : null}
        </span>
        <span className="dev-error-assistant__message">{entry.message}</span>
      </button>
      {expanded ? (
        <div className="dev-error-assistant__detail">
          {entry.source ? <p className="dev-error-assistant__source">{entry.source}</p> : null}
          {entry.stack ? <pre className="dev-error-assistant__stack">{entry.stack}</pre> : null}
        </div>
      ) : null}
    </li>
  );
}

/** `14:03:21` —— 排障关心的是先后顺序与相隔多久，不需要日期。 */
function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
