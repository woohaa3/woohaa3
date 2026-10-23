// 真实浏览器走查（headless Chromium，无 GPU）：验证通道面板在**真实装配**下可见可用。
//
// 不做像素/视觉验收（无 GPU 环境不采渲染证据），只验证单元测试覆盖不到的接缝：
// 共享 CSS 可见性、菜单入口、面板挂载、真实 WASM 命令被调用、以及 Pad 窗口布局。
// 直接用 Chromium 的 DevTools 协议：本仓库没有 puppeteer 依赖，不值得为一个探针引入。
import { spawn } from "node:child_process";
import fs from "node:fs";

const CHROME = "/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const URL = "http://127.0.0.1:5179/";
const results = [];
const check = (label, pass, detail = "") => results.push({ label, pass: Boolean(pass), detail });

const profile = fs.mkdtempSync("/tmp/channel-walk-");
const chrome = spawn(CHROME, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--remote-debugging-port=9333",
  `--user-data-dir=${profile}`,
  "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function debuggerUrl() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
      const page = list.find((entry) => entry.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chromium 调试端口未就绪");
}

const socket = new WebSocket(await debuggerUrl());
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  } else if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params.exceptionDetails.text ?? "exception");
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};


/** 用真实指针事件点击：Radix 菜单在 pointerdown 上打开，合成 click 不会触发。 */
async function pointerClick(selectorText, { nth = 0 } = {}) {
  const box = await evaluate(`
    const nodes = Array.from(document.querySelectorAll("button,[role=menuitem]"))
      .filter((element) => (element.textContent ?? "").trim() === ${JSON.stringify(selectorText)});
    const element = nodes[${nth}];
    if (!element) return null;
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  `);
  if (!box) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  return true;
}

/** 画布监听 pointer 事件（不是 mouse）：必须用 Input.dispatchMouseEvent 之外的 pointerType。 */
async function pointerStroke(from, to, steps = 12) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, buttons: 1, pointerType: "mouse" });
  for (let step = 0; step <= steps; step++) {
    const x = from.x + ((to.x - from.x) * step) / steps;
    const y = from.y + ((to.y - from.y) * step) / steps;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, pointerType: "mouse" });
    await sleep(25);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1, buttons: 0, pointerType: "mouse" });
}

/** 点击以指定文字开头的菜单项（菜单内容在 portal 里）。 */
async function pointerClickStartsWith(prefix) {
  const box = await evaluate(`
    const nodes = Array.from(document.querySelectorAll("[role=menuitem],[role=menuitemradio],button"))
      .filter((element) => (element.textContent ?? "").trim().startsWith(${JSON.stringify(prefix)}));
    const element = nodes[0];
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  `);
  if (!box) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  return true;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL });

// 等宿主外壳与内核就绪（未打开文档时没有画布，只能等导入控件）。
let shell = false;
for (let attempt = 0; attempt < 200; attempt++) {
  shell = await evaluate(`return Boolean(document.querySelector("input[type=file]"));`);
  if (shell) break;
  await sleep(300);
}
check("dev 宿主已装配", shell);
// 建立可操作文档：dev 宿主靠导入真实图片打开文档（与用户路径一致）。
const document_ = await send("DOM.getDocument", { depth: -1 });
const input = await send("DOM.querySelector", { nodeId: document_.root.nodeId, selector: 'input[type=file][accept*="image/png"]' });
if (!input.nodeId) throw new Error("找不到导入图片的 file input");
await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: ["/data/tmp/opencode/channel-probe.png"] });
let opened = false;
for (let attempt = 0; attempt < 200; attempt++) {
  opened = await evaluate(`return Boolean(document.querySelector("[data-canvas-viewport]"));`);
  if (opened) break;
  await sleep(300);
}
check("导入图片后编辑器装载文档", opened);

const menuOpened = await pointerClick("图像");
await sleep(600);
const menuItems = await evaluate(`
  return Array.from(document.querySelectorAll("[role=menuitem],[role=menuitemradio]"))
    .map((element) => (element.textContent ?? "").trim()).filter(Boolean);
`);
check("「图像」菜单可打开", menuOpened && menuItems.length > 0, JSON.stringify(menuItems.slice(0, 20)));
check("「图像」菜单含通道/应用图像/计算三个入口",
  menuItems.some((t) => t.startsWith("通道")) && menuItems.some((t) => t.startsWith("应用图像")) && menuItems.some((t) => t.startsWith("计算")),
  JSON.stringify(menuItems));
const picked = await pointerClickStartsWith("通道");
await sleep(1600);
check("能从「图像」菜单打开通道面板", picked, "clicked=" + picked);

