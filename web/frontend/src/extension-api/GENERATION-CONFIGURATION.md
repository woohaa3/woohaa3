# 生成配置公开接缝

extension-api 导出 `GenerationModelDirectory`、`GenerationParameters`、`ReasoningParameters` 及其公开 props/字段类型。扩展通过 `ModelPanelProps.renderers.modelSelector()` 使用宿主已适配的来源模型目录；不得读取 Host 草稿 store、Provider 路由或私有服务。RunningHub 与 Seedance 专用面板保留各自结构化参数和原提交 facade。

公共助手消费者使用 `AssistantConnectionPicker`；节点创作 / 检查器使用宿主注入的 authoring composer。连接模型原子选择保留 connectionId/adapterId/configRevision/credentialEpoch；默认模型仅在公开连接规则允许时出现。思考强度在独立参数区，空值继续省略。目录读取、浏览、刷新和选择均不推理；显式提交仍由公共输入控制器冻结目标、角色、范围与请求身份。旧 Variant 数据字段继续可读，旧模型菜单的 variant 展示已停用。

复用已挂载的 `AssistantConnectionPicker` 时传入目标的 `draftIdentity`，用于释放浮层并隔离临时思考强度；受控 `value` 与持久草稿仍由调用方按目标保存。组件按连接 / 模型恢复本次挂载内的合法参数，不让目录 revision 清除调用方草稿。

展示组件和样式来自 `@woohaa3/ui/assistant` 与公共 styles.css。UI 包 README 包含受控组件用法；扩展运行时 SDK 注册相同组件实例，无需引入前端内部实现或自建目录缓存。
