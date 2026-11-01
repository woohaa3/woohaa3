/**
 * MCP Service ⇄ Canvas Service 内部协议公共入口
 * （change: split-model-mcp-into-mcp-service；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R08 —— 拆分为
 *  类型常量、共享 codec 原语与模型/镜头/动画/片场请求族 codec）。
 *
 * MCP 传输与编排位于独立运行单元 `mcp-service`；画布权威仍在 `canvas-service`。两者只经本
 * 协议定义的**版本化、受服务身份认证** JSON 交换。这里只含稳定 DTO、路径常量、错误码与
 * 无副作用 codec；不含 handler、client 或任何服务实现（design D3）。
 *
 * 关键不变式：
 * - `actorId` 由 Canvas 侧按服务身份派生，**不**从请求体读取；请求 DTO 刻意不携带 actor。
 * - 画布写入复用现有 `CanvasCommand` 命令集，不新增第二套命令类型（design D2）。
 * - 预览 PNG 是可丢弃派生结果，只在响应中返回，不进入任何持久状态。
 *
 * 本文件为稳定 barrel：各请求族 codec 直接依赖 `common-codec` 叶子，不反向 import 本文件。
 */
export * from "./mcp-internal/types.js";
export * from "./mcp-internal/common-codec.js";
export * from "./mcp-internal/model-codec.js";
export * from "./mcp-internal/camera-codec.js";
