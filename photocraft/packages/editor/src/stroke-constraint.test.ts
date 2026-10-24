import {expect,it} from "vitest";
import {StrokeConstraint} from "./stroke-constraint.js";
it("Shift按屏幕阈值锁定八方向，保留压力并不随角度摆动",()=>{
 const stroke=new StrokeConstraint({x:10,y:10},true,0.5);
 expect(stroke.update({x:12,y:11,pressure:.3},true)).toEqual({x:10,y:10,pressure:.3});
 expect(stroke.update({x:30,y:12,pressure:.7},true)).toEqual({x:30,y:10,pressure:.7});
 expect(stroke.update({x:20,y:100},true)).toEqual({x:20,y:10});
 expect(stroke.update({x:30,y:40},false)).toEqual({x:30,y:40});
 const diagonal=stroke.update({x:40,y:50},true);expect(diagonal.x).toBeCloseTo(40);expect(diagonal.y).toBeCloseTo(50);
});
it("中途按Shift以最近输出为锚点，再次释放和按下重新锁轴",()=>{
 const stroke=new StrokeConstraint({x:0,y:0},false,1);
 stroke.update({x:20,y:30},false);
 expect(stroke.update({x:21,y:40},true)).toEqual({x:20,y:40});
 stroke.update({x:60,y:70},false);
 const p=stroke.update({x:50,y:80},true);expect(p.x).toBeCloseTo(50);expect(p.y).toBeCloseTo(80);
});
