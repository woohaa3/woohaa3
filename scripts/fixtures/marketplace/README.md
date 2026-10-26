# 扩展市场测试 fixture

供 `scripts/pack-extension.test.mjs`、`scripts/fixtures-marketplace.test.mjs` 与端到端使用
（change `2026-10-21-add-extension-marketplace-point` 任务 9.3、`2026-10-21-isolate-extension-host-process` 任务 10.2）。
**不在任何扩展根里**，不会被宿主扫描、不进 pnpm 工作区；打包时 `@woohaa3/contracts` 与 `@sdppp/pptask` 按源码内联，
React / extension-api 由前端 shim 解析。

| 目录 | 形态 | 用途 |
| --- | --- | --- |
| [fixture-panel](fixture-panel) | 纯前端站点扩展（`server-active`） | 热登记：已打开页面不刷新即可装配 |
| [fixture-echo-provider](fixture-echo-provider) | 含后端 Provider，真实走 pptask | 子进程执行：`echo-text`（language，doGenerate 同步回显）与 `echo-image`（image，doStart/doStatus → jobs，产出 1×1 PNG）；结果 `providerMetadata["fixture-echo"].pid` 是子进程 pid；`POST /api/extensions/fixture-echo-provider/refresh` 返回 `{ ok, modelCount, pid }`；配置 `providers.fixture-echo.greeting` / `delayMs` |
| [fixture-crashy](fixture-crashy) | 含后端，故意出故障 | `POST /api/extensions/fixture-crashy/{exit,throw,hang,oom,ping}`；模型 `crash-exit` / `crash-hang` 在 doGenerate 时退出 / 死循环，`crash-ok` 正常；`providers.fixture-crashy.crashOnActivate=true` 激活即退出（熔断用例） |
| [fixture-greedy](fixture-greedy) | 含后端，激活时逐项越权 | `GET /api/extensions/fixture-greedy/probes` 返回 `{ pid, probes: [{ name, ok, code?, detail? }] }`，期望见源码头注释表 |

## 用法

```bash
# 生成本机签名密钥（keyId 与 base64 公钥写进本机信任根 extensions.marketplace.trustedKeys）
pnpm pack:extension --genkey .local/wxt/dev
# 打包（含后端的产出单文件 backend-dist/entry.mjs；C 方向起不再产出 config-schema.json）
pnpm pack:extension scripts/fixtures/marketplace/fixture-echo-provider --key .local/wxt/dev.key --out .local/wxt/echo-1.0.0.wxt
pnpm pack:extension scripts/fixtures/marketplace/fixture-crashy        --key .local/wxt/dev.key --out .local/wxt/crashy.wxt
pnpm pack:extension scripts/fixtures/marketplace/fixture-greedy        --key .local/wxt/dev.key --out .local/wxt/greedy.wxt
# 安装：设置弹窗「插件配置 → 从文件安装」，或
curl -X POST --data-binary @.local/wxt/echo-1.0.0.wxt -H 'content-type: application/octet-stream' http://127.0.0.1:5180/api/extensions/install
```

升级用例：把 `fixture-echo-provider/extension.json`、`package.json` 与 `src/shared.ts` 的版本改成 1.1.0 后再打包一次
（或用 `scripts/fixtures-marketplace.test.mjs` 里的 `packFixture(name, { version })`，它在临时副本里改版本，不动仓库文件）。
