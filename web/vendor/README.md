# vendor

这里的包是**随本产品一起维护/发布的独立库源码**，用工作区包的方式参与构建与测试；不是第三方构建产物。

- [pptask](pptask)：`@sdppp/pptask`，在 Vercel AI SDK 之上扩展"远端任务执行"的 Provider 库。
- [pptask-worker-server](pptask-worker-server)：`@sdppp/pptask-worker-server`，pptask 的 worker/调度宿主。

约定：

1. **不再按目录名豁免门禁**：`vendor/` 下的源码与业务源码同口径参与 500 行规模门禁、开源/闭源边界与类型检查。
   （早先 `vendor` 被当作构建产物跳过，导致 2 万多行维护代码在门禁之外；2026-10 起已移除该豁免。）
2. **应用专属的协议实现不放这里**：本应用某个扩展自己拥有的 Provider 协议应放在该扩展目录内
   （通过 `@sdppp/pptask/providers/shared` 复用通用 toolkit），vendor 只保留库本身的能力与上游协议面。
3. 未使用的上游协议族应删除而不是留着"备用"——它们会持续产生维护与门禁成本（2026-10 已删除
   crun / ppio / novita 三个 legacy 协议族，约 1.1 万行）。
4. **本应用扩展已拥有的协议放回扩展**：`ark` 与 `runninghub` 协议实现已迁回各自的
   provider 扩展（`src/provider/`），vendor 只保留通用库能力、`shared` toolkit 与未绑定的上游协议面。