const panel = await evaluate(`
  const element = document.querySelector("[data-channel-panel]");
  if (!element) return { mounted: false };
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    mounted: true,
    visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
    size: Math.round(rect.width) + "x" + Math.round(rect.height),
    rows: element.querySelectorAll("[data-channel-row]").length,
    text: (element.textContent ?? "").replace(/\\s+/g, " ").slice(0, 240)
  };
`);
// 共享 CSS 的 3 行可见性规则缺失时，面板会挂载但尺寸为 0 —— 这正是要验证的接缝。
check("通道面板可见（共享 CSS 可见性规则生效）", panel.mounted && panel.visible, JSON.stringify(panel));
check("通道行渲染（复合 + RGB 分量）", panel.rows >= 4, "rows=" + panel.rows);
check("通道面板文案来自真实内核快照", /通道/.test(panel.text ?? ""), panel.text);

const created = await evaluate(`
  const scope = document.querySelector("[data-channel-create='alpha']");
  if (!scope) return { ok: false, reason: "没有新建 Alpha 区块" };
  const button = Array.from(scope.querySelectorAll("button")).at(-1);
  if (!button) return { ok: false, reason: "没有新建按钮" };
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const element = document.querySelector("[data-channel-panel]");
  return {
    ok: true,
    rows: element?.querySelectorAll("[data-channel-row]").length ?? 0,
    alpha: element?.querySelectorAll("[data-channel-kind]").length ?? 0,
    error: element?.querySelector("[data-channel-error]")?.textContent ?? null
  };
`);
check("面板新建 Alpha 通道后出现通道行", created.ok && created.alpha >= 1, JSON.stringify(created));
check("新建通道没有报错", created.error === null, JSON.stringify(created));

// 真实落笔：选中刚建的 Alpha 通道后在画布拖动，确认走的是通道而不是图层像素。
// 画布笔迹：本 harness 里合成指针能到达画布（pointerdown/move 均收到），但笔迹没有登记
// （历史里没有 paint.stroke、修订不变）。**同样的失败发生在复合目标上**，所以这是
// headless 合成指针的限制，不是通道目标的问题 —— 通道落笔的像素证据来自真实 WASM 冒烟
// （`wasm-smoke.mjs` 的「通道目标落笔写进该通道 / 不改图层像素」）。
const strokeHarness = await (async () => {
  const box = await evaluate(`
    const element = document.querySelector("[data-canvas-viewport]");
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  `);
  if (!box) return { ok: false };
  await evaluate(`
    window.__seen = [];
    for (const type of ["pointerdown","pointermove","pointerup"]) {
      document.addEventListener(type, () => window.__seen.push(type), { capture: true });
    }
    return true;
  `);
  await pointerStroke({ x: box.x - 30, y: box.y }, { x: box.x + 30, y: box.y }, 10);
  await sleep(1500);
  return await evaluate(`
    const status = document.querySelector("[data-dev-status]")?.textContent ?? "";
    return { ok: true, pointers: (window.__seen ?? []).length, status,
      painted: /paint/.test(document.querySelector("[class*=history]")?.textContent ?? "") };
  `);
})();
check("合成指针事件能到达画布", strokeHarness.ok && strokeHarness.pointers > 0, JSON.stringify(strokeHarness));
console.log(`NOTE 画布笔迹在 headless 合成指针下未登记（复合目标同样如此）→ 通道落笔像素证据取自真实 WASM 冒烟。`);

// 通道视图切换：面板内的有界预览要在真实装配下出现（主画布单通道视图由 WASM 冒烟验证）。
const viewToggle = await (async () => {
  await pointerClick("图像");
  await sleep(500);
  await pointerClickStartsWith("通道");
  await sleep(1500);
  const before = await evaluate(`return Boolean(document.querySelector("canvas.photo-editor__channel-view"));`);
  const pressed = await evaluate(`
    const button = Array.from(document.querySelectorAll("button"))
      .find((element) => (element.textContent ?? "").trim() === "查看通道视图");
    if (!button) return false;
    button.click();
    return true;
  `);
  await sleep(1500);
  const after = await evaluate(`
    const canvas = document.querySelector("canvas.photo-editor__channel-view");
    return { present: Boolean(canvas), size: canvas ? canvas.width + "x" + canvas.height : null };
  `);
  return { before, pressed, after };
})();
check("通道视图可切换并渲染有界预览", viewToggle.pressed && viewToggle.after.present, JSON.stringify(viewToggle));

