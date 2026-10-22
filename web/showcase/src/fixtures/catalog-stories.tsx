/**
 * 目录状态 story 的渲染外壳（任务 3.2）。
 *
 * `FixtureCatalogPanel` 用指定的 catalog fixture id 安装生产组合；它不做特殊渲染，
 * 与其它 story 走同一条生产组件路径，只是目录状态不同。
 */
import { useState } from "react";
import { ShowcasePanelHost } from "./panel-fixture.js";
import { baseCanvas } from "./canvas.js";
import type { CatalogFixtureId } from "./catalog.js";

export function CatalogFixturePanel({
  catalogId,
  kind = "image"
}: {
  catalogId: CatalogFixtureId;
  kind?: "image" | "video" | "audio";
}) {
  // key 让切换 fixture 时整块重挂载（fixture 在挂载时安装）。
  const [nonce] = useState(() => Math.random());
  return (
    <ShowcasePanelHost
      key={`${catalogId}-${nonce}`}
      catalogId={catalogId}
      canvas={baseCanvas(kind)}
    />
  );
}
