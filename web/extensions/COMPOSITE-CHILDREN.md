# Composite 的画布子节点

3D composite 的子节点分为 `container`（素材入口）和 `entity`（独立输出作品）。在公开的
`CompositeAssetAdapter.children(canvas, ownerNodeId)` 中声明关系；扩展负责验证自己的身份和实例，
宿主不读取业务私有归属字段。子节点仍是普通持久画布节点，声明不会自动创建节点。

```ts
children(canvas, ownerNodeId) {
  if (!isMyMainNode(canvas, ownerNodeId)) return [];
  return [
    {
      nodeId: referenceContainerId(ownerNodeId), ownerNodeId, kind: "container",
      panel: { title: "参考素材", message: "拖入素材", hint: "放开后添加" }
    },
    { nodeId: outputNodeId(ownerNodeId), ownerNodeId, kind: "entity" }
  ];
}
```

容器使用 `composite-asset` 类型。公共 registry 派生矩形 scope、管理虚线、随主体拖动与取消恢复；
`followOwner: false` 可关闭单个子节点的随动。`childLinkAnchor` 可指定主体模型局部坐标的关联线起点。
`sourceItemId` 可把聚焦连线绑定到主体内的具体对象（与 `itemRoots`／媒体 `itemId` 同身份），而不是共用主体锚点；不写入规范节点数据。
`focusOwner: true` 让容器双击进入主体工作区。实体保留普通图片、视频、文本或模型的渲染与连线行为，
不会套上容器外框。管理虚线独立于生成依赖的 `document.edges`。

`panel` 由 Bevy 绘制，无 HTML 外框。标题、空态 `message`、底部 `hint` 与至多八个 `imageIds`
共用公共布局；缩略图按原始比例缩放。每个纹理 ID 必须包含容器身份，并在 adapter 的 `mediaSources`
中声明对应源；宿主复用 composite 媒体上传通道，删除后回收 Sprite/Image。容器也可通过 `prepare`
提供 3D 模型，公共面板保留透明中心。拖入允许的节点类型、引用还是复制快照，由扩展的
`canvas.node-drop` 贡献决定。

公共纯函数从 `@woohaa3/contracts` 导入：

| API | 用途 |
| --- | --- |
| `placeCompositeChild` / `planCompositeChildLayout` | 新节点避让布局，支持主体右侧列表、向上展开和上方横排（`layout: "row"`，从左向右避让） |
| `createCompositeChildNode` | 绝对坐标落位，转换为主体所在分组的相对坐标 |
| `planCompositeChildNode` | 扩展投影创建或更新节点数据，保留已有位置和尺寸 |
| `compositeChildMovementContext` | 一批随动共享节点索引，避免每个子节点重复扫描整张画布 |
| `followCompositeChildOwner` | reducer 内的移动／重父化规则，显式子节点落点优先 |
| `removeCompositeChildNodes` | 同时移除子节点、关联边及节点数据 |

业务 reducer 或投影负责枚举应存在的子节点，调用这些函数维护源增删与子节点生命周期。
不要把 UI 手势随动当作权威事务规则；片场在共享 reducer 中使用同一坐标函数，保证命令、撤销及
远端更新一致。八方向工作流使用公共投影构造与容器声明；生成任务和产物依赖仍由扩展维护。

实现入口：`contracts/src/canvas/composite-children.ts`、
`frontend/src/extension-api/composite-assets.ts`、`bevy/src/canvas_query/composite_panel.rs` 与
`bevy/src/canvas2d/scope_panel.rs`。Render Scene v25 与 WASM 必须配套构建。

主体聚焦时，宿主从可信 children 派生顶部轻量标签：36px 高、168–184px 宽，按对象后镜头顺序排列，遵守 contentRect 并换行；不加入真实内嵌后代或缩略图。标签只保留类型图标、13px 单行名称与可用的关闭入口。Render Scene v30 的 `modelFocusContext` 只传 CSS 显示矩形；内部绘制节点不改变规范卡片、模型 bounds 或取景构图。对象连线从当前对象包围盒顶部中心引出，镜头从各自场景相机的世界位置引出，均以 0.2 opacity 经观察相机连接标签底部。隐藏／缺失参考不留连线。参考不接受选择、拖动、双击、菜单或滚轮；唯一例外是 Rust 命中的关闭控件，以既有 NodeAction 返回 `composite.close-reference`，经当前归属、写权限与非历史检查后调用 adapter 的可选 `closeChild(canvas, childNodeId)`。关闭能力须由每个 child 显式声明 `closable: true`，缺省不可关闭；注册表在执行时再次校验。关闭语义由扩展实现，并提供重开入口及撤销。片场只有对象容器声明可关闭；静态／动态镜头始终外显，不提供关闭或显示开关，旧镜头隐藏设置不再生效。片场对象清理派生容器；镜头仅以 `shotPreview.hidden` 隐藏呈现，规范预览和原布局保留供离屏捕捉生成图片／视频。聚焦标签不分配缩略图预览。退出聚焦恢复总览卡片。

片场每次最多外显 6 个对象。缺省按源对象顺序显示前 6 个，超额项写入原有隐藏列表；已有场景升级时收敛超额容器及子卡片，保留全部源对象。满额需先关闭一个容器再显示另一个；UI 与权威 reducer 共用上限。镜头实体不占对象名额。
