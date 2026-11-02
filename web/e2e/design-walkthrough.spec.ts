import { designEvidence as evidence } from "./design-evidence.js";
import { canonicalFilmSetFields } from "@woohaa3/contracts";
import { base, clip } from "./fixtures/film-set-animation-clips.js";
import { type Page } from "@playwright/test";
import { expect, test } from "./review-browser.js";
import { installPageHelpers, resetCanvasStorage, waitForCanvasSession, readStoredCanvas, sendCommands } from './helpers.js';

async function controlsAreSeparate(page: Page, selector: string) {
  const controls = await page.locator(selector).evaluateAll(elements => elements.map(element => {
    const r = element.getBoundingClientRect();
    const top = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
    return { label: element.getAttribute('aria-label') || element.textContent, x:r.x, y:r.y, width:r.width, height:r.height,
      visible: element === top || element.contains(top), right:r.right, bottom:r.bottom };
  }));
  const size = page.viewportSize()!;
  for (const control of controls) {
    expect(control.visible, String(control.label)).toBe(true);
    expect(control.x).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(size.width);
    expect(control.y).toBeGreaterThanOrEqual(0); expect(control.bottom).toBeLessThanOrEqual(size.height);
    expect(control.height, String(control.label)).toBeGreaterThanOrEqual(44);
  }
  for (let i=0;i<controls.length;i++) for(let j=i+1;j<controls.length;j++) {
    const a=controls[i],b=controls[j];
    const overlap=Math.min(a.right,b.right)-Math.max(a.x,b.x)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1;
    expect(overlap, `${a.label} overlaps ${b.label}`).toBe(false);
  }
}

test.describe('design walkthrough regressions', () => {
  test.use({ hasTouch: true, isMobile: true });
  for(const width of [360,390,768,1440]) test(`empty-state creation and usable generation actions at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:844});
    await installPageHelpers(page);await resetCanvasStorage(page);await waitForCanvasSession(page);
    await expect(page.getByRole('button',{name:'新建作品',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'导入素材',exact:true})).toBeVisible();
    await evidence(page, `final-empty-${width}`, `空画布新建/导入入口，${width}px 触控模拟`);
    expect(await page.locator('body').evaluate(e=>getComputedStyle(e).fontFamily)).not.toContain('Times New Roman');
    await page.getByRole('button',{name:'新建作品',exact:true}).click();
    await page.getByRole('menuitem',{name:'文本',exact:true}).click();
    await expect.poll(async()=> (await readStoredCanvas(page))?.document.nodes.length).toBe(1);
    await expect(page.getByRole('button',{name:'新建作品',exact:true})).toHaveCount(0);
    const point=await page.evaluate(()=>{const s=(window as any).__bevyRuntime.lastScene(),n=s.nodes[0],r=document.querySelector('#bevy-canvas')!.getBoundingClientRect();return {x:r.x+(n.x+20)*s.viewport.zoom+s.viewport.x,y:r.y+(n.y+20)*s.viewport.zoom+s.viewport.y};});
    await page.mouse.click(point.x,point.y);
    await expect(page.locator('.node-execution-dock')).toBeVisible();
    await controlsAreSeparate(page,'.mc-panel__sectioned-footer button');
    await page.getByRole('button',{name:'选择生成模型',exact:true}).click();
    const menu = page.getByRole('menu',{name:'选择生成模型',exact:true});
    await expect(menu).toBeVisible();
    await expect.poll(async () => { const b = await menu.boundingBox(); return !!b && b.x >= 0 && b.x + b.width <= width + 1; }).toBe(true);
    await evidence(page, `final-model-menu-${width}`, `模型菜单完整位于视口内，${width}px`);
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'生成参数',exact:true}).click();
    await expect(page.locator('.mc-panel__settings-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await evidence(page, `final-generation-${width}`, `生成动作与任务活动入口无交叠，${width}px 触控模拟`);
    await page.getByRole('button',{name:'打开快捷改写',exact:true}).click();
    await expect(page.getByRole('button',{name:'打开快捷改写',exact:true})).toHaveAttribute('aria-expanded','true');
    await evidence(page, `final-rewrite-${width}`, `点击快捷改写后弹层保持打开，${width}px`);
  });
  for (const width of [360, 390]) test(`film playback actions stay usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installPageHelpers(page); await resetCanvasStorage(page); await waitForCanvasSession(page);
    const fields = canonicalFilmSetFields({ ...base, filmSetAnimations: { schemaVersion: 3, defaultClipId: "parkour", clips: [clip("parkour", "16:9", true)] } });
    expect((await sendCommands(page, [{ type: "node.add", node: { id: "design-film", type: "composite-asset", position: { x: 20, y: 100 }, width: 260, height: 195 }, nodeData: fields as never }])).ok).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes.find((n: any) => n.id === "design-film")?.model?.resourceKey)).toBeTruthy();
    const point = await page.evaluate(() => { const s = (window as any).__bevyRuntime.lastScene(), n = s.nodes.find((n: any) => n.id === "design-film"), r = document.querySelector("#bevy-canvas")!.getBoundingClientRect(); return { x: r.x + (n.x + n.width / 2) * s.viewport.zoom + s.viewport.x, y: r.y + (n.y + n.height / 2) * s.viewport.zoom + s.viewport.y }; });
    await page.mouse.dblclick(point.x, point.y);
    await page.getByRole("tab", { name: "动画", exact: true }).click();
    await page.getByRole("button", { name: "动画预览", exact: true }).click();
    await expect(page.locator(".film-set-animation-player")).toBeVisible();
    await controlsAreSeparate(page, ".film-set-animation-player button");
    const player = await page.locator(".film-set-animation-player").boundingBox();
    const inspector = await page.locator(".model-editor-dock").boundingBox();
    expect(player).not.toBeNull(); expect(inspector).not.toBeNull();
    expect(player!.y + player!.height).toBeLessThanOrEqual(inspector!.y + 1);
    await evidence(page, `final-film-${width}`, `片场动画播放器动作完整可命中，${width}px 触控模拟`);
    await page.getByRole("button", { name: "返回编辑", exact: true }).click();
    await expect(page.getByLabel("拍摄镜头")).toBeVisible();
  });
  test('empty-state import uploads a real image and survives reload',async({page})=>{
    await installPageHelpers(page);await resetCanvasStorage(page);await waitForCanvasSession(page);
    const choosing=page.waitForEvent('filechooser');
    await page.getByRole('button',{name:'导入素材',exact:true}).click();
    await (await choosing).setFiles({name:'first-image.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARQAChgGj2M0AAAAASUVORK5CYII=','base64')});
    await expect.poll(async()=>(await readStoredCanvas(page))?.document.nodes.filter(n=>n.type==='image').length).toBe(1);
    await expect(page.getByRole('button',{name:'导入素材',exact:true})).toHaveCount(0);
    await page.reload();await waitForCanvasSession(page);
    expect((await readStoredCanvas(page))?.document.nodes.filter(n=>n.type==='image')).toHaveLength(1);
  });
});
