import {expect,it} from "vitest";
import { focusLayout } from "@woohaa3/frontend/plugin-api";
import {INITIAL_EDITOR_DISPLAY,editorDisplayLayout,toggleEditorDisplay} from "@woohaa3/photocraft-editor";

it("Tab 恢复此前工具/侧栏组合，Shift+Tab 独立切换侧栏，不改边界偏好",()=>{
  let state=toggleEditorDisplay(INITIAL_EDITOR_DISPLAY,"sidebar");
  expect(state.sidebarVisible).toBe(false);expect(state.toolsVisible).toBe(true);
  state=toggleEditorDisplay(state,"extras");
  state=toggleEditorDisplay(state,"panels");
  expect(state.toolsVisible||state.sidebarVisible).toBe(false);
  state=toggleEditorDisplay(state,"panels");
  expect(state.toolsVisible).toBe(true);expect(state.sidebarVisible).toBe(false);expect(state.extrasVisible).toBe(false);
  state=toggleEditorDisplay(state,"panels");state=toggleEditorDisplay(state,"sidebar");
  expect(state.toolsVisible).toBe(false);expect(state.sidebarVisible).toBe(true);
});

it("工具和侧栏占位只通过公共布局变化，菜单保留，边界开关不改内容矩形",()=>{
  const layout=(state:typeof INITIAL_EDITOR_DISPLAY)=>focusLayout({...editorDisplayLayout(state),width:1600,height:1000});
  const full=layout(INITIAL_EDITOR_DISPLAY);
  const edges=layout(toggleEditorDisplay(INITIAL_EDITOR_DISPLAY,"extras"));
  expect(edges).toEqual(full);
  const side=layout(toggleEditorDisplay(INITIAL_EDITOR_DISPLAY,"sidebar"));
  expect(side.tools).toBe(full.tools);expect(side.panelWidth).toBe(0);
  expect(side.contentRect.width-full.contentRect.width).toBe(280);
  const hidden=layout(toggleEditorDisplay(INITIAL_EDITOR_DISPLAY,"panels"));
  expect(hidden.tools).toBe(0);expect(hidden.panelWidth).toBe(0);expect(hidden.toolbar).toBe(44);
  expect(hidden.contentRect.height-full.contentRect.height).toBe(52);
});

 it("工具栏/选项栏/侧栏八种组合按Tab原样恢复，布局各自占位",()=>{
 for(let bits=0;bits<8;bits++){
  const state={...INITIAL_EDITOR_DISPLAY,toolsVisible:!!(bits&1),optionsVisible:!!(bits&2),sidebarVisible:!!(bits&4)};
  const hidden=toggleEditorDisplay(state,"panels"),restored=toggleEditorDisplay(hidden,"panels");
  if(bits){expect(hidden.toolsVisible||hidden.optionsVisible||hidden.sidebarVisible).toBe(false);expect(restored).toEqual(state);}
  else expect(hidden.toolsVisible&&hidden.optionsVisible&&hidden.sidebarVisible).toBe(true);
 }
 const tools=toggleEditorDisplay(INITIAL_EDITOR_DISPLAY,"tools"),options=toggleEditorDisplay(INITIAL_EDITOR_DISPLAY,"options");
 expect(tools.optionsVisible).toBe(true);expect(editorDisplayLayout(tools)).toMatchObject({toolColumn:0,toolbar:96});
 expect(options.toolsVisible).toBe(true);expect(editorDisplayLayout(options)).toMatchObject({toolColumn:52,toolbar:44});
 });
