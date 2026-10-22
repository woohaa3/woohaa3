/**
 * 部署配置读取：扩展目录里的 `config.local.json` + 环境变量覆盖。
 *
 * 为什么不走设置面的 `secret` 字段：站点扩展拿到的 `host.config.values()` **不含密钥值**
 * （只有 `secretRefs()` 里的引用），因此部署凭证只能由扩展自己读自己目录里的文件——
 * 敏感值只由部署侧读取，不进入公开配置。
 *
 * 秘密只在本闭包内存在：不写日志、不进任何响应体、不进浏览器产物。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  REMOTE_SERVER_DEVICE_TOKEN_ENV,
  REMOTE_SERVER_LOCAL_CONFIG,
  REMOTE_SERVER_URL_ENV,
  parseServerUrl
} from "./shared.js";

export type RemoteServerDeployment = {
  /** 已规范化（去掉尾部斜杠）的基址；未配置为 null。 */
  serverUrl: string | null;
  /** 部署发放的设备凭证；未配置为 null。**绝不出现在响应或日志里。** */
  deviceToken: string | null;
  /**
   * 服务端托管存储的对象键前缀；未配置为空串（= 不额外加前缀）。
   *
   * 放在这里而不是另造一段 `storage.server.*`：存储后端是「接入服务端」这个能力的下游，
   * 它需要的地址与凭据就是上面那一对；只多一个纯属可选的键前缀，不值得再开一套配置面
   * （两套配置迟早出现「登录连 A、字节写 B」的分裂）。
   */
  keyPrefix: string;
};

export type ReadDeploymentInput = {
  env?: Record<string, string | undefined>;
  /** 显式配置文件路径（测试用）；缺省读扩展目录下的 config.local.json。 */
  configFile?: string | URL;
  /** 已提交到设置面的非秘密值（`host.config.values()`）。 */
  values?: Record<string, unknown>;
};

/**
 * 读部署配置。三类来源按「文件 < 环境变量 < 设置面非秘密项」顺序合并，
 * 与宿主配置层的优先级方向一致（越靠后越具体）。
 */
export function readRemoteServerDeployment(input: ReadDeploymentInput = {}): RemoteServerDeployment {
  const env = input.env ?? process.env;
  const file = input.configFile ?? env.WOOHAA3_REMOTE_SERVER_CONFIG_FILE ?? new URL(`../${REMOTE_SERVER_LOCAL_CONFIG}`, import.meta.url);
  let local: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("配置必须是 JSON 对象");
    }
    local = parsed as Record<string, unknown>;
  } catch (error) {
    // 文件不存在是正常状态（未接入远端），其它读取/解析错误必须说出来。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`remote-server 配置读取失败：${typeof file === "string" ? file : fileURLToPath(file)}`);
    }
  }

  const pick = (key: string): string | null => {
    const fromValues = input.values?.[key];
    if (typeof fromValues === "string" && fromValues.trim() !== "") return fromValues.trim();
    // 只有既有那两个环境变量参与覆盖：`keyPrefix` 是纯可选的展示级配置，不值得为它新增
    // 一条部署期环境变量（也就没有对应的 `REMOTE_SERVER_*` 常量，`shared.ts` 保持原样）。
    const fromEnv = key === "serverUrl"
      ? env[REMOTE_SERVER_URL_ENV]
      : key === "deviceToken"
        ? env[REMOTE_SERVER_DEVICE_TOKEN_ENV]
        : undefined;
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
    const fromFile = local[key];
    if (typeof fromFile === "string" && fromFile.trim() !== "") return fromFile.trim();
    return null;
  };

  const rawUrl = pick("serverUrl");
  const parsedUrl = rawUrl === null ? null : parseServerUrl(rawUrl);
  if (parsedUrl !== null && !parsedUrl.ok) throw new Error(`remote-server serverUrl 非法：${parsedUrl.message}`);

  return {
    serverUrl: parsedUrl === null ? null : parsedUrl.value,
    deviceToken: pick("deviceToken"),
    // 键前缀两端斜杠在这里就归一化掉：消费者（存储后端）只想拿一个干净片段。
    keyPrefix: (pick("keyPrefix") ?? "").replace(/^\/+|\/+$/g, "")
  };
}
