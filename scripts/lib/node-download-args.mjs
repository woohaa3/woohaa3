/**
 * Node 发行包下载的统一 curl 参数（web host 与桌面装配共用）。
 *
 * 为什么不是一条固定的 curl 命令：
 * - CI 会把 curl 的进度条整体标成 `##[error]` 并冲掉真实错误行，因此用 `-sS` 静默进度；
 * - `--retry` 默认只重试连接失败，传输中途断开不会重试，需要 `--retry-all-errors`；
 * - `--continue-at -` 让重试从断点续传，不必重下 50 MB。
 *
 * `--retry-all-errors` 是 curl 7.71 才有的选项：Windows Server 自带的 `curl.exe`
 * （7.55 左右）不认它，直接把整条命令判成语法错误（2026-11-12 Windows 分发现场）。
 * 因此先探测本机 curl 支持哪些选项，再据此拼参数——缺失时退回老版本也能用的组合，
 * 由外层的“校验失败就丢弃重下”兜住不完整的下载。
 */
import { execFileSync } from 'node:child_process';

/** 本机 curl 是否认识某个长选项。 */
export function curlSupports(curl, option) {
  try {
    // 故意把未知选项和 --version 放在一起：认识的会一起打印，不认识的立即非零退出。
    execFileSync(curl, [option, '--version'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 下载参数。`probe` 可注入，便于测试不同 curl 版本的行为。
 */
export function nodeDownloadArgs(url, destination, { curl = 'curl', probe = curlSupports } = {}) {
  const retryAll = probe(curl, '--retry-all-errors');
  return [
    '-sS', '--fail', '--location',
    '--retry', '5', '--retry-delay', '2',
    ...(retryAll ? ['--retry-all-errors'] : []),
    '--continue-at', '-',
    url, '-o', destination
  ];
}
