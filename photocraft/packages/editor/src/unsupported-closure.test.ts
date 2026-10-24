/**
 * 「明确不支持」条目的入口关闭回归（V12）。
 *
 * 矩阵里每个不支持项都必须同时满足两条：命令不在能力白名单内，且菜单里没有可执行入口。
 * 这里从矩阵解析被点名的命令 id，再对照 `capability.rs` 与编辑器菜单目录，避免只靠文字记录。
 */
import {readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {describe,expect,it} from "vitest";
import {EDITOR_MENUS} from "./photo-editor-menu.js";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
const matrix=readFileSync(resolve(root,"openspec/changes/2026-10-24-resolve-photocraft-interaction-gaps/notes/disposition-matrix.md"),"utf8");
const capability=readFileSync(resolve(root,"rust/crates/editor-core/src/capability.rs"),"utf8");
const slice=(start:string,end:string)=>{const from=capability.indexOf(start),to=capability.indexOf(end,from+1);if(from<0||to<0)throw new Error(`缺少区块 ${start}…${end}`);return capability.slice(from,to);};
const allowed=new Set([...slice("pub const ALLOWED_COMMANDS","pub fn command_allowed").matchAll(/"([^"]+)"/g)].map(match=>match[1]));
const disabled=new Set([...slice("pub const DISABLED_FEATURES","pub fn is_enabled").matchAll(/"([^"]+)"/g)].map(match=>match[1]));

const unsupported=matrix.split("\n").filter(line=>/^\| I\d{3} \|/.test(line)).map(line=>{
  const cells=line.split("|").map(cell=>cell.trim());
  return {id:cells[1],name:cells[2],disposition:cells[3],evidence:cells[6]};
}).filter(row=>row.disposition.startsWith("明确不支持"));

/** 证据里点名的内核命令 id（排除文件名与通配族）。 */
const COMMAND_REF=/`((?:layer|select|image|file|edit|paint|type|view|color|brush|slice|vector|filter|actions|timeline|cloneSource|tools|history|channel|compose|format)[A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+)`/g;
const named=(evidence:string)=>[...new Set([...evidence.matchAll(COMMAND_REF)].map(match=>match[1]))]
  .filter(id=>!/\.(ts|tsx|rs|json|css|mjs|md)$/.test(id));

/** 菜单目录里出现的所有条目 id（递归子菜单）。 */
type MenuNode={id:string;children?:readonly MenuNode[]};
function menuIds(items:readonly MenuNode[]):string[]{
  return items.flatMap(item=>[item.id,...(item.children?menuIds(item.children):[])]);
}
// 菜单目录按「顶级菜单 → 条目」两层组织；展开成条目 id 集合。
const menuEntries=new Set<string>([
  ...EDITOR_MENUS.map(menu=>menu.label),
  ...EDITOR_MENUS.flatMap(menu=>menuIds(menu.items as readonly MenuNode[]))
]);

describe("明确不支持项的命令与菜单都关闭",()=>{
  it("矩阵解析到 72 条明确不支持项",()=>{
    expect(unsupported).toHaveLength(72);
  });

  it("不支持项点名的命令都不在能力白名单内",()=>{
    const leaks:string[]=[];
    for(const row of unsupported)for(const id of named(row.evidence))if(allowed.has(id))leaks.push(`${row.id}:${id}`);
    expect(leaks).toEqual([]);
  });

  it("不支持项点名的命令都不作为菜单条目出现",()=>{
    const leaks:string[]=[];
    for(const row of unsupported)for(const id of named(row.evidence))if(menuEntries.has(id))leaks.push(`${row.id}:${id}`);
    expect(leaks).toEqual([]);
  });

  it("显式关闭清单里的能力确实不在开放清单里",()=>{
    for(const id of disabled)expect(allowed.has(id)).toBe(false);
    // 抽样断言与本 change 直接相关的关闭项。
    for(const id of ["vector.path","type.path","layer.smart-object","filter.complex","color.icc","selection.ai-subject","tool.clone","tool.healing"]) {
      expect(disabled.has(id)).toBe(true);
    }
    // 本轮新开放的命令确实在白名单内，且不是被同时关闭的能力。
    for(const id of ["paint.cloneStamp","paint.healingBrush","cloneSource.list","cloneSource.set","cloneSource.overlay"]) {
      expect(allowed.has(id)).toBe(true);
      expect(disabled.has(id)).toBe(false);
    }
  });

  it("每条不支持项都写明入口/命令与其关闭方式",()=>{
    const surface=/入口|菜单|工具栏|面板|命令|白名单|开关|偏好|设置|对话框/;
    const closed=/无|没有|不出现|不提供|不显示|不注册|不列|不复制|未开放|不开放|关闭|未进入白名单|保持不可执行|拒绝/;
    // 点名的命令 id 本身也算「说明了关闭对象」，不必再写「命令」二字。
    const missing=unsupported.filter(row=>(!surface.test(row.evidence)&&named(row.evidence).length===0)||!closed.test(row.evidence)).map(row=>row.id);
    expect(missing).toEqual([]);
  });
});
