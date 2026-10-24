import {expect,it} from "vitest";import {parseNumericExpression as parse} from "./numeric-expression.js";
it("算术优先级、括号、幂右结合、一元负号、常量和科学计数",()=>{
 for(const [text,value] of [["1920/2",960],["2+3*4",14],["(2+3)*4",20],["-2^2",-4],["2**3**2",512],["2^-2",.25],["10%3",1],["1e-3*1000",1],["−12+.5",-11.5],["pi*2",2*Math.PI],["tau/2",Math.PI]] as const)expect(parse(text),text).toBeCloseTo(value,10);
});
it("按字段单位转换长度；百分比和角度只接受同单位，不混淆余数",()=>{
 expect(parse("2in+25.4mm",{unit:"px",dpi:300})).toBeCloseTo(900);expect(parse("72pt",{unit:"in",dpi:300})).toBe(1);expect(parse("2pica",{unit:"pt"})).toBe(24);expect(parse("50%*2",{unit:"%"})).toBe(100);expect(parse("45°+15",{unit:"°"})).toBe(60);
 for(const [text,units] of [["2in",undefined],["2in",{unit:"%"}],["5%",{unit:"px"}],["2in",{unit:"px",dpi:0}]] as const)expect(parse(text,units)).toBeNull();
});
it("无效表达式、除零/溢出、注入、超长和过深输入不会执行或产出NaN",()=>{
 for(const text of [""," ","2+","(2+3","2 3","1e","1/0","5%0","1e999","(-2)^.5","globalThis.alert(1)","1;2","Math.PI","2in","()","(".repeat(33)+"1"+")".repeat(33),"1".repeat(1025)])expect(parse(text),text).toBeNull();
});
