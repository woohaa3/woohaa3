/**
 * `@woohaa3/photocraft-project-verifier` 公共入口
 * （change: 2026-10-21-extract-photocraft-subproject，design D5）。
 *
 * Node-only：有界 ZIP/manifest/资源核验 + 原生核验子进程适配。**不提供浏览器导出**：
 * 依赖 `node:zlib` 与 `node:child_process`，浏览器包里出现它会直接构建失败，这正是不让
 * 核验逻辑误入前端产物的边界。
 *
 * Media 只经这里使用核验能力：
 * - `createNativeProjectVerifier(options)`：持有原生工具配置的可释放实例；
 * - `createProcessOnlyVerifier()`：未配置原生工具的默认形态；
 * - `verifyPhotocraftProject` / `inspectEmbeddedPhotocraftProject`：纯进程内有界核验；
 * - `ProjectVerificationError` / `NativeVerifierError`：稳定错误码，Media 据此映射 ingest 拒绝。
 */
export {
  ProjectVerificationError,
  inspectEmbeddedPhotocraftProject,
  isPhotocraftProjectContentType,
  verifyPhotocraftProject,
  verifyPhotocraftProjectForIngest
} from "./project-verification.js";

export type {
  ProjectVerificationErrorCode,
  ProjectVerificationSummary
} from "./project-verification.js";

export {
  NativeVerifierError,
  createNativeProjectVerifier,
  createProcessOnlyVerifier
} from "./native-project-verifier.js";

export type {
  NativeProjectVerifier,
  NativeProjectVerifierOptions,
  NativeVerifierErrorCode
} from "./native-project-verifier.js";
