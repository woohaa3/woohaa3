/**
 * film-set 稳定 identity 叶子常量
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.2 / design D3/D4）。
 *
 * 独立于 `shared.ts` 业务 barrel：纯 metadata 与 browser builder 的薄入口只允许可达本叶子的
 * identity，不把 playback/object-session/composition 等业务运行时带进 activation 入口。
 */

export const FILM_SET_EXTENSION_ID = "film-set";
export const FILM_SET_LABEL = "片场";
