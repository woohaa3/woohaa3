# 画布 ECS 投影层

`canvas_ecs` 是 2D 卡片、group、片场（composite-asset）以及 3D owner 共用的实体语义层
（change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs）。它只拥有三件事：

1. **公共组件**（[components.rs](components.rs)）：节点身份、布局、深度、选中/悬停/可见性、
   展示类型，以及标签、纹理 Sprite、group surface、面板缩略图、focus 细节、镜头预览和模型
   owner/part/batch 等归属组件。
2. **投影**（[projection.rs](projection.rs)）：`CurrentScene` 是唯一 accepted 快照，
   `ProjectCanvasNodes` 是**唯一**遍历快照的地方；其他 system 只 Query 公共组件，或按 id 走
   `NodeIndex` 读完整绘制 DTO（`node_for_draw`）。
3. **共享批处理**（[batch.rs](batch.rs)）：`CanvasBatchWriter` 接口与 `SelectionOutlineBatch` /
   `SelectionOutlineLayer`，所有展示类型的选中描边写入同一批次，由唯一 flush 提交。

`components.rs` 始终编译（3D 与预览模块复用 owner/part marker）；投影与批处理只在
`canvas-core` feature 下编译。

## 最小公共组件

节点实体由投影创建，至少携带：

| 组件 | 用途 |
| --- | --- |
| `CanvasNodeId(String)` | 稳定身份；跨 accepted 快照按同一 `nodeId` 复用实体 |
| `CanvasLayout { x, y, width, height }` | 协议坐标布局，提供 `center()` / `port()` |
| `CanvasDepth { index, render, z }` | 文档发射序号与派生世界 z，producer 按它排序 |
| `CanvasSelection { selected, running, drop_target }` | 选中、运行、放置目标语义 |
| `CanvasHover { hovered, port }` | 指针悬停瞬时状态 |
| `CanvasVisibility { hidden }` | 聚焦/隐藏投影；隐藏时仍保留实体身份 |

内置展示类型用空标记区分几何 producer：`CardPresentation`、`GroupPresentation`、
`FilmSetPresentation`；未知类型保留为 `CustomPresentation { kind }`，节点仍被投影，只是没有
内置 producer。派生实体（标签、纹理 Sprite、group 面板、缩略图、focus 细节）通过
`ChildOf(owner)` 挂在节点实体下，节点删除即递归回收。

## 新增第三方展示类型

不需要修改中心 enum、trait 或 `CanvasOverlayCache`。在自己的模块/插件里：

1. 定义只携带绘制参数的 presentation component，例如
   `#[derive(Component)] struct MyPresentation { inset: f32 }`；
2. 写一个 producer system，Query 公共组件并写入共享批次：

   ```rust
   fn produce_my_outline(
       mut batch: ResMut<SelectionOutlineBatch>,
       nodes: Query<(&CanvasLayout, &CanvasDepth, &CanvasSelection, &MyPresentation)>,
   ) {
       let writer = batch.writer();
       for (layout, depth, selection, presentation) in &nodes {
           if !selection.selected {
               continue;
           }
           // 用 layout / depth.z / presentation 生成自己的几何。
           writer.polygon(&points, depth.z + 0.01, 0xffff_ffff);
       }
   }
   ```

3. 把 component 插到节点实体上（投影创建的实体或自己的展示子实体），并把 producer 排进
   `CanvasRenderSet::Selection`，位于 `begin_selection_outlines` 之后。公共
   `flush_selection_outlines` 负责替换 mesh、清空无贡献帧；第三方不需要保存批次实体或自己
   回收几何。

完整可运行 fixture 见
[card_cache/tests/third_party.rs](../canvas2d/card_cache/tests/third_party.rs)：它只定义测试内的
component + system，验证选中时产生几何、取消选中后同一批次清空。

## 边界

- 资产、纹理内容共享、16 节点几何块、mesh/material handle、LRU/预算、异步 preparation 与
  layer pool 仍是 Resource，不搬进组件。
- 共享材质与字体句柄由 `CanvasMaterials` 持有；逐帧覆盖层通过 marker + Query 生命周期管理，
  不把不同展示类型的实体句柄混在同一缓存 Resource 中。
- `ModelVisuals.part_entities` / `part_batches` 只是 O(1) 热路径索引，实体身份由
  `ModelOwner` / `ModelPart` / `ModelBatch` 组件表达；透明度实例的实体局部状态在
  `OpacityMaterialInstance`，Resource 只保留实例回收策略。
- 2D 批处理按职责拆分为 `CardBlockCache`、`CardDecorationCache`、
  `ContainerBlockCache`、`EdgeBlockCache` 与 `TextureStore`；`CanvasMaterials` 只保留
  可跨实体共享的材质和字体句柄，缓存不再把不同展示类型的块混在同一个 Resource 中。
- 组件不复制完整协议 DTO；需要完整绘制输入的 system 从 `CurrentScene` 经 `NodeIndex` 取。
- 非法布局、重复/空 id 或倒退的 revision 不提交本次投影，保留上一份合法实体集合。
## Render invalidation inputs

Projection updates existing layout, presentation and overview-owner components with value comparisons.
Only component additions/removals use deferred structural commands; identical full snapshots preserve
change ticks, and a position edit changes only the affected layout/visual inputs. Resource-only rows
continue to use the node entity index without a full projection.

Cards and containers carry `CardVisual` / `ContainerVisual` components. Each component keeps a
`geometry` input separate from a `labels` input, so producers can invalidate mesh blocks only for
size, texture, history, or run-state changes while title and type-label edits refresh text alone.
`NodeActionBar` is the accepted toolbar input. Projection already owns node membership and uses
`canvas_query::action_bar_enabled` for focus, actions and group opt-in; interaction applies the
same policy to its accepted node set without scanning the scene once per node.

## 总览缓存 owner 生命周期

带 `group.overviewCache = "transparent-world-v1"` 的片场组实体额外携带
`OverviewCacheOwner`。它保存启用位、输入 fingerprint、物理 tier 与回退原因；颜色图、
深度/MSAA resolve 附件、离屏相机和层租约由 renderer Resource 管理。状态账本提供
`Direct → Queued → Rendering → Cached` 和 `Suspended`，并以
`epoch/owner/generation/slot_generation` token 隔离迟到反馈。`subject` 只从 accepted
场景读取徽标布局与 prepared model bounds（不含绝对位置），`dispatch` 在帧链中推进作业并
发布颜色图；发布后实时源层降为采样/镜头可见层，主体不再由主相机逐帧重绘。
