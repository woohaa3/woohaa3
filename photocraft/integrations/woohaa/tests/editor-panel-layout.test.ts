import {expect,it} from "vitest";
import {DEFAULT_PANEL_LAYOUT,normalizePanelLayout} from "@woohaa3/photocraft-editor";
import {INITIAL_EDITOR_DISPLAY,editorDisplayLayout} from "@woohaa3/photocraft-editor";
import { focusLayout } from "@woohaa3/frontend/plugin-api";
it("面板偏好严格归一，非法存储不进入布局，尺寸/分区有界",()=>{
  expect(normalizePanelLayout(null)).toEqual(DEFAULT_PANEL_LAYOUT);
  expect(normalizePanelLayout({width:"500",floating:"true",split:NaN,x:Infinity})).toEqual(DEFAULT_PANEL_LAYOUT);
  expect(normalizePanelLayout({width:900,height:1,x:-9,y:20000,split:2,floating:true,layersCollapsed:true})).toEqual({...DEFAULT_PANEL_LAYOUT,width:480,height:320,x:0,y:10000,split:.8,floating:true,layersCollapsed:true});
});
it("只有停靠宽度占公共内容矩形，浮动和分区调整不另算图片取景",()=>{
  const layout=(patch:object)=>focusLayout({...editorDisplayLayout({...INITIAL_EDITOR_DISPLAY,panelLayout:normalizePanelLayout({...DEFAULT_PANEL_LAYOUT,...patch})}),width:1600,height:1000});
  expect(layout({width:400}).contentRect.width).toBe(1148);
  expect(layout({floating:true}).contentRect.width).toBe(1548);
  expect(layout({x:40,y:80,height:800,split:.8,layersCollapsed:true})).toEqual(layout({}));
});
