/** 前端指引与 MCP 共用的交付约定；明确区分目标产物与当前协议能力。 */
export const GAME_FURNACE_AUTHORING = {
  format: "agent-built-site-v2",
  entry: "index.html",
  prepareTool: "prepare_game_project",
  submitTool: "submit_game",
  buildOwner: "agent",
  acceptsProjectFiles: false,
  acceptsBuiltDirectory: true,
  standaloneSite: true,
  targetFormat: "vite-static-site",
  deliveryRequirements: [
    "交付独立 Vite 游戏项目及可静态服务的 dist：index.html、打包后的 JS/CSS、assets/。",
    "使用的素材必须复制或打包进当前构建的 assets/，通过相对路径加载；运行时不依赖原画布、登录态或临时素材 URL。",
    "试玩打开固定构建的站点入口；资源按 HTTP 路径加载，不把素材 base64 放进 MCP/JSON 响应。",
    "验证静态站点启动、实际素材加载、开始/操作/结果/重开，以及桌面和触屏交互后，才报告交付完成。"
  ],
  limitation: "项目目录在宿主机器；Agent须有该目录的文件与终端访问能力，远程Agent需自行同步素材/产物。宿主不安装依赖、不运行构建。登记产物不设文件数/单项/总量额度，完整静态产物一次原子关联为不可变构建。html保留为旧格式兼容入口。",
  rules: "先读取最新 inputHash，再调用 prepare_game_project 准备目录并复制素材。Agent在projectDirectory自行写代码、配置依赖并执行构建（Vite base须为./，模板npm run build已配置）；确保准备素材进入dist/assets。构建后调用submit_game，提交projectId、稳定requestId、expectedInputHash和可选outputDirectory（默认dist），宿主只登记已有产物。preview_game返回entryUrl；iframe打开静态站点，Agent必须验证实际素材和玩法后才报告完成。",
  exampleFiles: { "index.html": '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><canvas id="game"></canvas><script type="module" src="./src/main.js"></script></body></html>', "src/main.js": 'import "./style.css";\nconst canvas = document.querySelector("#game");\n// 在这里实现开始、操作、评分/结束和重开，兼容键盘与触屏。', "src/style.css": 'html,body{margin:0;width:100%;height:100%}canvas{display:block}' }
} as const;
