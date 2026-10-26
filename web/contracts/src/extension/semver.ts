/**
 * semver range 子集（浏览器与扩展可用；change: 2026-10-21-add-server-extension-marketplace，D1）。
 *
 * 与 `scripts/lib/extension-descriptor.mjs` 的 `satisfiesRange` / `isSemver` **语义逐条一致**：扩展只能
 * 依赖 contracts，拿不到仓库根脚本，于是这里是同一份规则的 TS 版本；`semver.test.ts` 用同一组用例
 * 对两份实现做一致性断言，任一侧改动都会让测试失败。
 *
 * 支持：`*`、`x`、`1` / `1.x` / `1.2.x`、精确版本、`^`、`~`、`>= > <= < =`，空格交集、`||` 并集。
 * 预发布后缀只比较核心三段。非法 range 返回 `null`。
 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

type Triple = [number, number, number];
type Partial3 = [number, number | null, number | null];

export function isSemver(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}

function parseVersion(value: string): Partial3 | null {
  const match = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(value);
  if (!match) return null;
  const part = (raw: string | undefined) => (raw === undefined || raw === "x" || raw === "*" ? null : Number(raw));
  return [Number(match[1]), part(match[2]), part(match[3])];
}

function compareTriples(a: Triple, b: Triple): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

function coreOf(version: string): Triple | null {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function matchComparator(target: Triple, comparator: string): boolean | null {
  if (comparator === "*" || comparator === "x") return true;
  const match = /^(\^|~|>=|<=|>|<|=)?v?(.+)$/.exec(comparator);
  if (!match) return null;
  const operator = match[1] ?? "";
  const parsed = parseVersion(match[2]!.replace(/-.*$/, ""));
  if (!parsed) return null;
  const [major, minor, patch] = parsed;
  const floor: Triple = [major, minor ?? 0, patch ?? 0];
  if (operator === "^") {
    const ceiling: Triple = major > 0 ? [major + 1, 0, 0] : minor === null ? [1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, (patch ?? 0) + 1];
    return compareTriples(target, floor) >= 0 && compareTriples(target, ceiling) < 0;
  }
  if (operator === "~") {
    const ceiling: Triple = minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0];
    return compareTriples(target, floor) >= 0 && compareTriples(target, ceiling) < 0;
  }
  if (operator === "" || operator === "=") {
    if (minor === null) return target[0] === major;
    if (patch === null) return target[0] === major && target[1] === minor;
    return compareTriples(target, floor) === 0;
  }
  const order = compareTriples(target, floor);
  if (operator === ">=") return order >= 0;
  if (operator === ">") return order > 0;
  if (operator === "<=") return order <= 0;
  return order < 0;
}

export function satisfiesRange(version: string, range: string): boolean | null {
  const target = coreOf(version);
  if (!target || typeof range !== "string" || range.trim().length === 0) return null;
  let anyValid = false;
  for (const alternative of range.split("||").map((entry) => entry.trim())) {
    if (alternative.length === 0) return null;
    let ok = true;
    for (const comparator of alternative.split(/\s+/)) {
      const result = matchComparator(target, comparator);
      if (result === null) return null;
      if (!result) ok = false;
    }
    anyValid = true;
    if (ok) return true;
  }
  return anyValid ? false : null;
}

/** 严格 semver 的核心三段比较（预发布不参与；非法版本排最前）。 */
export function compareSemver(a: string, b: string): number {
  const left = coreOf(a);
  const right = coreOf(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  return compareTriples(left, right);
}

/** 在候选版本里选满足 range 的最高版本；没有返回 null。 */
export function maxSatisfying(versions: readonly string[], range: string): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (satisfiesRange(version, range) !== true) continue;
    if (best === null || compareSemver(version, best) > 0) best = version;
  }
  return best;
}
