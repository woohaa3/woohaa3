/**
 * 计算「git 语义」下的文本摘要：先做 EOL 归一化再取 sha256。
 *
 * 为什么不能直接对工作区文件求哈希：Windows 构建机的 `core.autocrlf` 会把 checkout
 * 出的文本转成 CRLF，同一份内容在两台机器上字节不同，拿它当 lock 的 `generatedFrom`
 * 指纹就会在 Windows 上判「失效」（2026-11-12 分发现场：#91 Windows 报
 * `runtime-npm-lock.json 与 pnpm lockfile 不一致`，而提交的摘要与 git blob 完全一致）。
 *
 * 归一化只动行尾（`\r\n` / 孤立 `\r` → `\n`），不改其它字节；生成与校验用同一函数，
 * 两端口径必然一致。
 */
import { createHash } from 'node:crypto';

export function normalizedTextSha256(text) {
  return createHash('sha256').update(String(text).replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}
