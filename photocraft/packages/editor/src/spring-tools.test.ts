import {expect,it} from "vitest";
import {SpringTools} from "./spring-tools.js";
it("短按永久切换，300ms或使用画布后恢复；自动重复不重置计时",()=>{
 const tools=new SpringTools<string>();tools.press("b","move","brush",0);expect(tools.release("b",299,false)).toBeNull();
 tools.press("e","brush","eraser",400);tools.press("e","eraser","eraser",650);expect(tools.release("e",700,false)).toBe("brush");
 tools.press("v","eraser","move",1000);tools.useCanvas();expect(tools.release("v",1001,false)).toBe("eraser");
});
it("半笔完成才恢复，其他keyup不释放，失焦清除待恢复状态",()=>{
 const tools=new SpringTools<string>();tools.press("b","move","brush",0);tools.useCanvas();expect(tools.release("x",500,false)).toBeNull();expect(tools.release("b",500,true)).toBeNull();expect(tools.finish(true)).toBeNull();expect(tools.finish(false)).toBe("move");expect(tools.finish(false)).toBeNull();
 tools.press("z","brush","zoom",0);expect(tools.reset()).toBe("brush");expect(tools.release("z",500,false)).toBeNull();
});