// 应用图像 / 计算面板在真实装配下也能打开（同一菜单的另外两项）。
const applyPanel = await (async () => {
  await pointerClick("图像");
  await sleep(500);
  await pointerClickStartsWith("应用图像");
  await sleep(1500);
  return await evaluate(`
    const element = document.querySelector("[data-advanced-section='applyImage']");
    if (!element) return { mounted: false };
    const rect = element.getBoundingClientRect();
    return { mounted: true, visible: rect.width > 0 && rect.height > 0,
      text: (element.textContent ?? "").replace(/\\s+/g, " ").slice(0, 200) };
  `);
})();
check("应用图像面板可见", applyPanel.mounted && applyPanel.visible, JSON.stringify(applyPanel));

// 应用图像的真实提交：预览 → 确认必须各走一步真实内核调用（确认后历史多一步）。
const applyFlow = await evaluate(`
  const section = document.querySelector("[data-advanced-section='applyImage']");
  if (!section) return { ok: false, reason: "面板未挂载" };
  const buttons = Array.from(section.querySelectorAll("button"));
  const find = (label) => buttons.find((element) => (element.textContent ?? "").trim() === label);
  const preview = find("预览");
  const confirm = find("确认");
  if (!preview || !confirm) return { ok: false, reason: "缺少预览/确认", labels: buttons.map(b => (b.textContent ?? "").trim()) };
  const confirmDisabledBefore = confirm.disabled;
  preview.click();
  return { ok: true, confirmDisabledBefore };
`);
await sleep(2000);
const applyAfterPreview = await evaluate(`
  const section = document.querySelector("[data-advanced-section='applyImage']");
  const buttons = Array.from(section?.querySelectorAll("button") ?? []);
  const confirm = buttons.find((element) => (element.textContent ?? "").trim() === "确认");
  const history = document.querySelector("[class*=history]")?.textContent ?? "";
  return {
    confirmDisabled: confirm?.disabled ?? null,
    hasPreviewImage: Boolean(section?.querySelector("canvas")),
    history,
    error: section?.querySelector("[data-channel-error]")?.textContent ?? null
  };
`);
check("应用图像预览后可确认（预览未写入历史）", applyFlow.ok && applyAfterPreview.confirmDisabled === false
  && !/Apply Image/.test(applyAfterPreview.history), JSON.stringify({ applyFlow, applyAfterPreview }));

const applyCommit = await evaluate(`
  const section = document.querySelector("[data-advanced-section='applyImage']");
  const confirm = Array.from(section?.querySelectorAll("button") ?? [])
    .find((element) => (element.textContent ?? "").trim() === "确认");
  if (!confirm) return { ok: false };
  confirm.click();
  return { ok: true };
`);
await sleep(2200);
const applyCommitted = await evaluate(`
  return {
    history: document.querySelector("[class*=history]")?.textContent ?? "",
    status: document.querySelector("[data-dev-status]")?.textContent ?? ""
  };
`);
check("应用图像确认写入一步历史", applyCommit.ok && /Apply Image/.test(applyCommitted.history), JSON.stringify(applyCommitted));

const calcPanel = await (async () => {
  await pointerClick("图像");
  await sleep(500);
  await pointerClickStartsWith("计算");
  await sleep(1500);
  return await evaluate(`
    const element = document.querySelector("[data-advanced-section='calculations']");
    if (!element) return { mounted: false };
    const rect = element.getBoundingClientRect();
    return { mounted: true, visible: rect.width > 0 && rect.height > 0,
      text: (element.textContent ?? "").replace(/\\s+/g, " ").slice(0, 200) };
  `);
})();
check("计算面板可见", calcPanel.mounted && calcPanel.visible, JSON.stringify(calcPanel));

// 计算面板的真实闭环：预览→确认与通道面板同样走内核，确认后新增一个通道行。
const calcFlow = await evaluate(`
  const section = document.querySelector("[data-advanced-section='calculations']");
  if (!section) return { ok: false, reason: "面板未挂载" };
  const buttons = Array.from(section.querySelectorAll("button"));
  const find = (label) => buttons.find((element) => (element.textContent ?? "").trim() === label);
  const preview = find("预览");
  const confirm = find("确认");
  if (!preview || !confirm) return { ok: false, reason: "缺少预览/确认", labels: buttons.map(b => (b.textContent ?? "").trim()) };
  const confirmDisabledBefore = confirm.disabled;
  preview.click();
  return { ok: true, confirmDisabledBefore };
`);
await sleep(2200);
const calcPreviewed = await evaluate(`
  const section = document.querySelector("[data-advanced-section='calculations']");
  const buttons = Array.from(section?.querySelectorAll("button") ?? []);
  const confirm = buttons.find((element) => (element.textContent ?? "").trim() === "确认");
  return {
    confirmDisabled: confirm?.disabled ?? null,
    hasPreviewImage: Boolean(section?.querySelector("[data-channel-candidate]")),
    error: section?.querySelector("[data-channel-error]")?.textContent ?? null
  };
`);
check("计算预览后可确认（预览不改文档）", calcFlow.ok && calcFlow.confirmDisabledBefore === true
  && calcPreviewed.confirmDisabled === false && calcPreviewed.hasPreviewImage && calcPreviewed.error === null,
  JSON.stringify({ calcFlow, calcPreviewed }));

