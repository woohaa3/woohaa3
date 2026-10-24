import {expect,it} from "vitest";
import {brushCursor,DEFAULT_CURSORS,normalTipRadius,normalizeCursors} from "./brush-cursor.js";
it("偏好严格恢复，正常圆笔尖遵守上游50%衰减曲线而非满尺寸",()=>{
 expect(normalizeCursors({painting:"bogus",center:"yes",paintingCrosshairOnly:1,other:"precise"})).toEqual({...DEFAULT_CURSORS,other:"precise"});
 expect(normalizeCursors({painting:"fullSizeTip",center:true,paintingCrosshairOnly:true})).toEqual({...DEFAULT_CURSORS,painting:"fullSizeTip",center:true,paintingCrosshairOnly:true});
 for(const hardness of [0,.15,.5,.99,1]){
  const radius=normalTipRadius(50,hardness);expect(radius).toBeGreaterThan(0);expect(radius).toBeLessThan(50);
 }
 expect(normalTipRadius(50,0)).toBeCloseTo(33.2*Math.sqrt(64*(1-Math.pow(.5,1/64))));
 expect(normalTipRadius(50,1)).toBeCloseTo(48.8+1.2*Math.sqrt(64*(1-Math.pow(.5,1/64))));
 expect(normalTipRadius(50,NaN)).toBe(normalTipRadius(50,0));
 const full=brushCursor({...DEFAULT_CURSORS,painting:"fullSizeTip"},100,.1,.5,false);expect(full).toMatchObject({mode:"outline",diameter:50});
 expect(brushCursor(DEFAULT_CURSORS,100,.1,.5,false).diameter).toBeLessThan(full.diameter);
});
it("标准/精确/中心十字与绘画期间替换分支独立，Block仍为16屏幕像素",()=>{
 expect(brushCursor({...DEFAULT_CURSORS,painting:"standard"},1,1,.5,false).mode).toBe("standard");
 expect(brushCursor({...DEFAULT_CURSORS,painting:"precise"},100,1,1,false).mode).toBe("precise");
 const prefs={...DEFAULT_CURSORS,paintingCrosshairOnly:true,center:true};expect(brushCursor(prefs,100,.5,1,false)).toMatchObject({mode:"outline",center:true});expect(brushCursor(prefs,100,.5,1,true).mode).toBe("precise");
 expect(brushCursor(DEFAULT_CURSORS,1,1,.5,false).mode).toBe("precise");expect(brushCursor(prefs,100,.5,1,true,true)).toEqual({mode:"outline",diameter:16,center:true,block:true});
});
