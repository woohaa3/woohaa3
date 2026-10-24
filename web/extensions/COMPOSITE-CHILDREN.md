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
| `placeCompositeChild` / `planCompositeChildLayout` | 新节点避让布局，支持主体右侧列表或向上展开 |
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