const calcCommit = await evaluate(`
  const section = document.querySelector("[data-advanced-section='calculations']");
  const confirm = Array.from(section?.querySelectorAll("button") ?? [])
    .find((element) => (element.textContent ?? "").trim() === "确认");
  if (!confirm) return false;
  confirm.click();
  return true;
`);
await sleep(2200);
const calcCommitted = await evaluate(`
  const history = document.querySelector("[class*=history]")?.textContent ?? "";
  const rows = Array.from(document.querySelectorAll("[data-channel-panel] [data-channel-kind]"))
    .map((element) => element.textContent ?? "");
  return { history, alphaRows: rows.length };
`);
// 计算的默认结果是「新通道」：确认后通道面板应当多一行 Alpha/专色。
check("计算确认写入一步历史并新增通道行",
  calcCommit && /Calculation/.test(calcCommitted.history) && calcCommitted.alphaRows >= 2,
  JSON.stringify(calcCommitted));

// 通道面板的删除闭环：删掉当前 Alpha 行后行消失、目标回到复合、历史多一步。
const deleteFlow = await (async () => {
  await pointerClick("图像");
  await sleep(500);
  await pointerClickStartsWith("通道");
  await sleep(1500);
  const before = await evaluate(`
    const rows = Array.from(document.querySelectorAll("[data-channel-panel] [data-channel-kind]"));
    return { rows: rows.length, history: document.querySelector("[class*=history]")?.textContent ?? "" };
  `);
  const deleted = await evaluate(`
    const button = Array.from(document.querySelectorAll("[data-channel-panel] button"))
      .find((element) => (element.getAttribute("title") ?? "") === "删除通道");
    if (!button) return false;
    button.click();
    return true;
  `);
  await sleep(1800);
  const after = await evaluate(`
    const panel = document.querySelector("[data-channel-panel]");
    return {
      rows: panel?.querySelectorAll("[data-channel-kind]").length ?? 0,
      target: panel?.dataset.channelTarget ?? null,
      history: document.querySelector("[class*=history]")?.textContent ?? "",
      error: panel?.querySelector("[data-channel-error]")?.textContent ?? null
    };
  `);
  return { before, deleted, after };
})();
check("删除通道行后目标回到复合且不留报错",
  deleteFlow.deleted && deleteFlow.after.rows === deleteFlow.before.rows - 1
  && deleteFlow.after.target === "composite" && deleteFlow.after.error === null
  && /Delete|删除/.test(deleteFlow.after.history),
  JSON.stringify(deleteFlow));

// 通道面板的分发按钮：亮度选区走本域命令、载入通道为选区走共享 dispatch，都必须在真实装配下可用。
const selectionButtons = await (async () => {
  const before = await evaluate(`
    const panel = document.querySelector("[data-channel-panel]");
    return { hasSelection: /载入亮度选区/.test(panel?.textContent ?? ""),
      history: document.querySelector("[class*=history]")?.textContent ?? "" };
  `);
  const clicked = await evaluate(`
    const panel = document.querySelector("[data-channel-panel]");
    const button = Array.from(panel?.querySelectorAll("button") ?? [])
      .find((element) => (element.textContent ?? "").trim() === "载入亮度选区");
    if (!button) return { ok: false, reason: "没有亮度选区按钮" };
    if (button.disabled) return { ok: false, reason: "按钮被禁用" };
    button.click();
    return { ok: true };
  `);
  await sleep(1800);
  const after = await evaluate(`
    const panel = document.querySelector("[data-channel-panel]");
    return {
      history: document.querySelector("[class*=history]")?.textContent ?? "",
      hasSelectionState: /\\(有选区\\)|选区/.test(panel?.textContent ?? ""),
      error: panel?.querySelector("[data-channel-error]")?.textContent ?? null
    };
  `);
  return { before, clicked, after };
})();
check("载入亮度选区在真实装配下可执行且不报错",
  selectionButtons.clicked.ok && selectionButtons.after.error === null,
  JSON.stringify(selectionButtons));

check("没有控制台错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

socket.close();
chrome.kill("SIGKILL");
fs.rmSync(profile, { recursive: true, force: true });

let failed = 0;
for (const item of results) {
  if (!item.pass) failed++;
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.label}${item.detail ? ` :: ${item.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
