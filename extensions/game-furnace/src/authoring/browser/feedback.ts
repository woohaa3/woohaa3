/**
 * 游戏炼丹炉工作区反馈 live region（扩展自有）
 * （change: 2026-10-10-add-game-furnace-extension，任务 4.3/4.4）。
 *
 * 拖入收集/保存/生成的安全反馈。写入 `role="status"` 的 live region；无 DOM（测试/SSR）静默。
 */
const REGION_ID = "game-furnace-feedback";

export function reportGameFurnace(message: string | null): void {
  if (typeof document === "undefined") return;
  let region = document.getElementById(REGION_ID);
  if (!region) {
    region = document.createElement("div");
    region.id = REGION_ID;
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.style.position = "fixed";
    region.style.bottom = "16px";
    region.style.left = "50%";
    region.style.transform = "translateX(-50%)";
    region.style.padding = "6px 12px";
    region.style.borderRadius = "6px";
    region.style.background = "rgba(20,24,28,0.92)";
    region.style.color = "#fff";
    region.style.fontSize = "13px";
    region.style.zIndex = "1100";
    region.style.pointerEvents = "none";
    document.body.appendChild(region);
  }
  region.textContent = message ?? "";
  region.style.display = message ? "block" : "none";
}
