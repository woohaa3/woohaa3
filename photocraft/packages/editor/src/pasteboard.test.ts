import {it,expect} from "vitest";
import {CANVAS_COLORS,DEFAULT_PASTEBOARD,normalizePasteboard,cyclePasteboard,pasteboardStyle,canvasBorderStyle} from "./pasteboard.js";
it("工作区严格恢复颜色、边界和点纹，颜色循环包含自定义且双向绕回",()=>{
 expect(normalizePasteboard(null)).toEqual(DEFAULT_PASTEBOARD);
 expect(normalizePasteboard({color:"custom",custom:"#AbCdEf",border:"line",dots:false})).toEqual({color:"custom",custom:"#abcdef",border:"line",dots:false});
 expect(normalizePasteboard({color:"red",custom:"red",border:"solid",dots:"false"})).toEqual(DEFAULT_PASTEBOARD);
 let value={...DEFAULT_PASTEBOARD};for(const item of CANVAS_COLORS){expect(value.color).toBe(item.id);value=cyclePasteboard(value,false);}expect(value).toEqual(DEFAULT_PASTEBOARD);
 expect(cyclePasteboard(DEFAULT_PASTEBOARD,true).color).toBe("custom");expect(DEFAULT_PASTEBOARD.color).toBe("default");
 expect(pasteboardStyle({...value,color:"darkGray"})).toMatchObject({backgroundColor:"#282828",backgroundImage:"none"});
 expect(pasteboardStyle({...value,color:"custom",custom:"#123456"})).toMatchObject({backgroundColor:"#123456",backgroundImage:"none"});
 expect(pasteboardStyle({...value,dots:false}).backgroundImage).toBe("none");expect(pasteboardStyle(value).backgroundSize).toBe("22px 22px");
 expect(canvasBorderStyle({...value,border:"none"})).toEqual({boxShadow:"none",outline:"none"});expect(canvasBorderStyle({...value,border:"line"}).outline).toBe("1px solid #141414");
});
