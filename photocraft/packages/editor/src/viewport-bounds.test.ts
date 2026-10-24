import {it,expect} from "vitest";
import {clampViewport} from "./viewport-bounds.js";
it("Overscroll关闭时大图不离边，小图可在视口内移到边缘，不强制重新居中",()=>{
 const size={width:800,height:600},doc={width:1600,height:900};
 expect(clampViewport({zoom:1,x:900,y:-900},size,doc,false)).toEqual({zoom:1,x:400,y:-150});
 expect(clampViewport({zoom:.25,x:900,y:-900},size,doc,false)).toEqual({zoom:.25,x:200,y:-187.5});
 expect(clampViewport({zoom:.25,x:50,y:30},size,doc,false)).toEqual({zoom:.25,x:50,y:30});
 expect(clampViewport({zoom:.5,x:900,y:NaN},size,doc,false)).toEqual({zoom:.5,x:0,y:0});
 const view={zoom:1,x:900,y:-900};expect(clampViewport(view,size,doc,true)).toBe(view);expect(clampViewport(view,{width:0,height:600},doc,false)).toBe(view);
});
