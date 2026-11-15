/**
 * 凭据修订（change: 2026-11-16-repair-generation-callback-stalls，缺陷 3）。
 *
 * `GenerationProvider.credentialEpoch` 要求「单调、只放不可逆摘要、绝不放明文密钥」。
 * 各 Provider 用它把当前配置的凭据折叠成一个整数，参与 Task 侧 registry 的缓存签名——
 * 签名变化才会重建执行实例。
 *
 * 为什么必须有它：registry 原本只按 providerId/available/catalogRevision/models 缓存，
 * 换 key 不改这些字段，于是缓存命中、继续用持旧 key 的实例。表现是配置已保存、
 * `testConnection`（现读配置）通过，真实生成却持续鉴权失败，**只有重启进程才恢复**
 * （2026-11-16 现场：RunningHub 同一个 key 重启前一失败一成功）。
 *
 * 用 FNV-1a 32 位：它在快、不依赖 Web Crypto（同步可用）、且只用于「是否变化」的比较；
 * 不承担密码学强度职责（摘要不出日志、不出公开视图、不做认证）。
 */
export function credentialEpoch(secret: string | undefined): number {
  const value = (secret ?? "").trim();
  if (value === "") return 0;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
