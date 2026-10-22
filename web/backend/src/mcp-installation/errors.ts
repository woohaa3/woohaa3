/** MCP 安装的领域错误；API 只回传 message，不暴露文件内容。 */
export type InstallationErrorCode = "target-not-found";

export class InstallationError extends Error {
  constructor(message: string, readonly code?: InstallationErrorCode) {
    super(message);
  }
}
