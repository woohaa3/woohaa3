/**
 * 业务源码规模报告（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，任务 7.3）。
 *
 * 复用门禁同一分类器（`web/tooling/source-size.ts`），输出全量业务文件物理行排行与
 * 残余超限/例外清单，供审查与 worklog 引用。**不依赖 Git 快照**：直接扫描工作区，
 * 因此可与门禁结果互相印证。
 *
 * 用法（仓库根）：`node web/scripts/report-business-line-counts.mjs [--out <dir>]`
 * 默认写到 `reports/`：`business-code-line-ranking.md` / `.csv`。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_BUSINESS_SOURCE_LINES,
  collectBusinessSourceSizes
} from "../tooling/source-size.ts";
import { EXCEPTIONS, PENDING_SPLIT } from "../tooling/source-size-allowlist.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const OUT_DIR = path.resolve(REPO_ROOT, outIndex >= 0 ? args[outIndex + 1] : "reports");

const sizes = collectBusinessSourceSizes(REPO_ROOT);
const sorted = [...sizes].sort((a, b) => b.lines - a.lines);
const totalLines = sizes.reduce((sum, entry) => sum + entry.lines, 0);
const over = sorted.filter((entry) => entry.lines > MAX_BUSINESS_SOURCE_LINES);

const csvRows = ["rank,lines,business,file"];
sorted.forEach((entry, index) => {
  csvRows.push(`${index + 1},${entry.lines},yes,${entry.path}`);
});

const overRows = over
  .map((entry) => {
    const status = PENDING_SPLIT.has(entry.path)
      ? "待拆分（inventory R）"
      : entry.path in EXCEPTIONS
        ? `例外：${EXCEPTIONS[entry.path]}`
        : "未登记（门禁失败）";
    return `| ${entry.lines} | ${entry.path} | ${status} |`;
  })
  .join("\n");

const md = `# 业务源码逐文件行数排行（工作区实时统计）

本报告由 \`web/scripts/report-business-line-counts.mjs\` 生成，口径与门禁
\`web/tooling/source-size.test.ts\` 一致：覆盖 \`web/**\`、\`bevy/**\`、\`scripts/**\`
的维护源码，排除构建产物、vendor、测试/测试支持、fixture、生成文件与声明。

物理行包含空行与注释；与 \`wc -l\` 在换行结尾文件上一致。

共 ${sizes.length} 个业务文件，${totalLines} 行；>${MAX_BUSINESS_SOURCE_LINES} 行 ${over.length} 个。

## 残余超限（拆分债/例外）

| 行数 | 文件 | 状态 |
|---:|---|---|
${overRows || "| — | 无 | — |"}
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "business-code-line-ranking.csv"), `${csvRows.join("\n")}\n`);
writeFileSync(path.join(OUT_DIR, "business-code-line-ranking.md"), md);
console.log(`业务文件 ${sizes.length}，共 ${totalLines} 行；>${MAX_BUSINESS_SOURCE_LINES} 行 ${over.length} 个。`);
console.log(`已写入 ${path.relative(REPO_ROOT, OUT_DIR)}/business-code-line-ranking.{md,csv}`);
