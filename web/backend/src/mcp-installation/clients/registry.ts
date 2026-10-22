/** 注册表：新增客户端只在这里追加一条规格。 */
import type { McpInstallClientId } from "@woohaa3/contracts";
import type { McpClientSpec } from "./types.js";
import { codex } from "./codex.js";
import { opencode } from "./opencode.js";
import { claudeCode } from "./claude-code.js";
import { geminiCli } from "./gemini-cli.js";
import { qwenCode } from "./qwen-code.js";
import { amp } from "./amp.js";
import { factoryDroid } from "./factory-droid.js";
import { qoder } from "./qoder.js";
import { codebuddy } from "./codebuddy.js";
import { kimi } from "./kimi.js";
import { deepseekHarness } from "./deepseek-harness.js";
import { cursor } from "./cursor.js";
import { cline } from "./cline.js";
import { windsurf } from "./windsurf.js";
import { copilot } from "./copilot.js";
import { zed } from "./zed.js";
import { continueClient } from "./continue.js";
import { zcode } from "./zcode.js";
import { workbuddy } from "./workbuddy.js";

/** 顺序即页面顺序：cli 组在前、editor 组在后，组内按声明顺序。 */
export const MCP_CLIENT_REGISTRY: readonly McpClientSpec[] = [
  codex,
  opencode,
  claudeCode,
  geminiCli,
  qwenCode,
  amp,
  factoryDroid,
  qoder,
  codebuddy,
  kimi,
  deepseekHarness,
  cursor,
  cline,
  windsurf,
  copilot,
  zed,
  continueClient,
  zcode,
  workbuddy
];

const byId = new Map(MCP_CLIENT_REGISTRY.map(spec => [spec.id, spec]));
export const findClient = (id: string) => byId.get(id as McpInstallClientId);
export const registryIds = () => MCP_CLIENT_REGISTRY.map(spec => spec.id);
