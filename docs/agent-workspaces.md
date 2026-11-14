# 助手工作目录

Tauri 桌面版为每个画布提供本机工作目录。目录身份由本机 profile、owner 和稳定画布 ID 决定；改名、续聊和更换助手保留目录，复制画布与其他设备各用独立目录。原生会话、引擎配置与凭据继续保存在工作目录之外。

设置 → 助手显示当前根位置，默认为应用数据目录下的 `agent-workspaces`。可以选择新位置、打开根目录和当前画布目录、清理已结束回合。更换位置会等待已有助手结束，再迁移全部受管目录；切换前可以取消。

## Harness 工作上下文

宿主给支持本机工作目录的 harness 传入画布目录作为 cwd，保留它内置的文件读写和命令执行工具，不注册 `workspace_*` MCP 工具。角色的画布工具集合保持原样，讨论也能使用 harness 原生工具辅助计算。目录结构为：

```text
<根位置>/<画布目录键>/
  shared/                  # 同画布助手共享资料
  runs/<回合键>/            # 提示助手将本轮临时文件写到这里
```

所有同画布 harness 的 cwd 都是上述画布根目录；`runs/` 是临时文件约定，不是另一套默认 cwd 或文件工具。助手可以用自己的 Read/Write/Edit/Bash、shell 或对应工具读取 `shared/input.json`，在本轮 `runs/` 下编写脚本并执行。运行输出、退出码、工具调用身份及停止行为由 harness 自己管理，宿主不再提供另一套命令工具循环。Python 等依赖按机器实际安装情况使用。

本机 Codex App Server、OpenCode、CodeBuddy，SDK 的 Codex、Claude、DSH，以及 OAuth Codex 支持该接线。纯远端模型循环和当前 Gemini ADK 没有本机文件/终端工具，不获得本机工作目录；不以一套宿主文件 MCP 工具补偿。普通 Web host、浏览器分发、连接探测、无画布上下文和只读画布不启用此能力。

## 画布权限与文件产物

文件和代码只用于辅助目标。正式画布编辑仍经过本轮授权的 Woohaa 领域工具，文件写入和 shell 成功不计为画布交付。媒体产物通过既有受权 Media 导入入口获得稳定资产身份；临时路径本身不是画布资产，删除临时文件不会删除已导入资产。

目录与 cwd 不构成操作系统沙箱；代码以当前用户账号运行。Codex 使用原生 `workspace-write` 模式，Claude、DSH、OpenCode、CodeBuddy 使用各自的工具权限。运行环境和私有配置保持隔离，不把应用 bridge token 注入工具环境，不加载额外用户 MCP 配置。

## 停止、迁移与恢复

取消回合通过既有 harness 取消路径处理。目录租约另持有 harness 的真实占用，直到执行返回才释放，因此聊天先标记取消也不会提前搬走 cwd。daemon 异常重启后无法证明旧 harness 已退出的占用持久保留为 `unknown`，阻止清理与迁移，不自动重跑代码。

迁移使用 staging copy 和清单/hash 校验，落盘后原子提交 root revision/generation。切换前失败保留旧根，切换后旧副本清理失败保留新根并报告清理状态。下一回合重新解析 cwd。外部程序不受应用磁盘锁控制。

清理只删除指定画布已终态且没有原生 harness 活跃/未知占用的受管 runs；shared、非受管文件与其他画布保留。删除画布不自动删除磁盘文件。根位置和工作文件不进入 Y.Doc、远端同步或 `.woohaa` 导出；导入保留当前安装的根位置。

## 验证入口

运行时测试 `packages/execution-runtime/src/harness-workspace.test.ts` 覆盖真实 Node、跨助手共享、跨画布隔离、身份拒绝及迁移占用；SDK 的 `native-workspace-runtime.test.ts` 使用真实 Claude/DSH harness 与本地可控模型响应：Claude 验证原生 shell 读文件、执行 Node 并写结果，DSH 验证原生读写；若宿主无法运行 DSH 沙箱后端，保留其真实错误，不记为 shell 闭环通过。真实 Provider 验收可显式运行 `web/tooling/canvas-workspace-sdk.live.test.ts`（`WOOHAA_WORKSPACE_LIVE_SDK=1`）。macOS/Windows 实际安装包及各真实 Provider 仍需分别验收。
