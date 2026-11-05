import { existsSync } from "node:fs";
import path from "node:path";

/** Match build-model-renderer output on the host; an explicit command always wins. */
export function resolveModelRendererCommand({ root, env = process.env, platform = process.platform, arch = process.arch, exists = existsSync }) {
  // 显式配置只在文件真实存在时生效；过期路径不能把可用 debug/release 产物挡掉。
  if (env.WOOHAA3_MODEL_RENDERER_CMD && exists(env.WOOHAA3_MODEL_RENDERER_CMD)) return env.WOOHAA3_MODEL_RENDERER_CMD;
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  const triple = env.WOOHAA3_NATIVE_TARGET ?? (platform === "darwin" ? `${cpu}-apple-darwin`
    : platform === "win32" ? `${cpu}-pc-windows-msvc` : `${cpu}-unknown-linux-gnu`);
  const binary = platform === "win32" ? "model-renderer.exe" : "model-renderer";
  for (const profile of ["release", "debug"]) {
    for (const dir of [path.join(root, "bevy/target", triple, profile), path.join(root, "bevy/target", profile)]) {
      const candidate = path.join(dir, binary);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}
