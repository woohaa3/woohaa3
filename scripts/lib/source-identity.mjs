import { execFileSync } from 'node:child_process';

/** Fail closed when Git cannot establish the source tree identity. */
export function readSourceIdentity(root) {
  try {
    const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], options);
    return { revision, dirty: status.trim().length > 0 };
  } catch {
    return { revision: null, dirty: true };
  }
}
