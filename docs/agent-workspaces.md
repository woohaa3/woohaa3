# 助手工作目录

Tauri 桌面版为每个画布提供本机工作目录。同画布的助手共用 `shared/`，每个回合另有 `runs/<回合键>/`。画布、owner 和本机 profile 决定目录身份；改名不改变目录，复制画布取得新目录，其他设备有各自的本机目录。原生引擎会话与凭据继续独立保存。

设置 → 助手显示当前根位置，默认在应用数据目录的 `agent-workspaces`。可以选择新位置、打开根目录和当前画布目录、清理已结束回合。选择新位置会迁移全部受管目录；已有助手继续工作，迁移等它们结束。切换前可以取消；迁移完成后的旧副本清理失败不会让根位置退回。

## 角色与通道

有工具调用能力、当前画布可写时，宿主给讨论和创作回合合入 `workspace_list/read/write/mkdir/execute/query/stop/import`。角色无需另行声明 Node 或内建终端权限，也不能自行构造 workspace handle、绝对根位置、owner 或 grant。本机、SDK/API、OAuth、桌面主动调用的远端模型通过同一工具面操作本机文件与进程。连接测试、无画布上下文、只读画布、不支持工具的模型及普通浏览器/Web host 不取得此能力。

例如，一个只回复文本的角色可以保留原有 `output: { kind: "reply" }` 与空内容工具集合，在提示词中要求：“需要计算时，使用宿主本轮实际提供的 workspace 工具；把临时脚本写入本回合目录，读取真实执行输出后再回答。工具缺失时说明缺失，不假装已运行。”辅助工具不授予额外画布/世界写权限，工作文件本身不会变成画布节点。

## 一次辅助计算

以下 `<runKey>` 取自宿主冻结上下文，工具参数中不携带 handle、owner 或绝对路径。

```json
{"tool":"workspace_write","arguments":{"path":"runs/<runKey>/calculate.cjs","content":"console.log(Array.from({length:100},(_,i)=>i+1).reduce((a,b)=>a+b,0))","expectedHash":null}}
{"tool":"workspace_execute","arguments":{"operationId":"calculate-v1","command":"node","args":["calculate.cjs"]}}
{"tool":"workspace_query","arguments":{"executionId":"<execute 返回的 executionId>","after":0}}
```

`execute` 默认 cwd 是本回合目录；显式 cwd 和文件路径相对画布目录，例如 `shared/result.json`。读取接口返回 hash，后续写入可带 `expectedHash` 防止覆盖别人修改的共享文件；`null` 要求文件尚不存在。文本读取上限 4 MiB，较大文件用脚本分片处理。正式媒体使用 `workspace_import` 携带相对路径与真实 `contentType`，导入上限 64 MiB；返回稳定媒体身份后，沿角色原有画布工具提交。清理源文件不影响已导入资产，不会自动创建节点或上传整个目录。

相同回合中，同一 `operationId` 和同输入复用执行，响应丢失后查询原身份；改参数要用新身份。查询按输出 cursor 返回 stdout/stderr、真实退出码和状态；收到一批后把最后 cursor 作为下次 `after`。非零退出与缺失程序如实失败；Node 使用随包版本，Python 等需已安装，不自动安装或改用其他语言。`shell: true` 明确选择平台 shell 语义，普通命令优先分开传 command/args。

## 停止、迁移与恢复

取消回合会撤销后续调用并清理其辅助进程树；关闭设置、切画布、宿主 detach 不结束 daemon 中的任务。daemon 重启不自动重跑命令，也不凭历史 PID 杀进程。无法证明终态的执行记为 `unknown`，保留文件并阻止迁移与清理；先核对真实进程和任务状态，不能把未知改成成功以继续。

迁移使用 staging copy 和清单/hash 校验，数据落盘后提交根位置 revision/generation。提交前失败保持旧根；提交后旧副本被占用或外部改写则保留副本并显示清理状态。目标有冲突目录时拒绝，目标无关文件保留。外部程序仍可能修改文件，本机进程没有全局磁盘锁。清理只删除当前画布已终态且无活跃/未知执行的受管 runs；shared、未知/运行回合、非受管文件保留，删除画布不自动删除磁盘文件。

执行代码使用当前用户 OS 账号，可访问该账号有权访问的路径与网络。文件工具拒绝相对路径越界、链接/junction 和伪造身份；这些检查以及 cwd 不构成任意脚本的 OS 沙箱。子进程使用必要环境白名单，不注入应用 bridge token、Provider key 或原生引擎配置。

根位置、工作文件与执行器状态不进入 Y.Doc、远端同步或 `.woohaa`；导出界面明确排除助手工作文件，导入保留当前安装的根位置。跨机器迁移工作文件尚无专用打包入口。

## 平台验证

Linux 的真实 Node、进程组、跨文件系统迁移、故障恢复及资产导入已由集成测试验证，Rust 桌面壳已通过编译检查。Windows Job Object runner、macOS/Windows 实际安装包的原生 picker/open、随包 Node 和桌面/Pad 视觉仍需在对应平台验收；编译通过不代表这些体验已经验证。


开发验收可显式运行 `web/tooling/canvas-workspace-sdk.live.test.ts`。它默认跳过；设置 `WOOHAA_WORKSPACE_LIVE_SDK=1`、`WOOHAA_WORKSPACE_LIVE_MODEL` 与已配置的 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 后，会使用实际 SDK/CLI 和供应商，通过 MCP 写脚本、执行 Node、查询并核对磁盘结果。请勿把密钥写入脚本、命令行或验收报告。该用例只证明实际运行成功的 SDK 通道，不替代本机、OAuth、远端和真实桌面平台验收。
