import type {CSSProperties} from "react";

export const GRID_SIZES=[{id:"none",label:"关闭"},{id:"small",label:"小"},{id:"medium",label:"中"},{id:"large",label:"大"}] as const;
export const GRID_COLORS=[
  {id:"light",label:"浅色",colors:["#ffffff","#cccccc"]},
  {id:"medium",label:"中灰",colors:["#999999","#666666"]},
  {id:"dark",label:"深色",colors:["#666666","#333333"]},
  {id:"red",label:"红",colors:["#ffffff","#ffcccc"]},
  {id:"orange",label:"橙",colors:["#ffffff","#ffe5cc"]},
  {id:"green",label:"绿",colors:["#ffffff","#ccffcc"]},
  {id:"blue",label:"蓝",colors:["#ffffff","#cce5ff"]},
  {id:"purple",label:"紫",colors:["#ffffff","#e5ccff"]},
  {id:"custom",label:"自定义",colors:["#ffffff","#cccccc"]}
] as const;
export type TransparencyGrid={size:(typeof GRID_SIZES)[number]["id"];colors:(typeof GRID_COLORS)[number]["id"];light:string;dark:string};
export const DEFAULT_TRANSPARENCY_GRID:TransparencyGrid={size:"medium",colors:"light",light:"#ffffff",dark:"#cccccc"};
export function normalizeTransparencyGrid(value:unknown):TransparencyGrid {
  const raw=value && typeof value==="object"?value as Record<string,unknown>:{};
  const color=(key:"light"|"dark")=>typeof raw[key]==="string" && /^#[0-9a-f]{6}$/i.test(raw[key])?(raw[key] as string).toLowerCase():DEFAULT_TRANSPARENCY_GRID[key];
  return {size:GRID_SIZES.some(item=>item.id===raw.size)?raw.size as TransparencyGrid["size"]:"medium",colors:GRID_COLORS.some(item=>item.id===raw.colors)?raw.colors as TransparencyGrid["colors"]:"light",light:color("light"),dark:color("dark")};
}
/** 棋盘格尺寸按屏幕像素固定，关闭时透明像素显示白色；不参与文档内容或导出。 */
export function transparencyGridStyle(value:TransparencyGrid):CSSProperties {
  if(value.size==="none")return {backgroundColor:"#ffffff"};
  const [light,dark]=value.colors==="custom"?[value.light,value.dark]:GRID_COLORS.find(item=>item.id===value.colors)!.colors;
  const tile={small:8,medium:16,large:32}[value.size];
  return {backgroundColor:light,backgroundImage:`conic-gradient(${dark} 25%, ${light} 0 50%, ${dark} 0 75%, ${light} 0)`,backgroundSize:`${tile}px ${tile}px`};
}
