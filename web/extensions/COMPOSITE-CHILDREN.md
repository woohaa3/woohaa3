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
不要把 UI 手势随动当作权威事务规则；片场的 shared 生命周期规划器使用同一坐标函数，保证命令、撤销及
远端更新一致。八方向工作流使用公共投影构造与容器声明；生成任务和产物依赖仍由扩展维护。

持久化的 `nodeData.managedBy` 使用 `{ schemaVersion: 1, extensionId, ownerNodeId,
entityId, lifecycle: "owner-managed" }` 表示托管实体。它独立于分组 `parentId` 和呈现
`closable`；`nodePolicy` 与 `partitionManagedNodeDeletion` 依据关系限制独立删除，包含整个
owner 或其分组的删除仍可级联。扩展未注册时持久保护继续有效。普通媒体不写该关系，只有
`mediaContent` 来源的节点也不会自动成为托管节点。

媒体 provider 的 `snapshot` 用于单独复制：完成后剪贴载荷携带不可变资产、脱离内容来源与
归属，生成来源的资产同样必须保留。复制 owner 的闭包保留归属与内容引用供身份重映射，
不先物化每个媒体。原生同步 copy 事件无法等待快照时，只发布完成后的异步剪贴板／页内
载荷；失败不能先留下仍指向源实体的替代载荷。

片场媒体的 canonical 类型是 image/video。片场 adapter 只在派生画布上补充镜头渲染描述，
供现有预览与捕获内核使用；此描述不回写 nodeData。provider 可通过可选 `subscribe` 通知
生产器状态变化，使启动期间失败的物化在渲染器就绪后重试。

实现入口：`contracts/src/canvas/composite-children.ts`、
`frontend/src/extension-api/composite-assets.ts`、`bevy/src/canvas_query/composite_panel.rs` 与
`bevy/src/canvas2d/scope_panel.rs`。Render Scene v29 与 WASM 必须配套构建。

主体聚焦时，宿主从可信 children 派生顶部轻量标签：36px 高、168–184px 宽，按对象后镜头顺序排列，遵守 contentRect 并换行；不加入真实内嵌后代或缩略图。标签只保留类型图标、13px 单行名称与可用的关闭入口。Render Scene v29 的 `modelFocusContext` 只传 CSS 显示矩形；内部绘制节点不改变规范卡片、模型 bounds 或取景构图。对象连线从当前对象包围盒顶部中心引出，镜头从各自场景相机的世界位置引出，均以 0.2 opacity 经观察相机连接标签底部。隐藏／缺失参考不留连线。参考不接受选择、拖动、双击、菜单或滚轮；唯一例外是 Rust 命中的关闭控件，以既有 NodeAction 返回 `composite.close-reference`，经当前归属、写权限与非历史检查后调用 adapter 的可选 `closeChild(canvas, childNodeId)`。关闭能力须由每个 child 显式声明 `closable: true`，缺省不可关闭；注册表在执行时再次校验。关闭语义由扩展实现，并提供重开入口及撤销。片场只有对象容器声明可关闭；静态／动态镜头始终外显，不提供关闭或显示开关，旧镜头隐藏设置不再生效。片场对象隐藏时清理派生容器；镜头媒体保留原规范身份和布局，供实时预览与离屏捕捉使用。聚焦标签不分配缩略图预览。退出聚焦恢复总览卡片。

片场每次最多外显 6 个对象。缺省按源对象顺序显示前 6 个，超额项写入原有隐藏列表；已有场景升级时收敛超额容器及子卡片，保留全部源对象。满额需先关闭一个容器再显示另一个；UI 与权威 reducer 共用上限。镜头实体不占对象名额。

## 可信生命周期、复制与离线迁移

`ManagedNodeLifecycleRegistry.register({ extensionId, schemaVersion: 1, plan, remapCopy? })` 只由可信装配调用；普通命令中的相同字段不是授权。`plan` 接收只读 before/canvas 快照和显式定位节点 ID，返回该扩展**全部**期望托管实体。规划器纯且确定，不访问网络、GPU、时间或媒体生产；宿主校验归属、重复实体、节点形状、活动任务和碰撞，再与源编辑同批发布。业务源非法时应抛错，不能把冲突解释为删除重建。

浏览器 `CompositeAssetAdapter.managedLifecycle` 注册同一实现，宿主 `CanvasContentRuntime.managedLifecycles` 注入权威事务。释放注册表不会移除持久 managedBy；独立删除继续拒绝，需要业务实现的源编辑报告 lifecycle-unavailable，普通节点与 owner 删除仍可用。缓存更新可保留关系写入，不能降级类型或清除关系。

`remapCopy` 是现有 clipboard planner 的可选扩展步骤：接收待复制节点、配置、预分配节点 ID 和 ID 工厂，返回业务重映射后的 sourceNodeId/nodeId/data。片场实现重映射 owner/clip/item、派生卡片和 mediaContent，宿主只排序依赖并重映射通用父级/边。缺失实现时拒绝托管闭包，不能静默丢弃子实体。单独 live 媒体使用既有 provider.snapshot，成功后移除媒体来源和归属；ready generated 资产在已确认快照载荷中保留。

`CanvasContentRuntime.managedMigrations` 的 codec 仅在仓储/room 开放前运行，复用离线备份与事务设施；普通 normalize/read 路径不调用旧格式转换。缺 codec 或归属冲突保留原件并阻止升级。命令能力 v7 与缓存 capability 门禁防止旧客户端规范化掉托管字段。
