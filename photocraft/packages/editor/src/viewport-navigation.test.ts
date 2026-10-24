import {expect,it} from "vitest";
import {navigateViewport} from "./viewport-navigation.js";
it("翻页按视口或10屏幕像素移动，边界与小图钳制且保持倍率",()=>{
 const view={x:0,y:0,zoom:2},size={width:800,height:600},document={width:1600,height:1200};
 expect(navigateViewport(view,size,document,{key:"PageDown",horizontal:false,small:false})).toEqual({...view,y:-600});
 expect(navigateViewport(view,size,document,{key:"PageUp",horizontal:true,small:true})).toEqual({...view,x:10});
 expect(navigateViewport({...view,y:-850},size,document,{key:"PageDown",horizontal:false,small:false})).toEqual({...view,y:-900});
 expect(navigateViewport(view,size,document,{key:"Home",horizontal:false,small:false})).toEqual({...view,x:1200,y:900});
 expect(navigateViewport(view,size,document,{key:"End",horizontal:false,small:false})).toEqual({...view,x:-1200,y:-900});
 expect(navigateViewport({...view,zoom:.25},size,document,{key:"End",horizontal:false,small:false})).toEqual({x:-0,y:-0,zoom:.25});
});
