import {it,expect} from "vitest";
import {scrollbarSpan} from "./viewport-scrollbar.js";
it("滚动条比例/最小滑块与屏幕换算保持原生Span语义，小图Overscroll可从边到边",()=>{
 const span=scrollbarSpan(1600,0,800,1,788,false)!;expect(span).toMatchObject({start:197,length:394,travel:394,center:800,page:800,lo:0,hi:1600});expect(span.perPoint).toBeCloseTo(800/394);
 const small=scrollbarSpan(400,0,800,1,788,true)!;expect(small).toMatchObject({lo:-400,hi:800});expect(small.travel).toBeGreaterThan(0);
 expect(scrollbarSpan(400,0,800,1,788,false)).toMatchObject({start:0,length:788,perPoint:0});
 expect(scrollbarSpan(1e8,0,800,1,788,false)!.length).toBe(24);
 expect(scrollbarSpan(1600,0,800,0,788,false)).toBeNull();expect(scrollbarSpan(1600,NaN,800,1,788,false)).toBeNull();
});
