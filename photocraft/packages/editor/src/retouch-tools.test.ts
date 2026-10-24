import {describe,expect,it} from "vitest";
import {DEFAULT_RETOUCH,RETOUCH_SPECS,buildRetouch,isRetouchTool,retouchCommand,retouchToolIds} from "./retouch-tools.js";
import {TOOL_SLOTS,groupOf,slotOf,toolbarMembers} from "./toolbar-slots.js";

const points=[{x:10.4,y:20.6},{x:11,y:21}];

describe("润饰画笔命令参数",()=>{
 it("每个工具都映射到固定引擎的独立命令，不共享普通画笔入口",()=>{
  expect(retouchToolIds()).toHaveLength(16);
  expect([...new Set(retouchToolIds().map(id=>retouchCommand(id)))]).toHaveLength(16);
  expect(Object.values(RETOUCH_SPECS).every(spec=>spec.command.startsWith("paint."))).toBe(true);
 });

 it("每个工具在一级工具栏里有唯一归属槽位，并按上游分属 6 个不同组",()=>{
  // 16 个绘画/润饰工具各自是一级工具 id：不再共用「润饰」伪工具。
  for(const tool of retouchToolIds()) {
   expect(isRetouchTool(tool)).toBe(true);
   const slots=TOOL_SLOTS.filter(slot=>slot.members.some(member=>member.tool===tool));
   expect(slots).toHaveLength(1);
  }
  const indexes=new Set(retouchToolIds().map(tool=>slotOf(tool)!.index));
  // 修复 7、画笔 8、仿制 9、历史 10、橡皮 11、模糊 13、减淡 14 —— 颜色替换与混合画笔在画笔槽。
  expect([...indexes].sort((a,b)=>a-b)).toEqual([7,8,9,10,11,13,14]);
  // 颜色替换与混合画笔属于画笔组（B），不应留在修复组。
  expect(groupOf("colorReplacement")?.map(member=>member.id)).toEqual(["brush","pencil","mixer","colorReplacement"]);
  expect(groupOf("mixer")?.map(member=>member.id)).toEqual(["brush","pencil","mixer","colorReplacement"]);
  expect(groupOf("cloneStamp")?.map(member=>member.id)).toEqual(["cloneStamp","patternStamp"]);
  // 模糊族没有组键：不在任何字母组里。
  expect(groupOf("blur")).toBeUndefined();
  expect(groupOf("sharpen")).toBeUndefined();
  expect(groupOf("smudge")).toBeUndefined();
  // 历史记录画笔独占一槽。
  expect(slotOf("historyBrush")?.members).toHaveLength(1);
 });

 it("16 个工具都出现在工具栏可见成员里（没有只存在于注册表、点不到的工具）",()=>{
  const visible=new Set(toolbarMembers().map(member=>member.tool));
  for(const tool of retouchToolIds()) expect(visible.has(tool)).toBe(true);
 });

 it("克隆类工具携带对齐、取样图层与显式来源点，缺省时交给克隆源面板",()=>{
  expect(buildRetouch("cloneStamp",points[0]!,points,DEFAULT_RETOUCH,"#000000","pixels",1))
   .toMatchObject({aligned:true,sampleLayer:"current"});
  expect(buildRetouch("cloneStamp",points[0]!,points,DEFAULT_RETOUCH,"#000000","pixels",1)).not.toHaveProperty("source");
  expect(buildRetouch("healingBrush",points[0]!,points,{...DEFAULT_RETOUCH,aligned:false,sampleLayer:"all",source:[4,8]},"#000000","pixels",1))
   .toMatchObject({aligned:false,sampleLayer:"all",source:[4,8]});
  expect(buildRetouch("cloneStamp",points[0]!,points,{...DEFAULT_RETOUCH,source:null,offset:[3,4]},"#000000","pixels",1))
   .toMatchObject({offset:[3,4]});
 });

 it("颜色替换携带模式、取样、限制与容差，并固定像素目标",()=>{
  const params=buildRetouch("colorReplacement",points[0]!,points,{...DEFAULT_RETOUCH,mode:"luminosity",sampling:"once",limits:"findEdges",tolerance:300},"#ff0000","pixels",1);
  expect(params).toMatchObject({mode:"luminosity",sampling:"once",limits:"findEdges",tolerance:100,antiAlias:true,color:"#ff0000",target:"pixels"});
  expect(params).toMatchObject({points:[[10.4,20.6],[11,21]],size:24,hardness:80,opacity:100,flow:100});
 });

 it("混合/图案/历史画笔只传递自身设置，图案缺失时不生成命令",()=>{
  expect(buildRetouch("mixer",points[0]!,points,{...DEFAULT_RETOUCH,wet:70,load:30,mix:80,cleanAfterStroke:false,loadAfterStroke:false},"#000000","pixels",1))
   .toMatchObject({wet:70,load:30,mix:80,cleanAfterStroke:false,loadAfterStroke:false,sampleAllLayers:false});
  expect(buildRetouch("patternStamp",points[0]!,points,{...DEFAULT_RETOUCH,pattern:""},"#000000","pixels",1)).toBeNull();
  expect(buildRetouch("patternStamp",points[0]!,points,{...DEFAULT_RETOUCH,pattern:"dots",impressionist:true,scale:250,angle:30},"#000000","pixels",1))
   .toMatchObject({pattern:"dots",impressionist:true,scale:250,angle:30,aligned:true});
  expect(buildRetouch("historyBrush",points[0]!,points,DEFAULT_RETOUCH,"#000000","pixels",1)).not.toHaveProperty("state");
  expect(buildRetouch("historyBrush",points[0]!,points,{...DEFAULT_RETOUCH,historyState:3},"#000000","pixels",1)).toMatchObject({state:3});
 });

 it("色调与局部画笔按原生参数名传递范围、曝光、强度与保护开关",()=>{
  expect(buildRetouch("dodge",points[0]!,points,{...DEFAULT_RETOUCH,toneRange:"highlights",exposure:77,protectTones:false},"#000000","pixels",1))
   .toMatchObject({range:"highlights",exposure:77,protectTones:false,sampleAllLayers:false});
  expect(buildRetouch("burn",points[0]!,points,{...DEFAULT_RETOUCH,toneRange:"shadows"},"#000000","pixels",1)).toMatchObject({range:"shadows"});
  expect(buildRetouch("sponge",points[0]!,points,{...DEFAULT_RETOUCH,saturate:true},"#000000","pixels",1)).toMatchObject({mode:"saturate",vibrance:true});
  expect(buildRetouch("sharpen",points[0]!,points,{...DEFAULT_RETOUCH,protectDetail:false,strength:12},"#000000","pixels",1)).toMatchObject({protectDetail:false,strength:12});
  expect(buildRetouch("smudge",points[0]!,points,{...DEFAULT_RETOUCH,fingerPainting:true},"#00ff00","pixels",1)).toMatchObject({fingerPainting:true,color:"#00ff00"});
 });

 it("点按类工具只提交一个坐标并拒绝非有限坐标",()=>{
  expect(buildRetouch("redEye",{x:30.6,y:40.2},points,DEFAULT_RETOUCH,"#000000","pixels",1)).toEqual({x:31,y:40,pupilSize:50,darken:50});
  expect(buildRetouch("magicEraser",{x:5,y:6},points,DEFAULT_RETOUCH,"#000000","pixels",1)).toMatchObject({x:5,y:6,tolerance:30,antiAlias:true,contiguous:true,opacity:100});
  expect(buildRetouch("backgroundEraser",points[0]!,points,{...DEFAULT_RETOUCH,protectForegroundColor:true},"#000000","pixels",1)).toMatchObject({protectForegroundColor:true,sampling:"continuous",limits:"contiguous"});
  expect(buildRetouch("dodge",{x:Number.NaN,y:0},[{x:Number.NaN,y:0}],DEFAULT_RETOUCH,"#000000","pixels",1)).toBeNull();
 });

 it("尺寸与百分比夹紧到固定引擎注册表范围，不静默扩大资源",()=>{
  expect(buildRetouch("blur",points[0]!,points,{...DEFAULT_RETOUCH,size:99999,hardness:150,opacity:0,flow:-5},"#000000","pixels",1))
   .toMatchObject({size:5000,hardness:100,opacity:1,flow:1});
 });
});
