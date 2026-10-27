/**
 * 助手契约：一次回合从连接到执行、再到画布落盘。
 *
 * 会话和回合在 `conversation`，请求解码在 `conversation-codec`。
 * 连接身份在 `agent-connection`。执行引用、文本生成、画布创建和受控改稿分别是后面几个模块。
 */
export * from "./conversation.js";
export * from "./conversation-codec.js";
export * from "./conversation-mcp.js";
export * from "./agent-connection.js";
export * from "./agent-connection-codec.js";
export * from "./assistant-execution.js";
export * from "./assistant-text.js";
export * from "./canvas-creation.js";
export * from "./authoring.js";
