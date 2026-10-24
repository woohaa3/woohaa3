import {it,expect} from "vitest";
import {TouchNavigation} from "./touch-navigation.js";
it("双指以原中点文档坐标缩放并平移，剩余手指不恢复工具，新序列不继承旧锚点",()=>{
 const gesture=new TouchNavigation(),context={view:{x:0,y:0,zoom:1},width:800,height:600,documentWidth:1600,documentHeight:900};
 expect(gesture.down(1,{x:300,y:300},context)).toBe(false);expect(gesture.down(2,{x:500,y:300},context)).toBe(true);
 expect(gesture.move(2,{x:700,y:300})).toEqual({zoom:2,x:100,y:0});
 expect(gesture.up(2)).toBe(true);expect(gesture.active).toBe(true);expect(gesture.move(1,{x:800,y:300})).toBeNull();
 expect(gesture.up(1)).toBe(true);expect(gesture.active).toBe(false);expect(gesture.contacts).toBe(0);
 gesture.down(7,{x:100,y:100},context);expect(gesture.reset()).toEqual([7]);expect(gesture.move(7,{x:300,y:100})).toBeNull();
});
