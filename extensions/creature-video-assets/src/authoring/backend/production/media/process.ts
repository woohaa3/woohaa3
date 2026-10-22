import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowError } from "../../../../state/shared/workflow.js";
import { bundledTool } from "../tools.js";

export const tool = bundledTool;
/** Arguments are passed directly; no shell, cwd injection or media bytes on stdout. */
export async function runTool(name: "ffmpeg" | "ffprobe" | "toktx" | "python" | "node", args: string[], stopped: () => boolean = () => false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool(name), args, {shell:false, windowsHide:true, stdio:["ignore","pipe","pipe"]});
    let out = "", err = "", overflow = false, cancelled = false;
    const append = (value:string, chunk:Buffer) => { if (value.length + chunk.length > 1024 * 1024) { overflow = true; child.kill(); return value; } return value + chunk.toString("utf8"); };
    child.stdout.on("data", chunk => {out = append(out, chunk);}); child.stderr.on("data", chunk => {err = append(err, chunk);});
    const timer = setInterval(() => { if (stopped()) {cancelled = true; child.kill();} },250);
    const timeout = setTimeout(() => {cancelled = true; child.kill();},45 * 60_000);
    child.once("error", () => { clearInterval(timer); clearTimeout(timeout); reject(new WorkflowError("tool-unavailable", `无法启动 ${name}，请运行扩展工具检查。`)); });
    child.once("close", code => { clearInterval(timer); clearTimeout(timeout); if (code !== 0 || overflow || cancelled) reject(new WorkflowError(cancelled ? "executor-stopped" : "media-process-failed", `${name} 处理${cancelled ? "已停止" : "失败"}。${err.slice(-800)}`)); else resolve(out || err); });
  });
}
export type VideoInfo = {width:number;height:number;frames:number;fps:number;audio:boolean;pts:number[]};
export async function probe(file: string): Promise<VideoInfo> {
  const data = JSON.parse(await runTool("ffprobe", ["-v","error","-count_frames","-show_streams","-show_frames","-show_entries","stream=codec_type,width,height,avg_frame_rate,nb_read_frames:frame=best_effort_timestamp_time,media_type","-of","json",file]));
  const video = data.streams.find((s: {codec_type:string}) => s.codec_type === "video");
  if (!video) throw new WorkflowError("invalid-video", "视频缺少图像流。");
  const [n,d] = video.avg_frame_rate.split("/").map(Number);
  const pts = data.frames.filter((f: {media_type:string}) => f.media_type === "video").map((f:{best_effort_timestamp_time:string}) => Number(f.best_effort_timestamp_time));
  const info = {width:Number(video.width),height:Number(video.height),frames:Number(video.nb_read_frames),fps:n/d,audio:data.streams.some((s:{codec_type:string}) => s.codec_type === "audio"),pts};
  if (!Number.isSafeInteger(info.frames) || info.frames < 1 || info.frames > 2400 || info.width < 1 || info.height < 1 || info.width * info.height > 4096 ** 2 || !Number.isFinite(info.fps)) throw new WorkflowError("invalid-video", "视频尺寸、帧率或帧数非法。");
  return info;
}
export async function extract(file: string, dir: string, stopped: () => boolean): Promise<string[]> {
  await runTool("ffmpeg", ["-v","error","-y","-i",file,"-fps_mode","passthrough",join(dir,"%06d.png")],stopped);
  return (await readdir(dir)).filter(s => /^\d{6}\.png$/.test(s)).sort().map(s => join(dir,s));
}
export async function encode(dir: string, output: string, stopped: () => boolean): Promise<void> {
  await runTool("ffmpeg", ["-v","error","-y","-framerate","24","-i",join(dir,"%06d.png"),"-an","-c:v","libx264","-crf","16","-pix_fmt","yuv420p",output],stopped);
}
