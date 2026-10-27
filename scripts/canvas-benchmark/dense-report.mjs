#!/usr/bin/env node
// Read-only evidence processing. Writes only new dense-conclusions artifacts.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {COMPARISON_KEYS} from './statistics.mjs';
const numeric=x=>typeof x==='number'&&Number.isFinite(x);
const aggregate=values=>{const v=values.filter(numeric).sort((a,b)=>a-b),n=v.length;return n?{median:(v[Math.floor((n-1)/2)]+v[Math.ceil((n-1)/2)])/2,min:v[0],max:v.at(-1),count:n}:null;};
const display=a=>a?`${a.median.toFixed(2)} [${a.min.toFixed(2)}–${a.max.toFixed(2)}]；n=${a.count}`:'未采集 / 无有效运行';
const esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const md=x=>String(x??'—').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','\\|').replace(/[\r\n]+/g,' ');
const ordered=x=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])):x;
const identity=r=>JSON.stringify([ordered(Object.fromEntries(Object.entries(r.cell??{}).filter(([k])=>k!=='round'))),ordered(Object.fromEntries([...COMPARISON_KEYS,'buildId','sampling'].map(k=>[k,r.metadata?.[k]])))]);
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const good=r=>r.included===true&&['completed','success','ok','passed'].includes(r.status)&&!r.errors?.length;
const safeFolder=x=>typeof x==='string'&&x.length&&!/[\/\\]/.test(x)&&x!=='.'&&x!=='..';
/** summary.json controls admission; raw run.json supplies per-run samples and evidence. */
export async function buildDenseReport(root,{historyRoot}={}){
 root=resolve(root);const summary=await read(join(root,'summary.json')),runs=[],failures=[...(summary.exclusions??[])];
 for(const entry of summary.runs??[]){
  if(!safeFolder(entry.folder)){if(!entry.included)failures.push({runId:entry.runId,reason:entry.reason??entry.error??entry.status});continue;}
  try{
   const raw=await read(join(root,entry.folder,'run.json'));
   let manifest=null;try{manifest=await read(join(root,entry.folder,'manifest.json'));}catch{}
   const files=await readdir(join(root,entry.folder));
   runs.push({...raw,folder:entry.folder,included:entry.included===true,manifest,files});
  }catch(error){failures.push({folder:entry.folder,reason:`原始运行不可读：${error.message}`});}
 }
 const replay=summary.replayDiagnostics??[],phaseMap=new Map(),seriesMap=new Map();
 for(const r of runs){
  const key=identity(r);if(!seriesMap.has(key))seriesMap.set(key,{id:`S${seriesMap.size+1}`,cell:r.cell,scenario:r.metadata?.scenario,buildId:r.metadata?.buildId,runs:[]});seriesMap.get(key).runs.push(r);
  for(const p of r.phases??[]){
   const pk=key+'\n'+p.name;if(!phaseMap.has(pk))phaseMap.set(pk,{series:seriesMap.get(key).id,phase:p.name,cell:r.cell,attempts:0,accepted:[],rejected:[]});const bucket=phaseMap.get(pk);bucket.attempts++;
   const admitted=(summary.groups??[]).some(g=>g.phase===p.name&&g.provenance?.includes(r.folder));
   const rejectedReplay=replay.some(d=>d.folder===r.folder&&d.phase===p.name&&d.quality==='replay-invalid');
   if(good(r)&&admitted&&!rejectedReplay&&!p.failure&&(!p.quality||p.quality==='valid')&&!(p.dropped>0))bucket.accepted.push({r,p});
   else bucket.rejected.push(r.folder);
  }
 }
 const phases=[...phaseMap.values()].map(({accepted,...b})=>({...b,validRuns:accepted.length,provenance:accepted.map(x=>x.r.folder),metrics:{renderP95:aggregate(accepted.map(x=>x.p.renderInterval?.p95)),renderP50:aggregate(accepted.map(x=>x.p.renderInterval?.p50)),renderMax:aggregate(accepted.map(x=>x.p.renderInterval?.max)),scheduleHz:aggregate(accepted.map(x=>x.p.completedFps)),handlerP95:aggregate(accepted.map(x=>x.p.handler?.p95)),pointerup:aggregate(accepted.map(x=>x.p.handlersByType?.pointerup?.p95)),inputAck:aggregate(accepted.map(x=>x.p.inputToObservedApplied?.p95))}}));
 const locates=[];
 for(const series of seriesMap.values())for(const visit of ['first','return']){
  const samples=series.runs.filter(good).map(r=>{const events=(r.locates??[]).filter((l,i)=>visit==='first'?i===0:i>0).filter(l=>!l.status||['ok','completed','success','passed'].includes(l.status));return {folder:r.folder,interactive:aggregate(events.map(l=>l.interactiveMs))?.median,arrived:aggregate(events.map(l=>l.arrivedMs))?.median,media:aggregate(events.map(l=>l.mediaReadyMs))?.median};});
  if(samples.some(s=>numeric(s.interactive)||numeric(s.arrived)||numeric(s.media)))locates.push({series:series.id,visit,interactive:aggregate(samples.map(s=>s.interactive)),arrived:aggregate(samples.map(s=>s.arrived)),media:aggregate(samples.map(s=>s.media)),provenance:samples.filter(s=>numeric(s.interactive)||numeric(s.arrived)||numeric(s.media)).map(s=>s.folder)});
 }
 const series=[...seriesMap.values()].map(s=>{
  const accepted=s.runs.filter(good),overview=accepted.map(r=>r.ready??r.phases?.find(p=>p.name==='idle')?.before),detail=accepted.map(r=>r.phases?.find(p=>p.name==='details-idle')?.after);
  return {id:s.id,cell:s.cell,scenario:s.scenario,buildId:s.buildId,attempts:s.runs.length,validRuns:accepted.length,totalEdges:aggregate(accepted.map(r=>r.ready?.canonicalEdgeTotal??r.ready?.edgeTotal??r.manifest?.E??(numeric(r.manifest?.N)&&numeric(r.manifest?.edgesPerNode)?r.manifest.N*r.manifest.edgesPerNode:null))),overviewVisible:aggregate(overview.map(x=>x?.visibleCount)),overviewFull:aggregate(overview.map(x=>x?.fullyVisibleCount)),detailVisible:aggregate(detail.map(x=>x?.visibleCount)),edgesBothVisible:aggregate(overview.map(x=>x?.edgesBothEndpointsVisible)),edgesAnyVisible:aggregate(overview.map(x=>x?.edgesAtLeastOneEndpointVisible)),provenance:s.runs.map(r=>r.folder)};
 });
 const acknowledgements=runs.filter(good).flatMap(r=>(r.phases??[]).filter(p=>p.verification||p.handlersByType?.pointerup).map(p=>({series:seriesMap.get(identity(r)).id,folder:r.folder,phase:p.name,pointerupP95:p.handlersByType?.pointerup?.p95??null,canonicalAckMs:p.verification?.releaseToObservedMs??null,verificationWaitMs:p.verification?.verificationWaitMs??null,status:p.verification?.status??'未采集',replayInvalid:replay.some(d=>d.folder===r.folder&&d.phase===p.name&&d.quality==='replay-invalid')})));
 const screenshots=runs.map(r=>({folder:r.folder,status:r.status,images:[['overview.png','总览'],['details.png','细节'],['roundtrip-overview.png','缩放往返后总览']].filter(([name])=>r.files.includes(name)).map(([file,label])=>({file,label,url:`${encodeURIComponent(r.folder)}/${encodeURIComponent(file)}`}))}));
 const data={generatedAt:new Date().toISOString(),sourceSummary:'summary.json',sourceGeneratedAt:summary.generatedAt,manifest:summary.manifest,series,phases,locates,acknowledgements,replay,failures,screenshots};
 const sections=[],html=[];
 function section(title,text,columns=[],rows=[]){
  sections.push(`## ${title}\n\n${text}\n`);html.push(`<section><h2>${esc(title)}</h2><p>${esc(text)}</p>`);
  if(columns.length){sections.push('| '+columns.map(md).join(' | ')+' |\n| '+columns.map(()=>'---').join(' | ')+' |\n'+rows.map(row=>'| '+row.map(md).join(' | ')+' |').join('\n')+'\n');html.push(`<div class="table"><table><thead><tr>${columns.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);}html.push('</section>');
 }
 const valid=runs.filter(good).length,invalidReplay=replay.filter(r=>r.quality==='replay-invalid').length;
 section('结论与适用范围',`已读取 ${runs.length} 份原始运行，有效运行 ${valid} 份；发现 ${invalidReplay} 个 replay-invalid 阶段。下表只对通过主报告门禁的独立运行取中位数、最小–最大和有效次数；失败运行与无效回放不进入吞吐/间隔汇总，不合并跨运行帧。阶段间结果独立，不能用 idle 代替拖动或缩放。该报告属于密集连接图批次，不与旧 official 纯节点批次混合。`);
 section('指标怎么读','调度完成频率（Hz）是 Bevy Render PostCleanup 调度完成次数，不是 GPU 呈现帧率。调度间隔、浏览器 RAF 观察已应用、pointerup 处理耗时与规范状态确认是不同指标；不能相加，也不能互相替代。表中 p95 列是各独立运行 p95 的中位数，范围为这些运行 p95 的最小–最大，不是池化全部帧后的 p95。其他列同样先取每次运行对应的标量，再汇总。数值均为 ms，频率列单独标注 Hz。缺失不作零。p99 与 GPU 时间不在本报告推断。');
 section('密度与实际可见工作集','N 为规范节点总数，V 为设计总览工作集；E 为规范边总数，e 为每节点生成出边数。边可见计数按端点矩形相交计算，不是贝塞尔曲线像素可见性。细节放大后只显示工作集的 subset（子集），不能据此声称同样数量节点在细节级同时可读。',['单元','N / V / e','E 总数','总览可见 / 完全可见','细节可见子集','边：双端可见 / 任一端可见','有效/运行'],series.map(s=>[s.id,`${s.cell?.nodes} / ${s.cell?.visible} / ${s.cell?.edges??0}`,display(s.totalEdges),`${display(s.overviewVisible)} / ${display(s.overviewFull)}`,display(s.detailVisible),`${display(s.edgesBothVisible)} / ${display(s.edgesAnyVisible)}`,`${s.validRuns}/${s.attempts}`]));
 section('各阶段独立运行结果','每个单元按 scenario 与 buildId 分组，避免混合不同输入节奏、视口或构建。某阶段有效次数为零表示不能得出受控吞吐结论。',['单元','阶段','有效/出现','调度间隔 p50','调度间隔 p95','单运行最大间隔','调度完成频率 Hz','处理耗时 p95','输入至 RAF 观察已应用 p95'],phases.map(p=>[p.series,p.phase,`${p.validRuns}/${p.attempts}`,display(p.metrics.renderP50),display(p.metrics.renderP95),display(p.metrics.renderMax),display(p.metrics.scheduleHz),display(p.metrics.handlerP95),display(p.metrics.inputAck)]));
 section('回放缺失与不可用吞吐','replay-invalid 指实际事件数或迟到超出预设容差。原始数值仍保留供诊断，但不作为受控轨迹吞吐；不能把回放不足直接归因为产品失败。缺失率为 (expected − scheduled) / expected，最小为零。',['运行 / 阶段','质量','已发 / 预期','缺失 %','迟到 p95 ms','原因'],replay.map(r=>[`${r.folder??r.runId} / ${r.phase}`,r.quality,`${r.scheduledEvents??'—'} / ${r.expectedEvents??'—'}`,numeric(r.missingFraction)?(r.missingFraction*100).toFixed(2):numeric(r.scheduledEvents)&&r.expectedEvents>0?(Math.max(0,1-r.scheduledEvents/r.expectedEvents)*100).toFixed(2):'未采集',r.lateP95Ms??'未采集',(r.problems??[]).join('；')]));
 section('pointerup 与规范状态确认','按有效运行逐条列出。规范状态确认是释放后观察到 canonical 回写的上界，独立于连续输入阶段；回放无效时这些值仅作诊断，不并入受控吞吐。',['单元 / 运行','阶段','pointerup p95','释放至确认 ms','校验等待 ms','校验状态','回放无效'],acknowledgements.map(a=>[`${a.series} / ${a.folder}`,a.phase,a.pointerupP95??'未采集',a.canonicalAckMs??'未采集',a.verificationWaitMs??'未采集',a.status,a.replayInvalid?'是（仅诊断）':'否']));
 section('定位：首次观测与后续回访','first 是本运行定位序列的第一次观测，不等于资源冷启动；return 先在每次运行内取中位数，再跨独立运行汇总。缓存驻留与驱逐状态未验证，不能把 return 直接标为热缓存。到达/交互时间是浏览器 RAF 与运行时调度代次的观察，不是 GPU 呈现计时。',['单元','访问类别','到达 ms','可交互 ms','媒体就绪 ms'],locates.map(l=>[l.series,l.visit==='first'?'首次观测':'后续回访（缓存未验证）',display(l.arrived),display(l.interactive),display(l.media)]));
 section('可读性与 LOD 边界','普通文本已有字体栅格分辨率 LOD：text_presentation.rs 使用 1/2/4/8/12 档位，升级立即生效，降档需低于下一较低档的 85%，带迟滞以减少反复切换。这调整文字栅格化分辨率，不等于按缩放省略正文或简化卡片内容的内容 LOD；本次文本卡片没有后一种内容省略机制。总览、细节、往返截图只能支持实际画面检查，缩略图与调度频率都不能证明文字可读性。');
 section('失败与排除清单','保留主 summary.json 全部排除证据；包含阶段回放无效以及运行失败，不将它们混入均值。',['运行','阶段','原因'],failures.map(f=>[f.folder??f.runId??'execution.json',f.phase??'整次运行',f.reason??f.error??f.status??JSON.stringify(f)]));
 section('实验身份','以下信息用于核对同一批次，编号相同才可在阶段表间对应。',['单元','scenario','buildId'],series.map(s=>[s.id,s.scenario??'缺失',s.buildId??'缺失']));
 if(historyRoot){
  const h=await read(join(resolve(historyRoot),'summary.json'));data.history={root:relative(root,resolve(historyRoot)),runCount:h.runs?.length??0};
  section('历史对照：旧纯节点批次（分开展示）','以下为独立历史队列，V、E、输入轨迹与构建可能不同，不计算跨队列提升比例，不与当前密集连接图合并。',['历史 N / V / e','阶段','调度间隔 p95','有效次数'],(h.groups??[]).map(g=>[`${g.cell?.nodes} / ${g.cell?.visible} / ${g.cell?.edges??0}`,g.phase,display(g.metrics?.renderP95),g.runCount]));
 }else section('历史对照','未指定 --history。旧 official 纯节点数据保留为独立历史批次，本报告没有导入或合并。');
 const imageMd=screenshots.map(r=>`- ${md(r.folder)}（${md(r.status)}）：${r.images.map(i=>`[${i.label}](${i.url})`).join(' · ')} · [原始运行](${encodeURIComponent(r.folder)}/run.json)`).join('\n');
 sections.push('## 画面与原始证据\n\n'+imageMd+'\n\n[主汇总](summary.json) · [独立报告数据](dense-conclusions.json)\n');
 html.push(`<section><h2>画面与原始证据</h2><ul>${screenshots.map(r=>`<li>${esc(r.folder)}（${esc(r.status)}）：${r.images.map(i=>`<a href="${esc(i.url)}">${esc(i.label)}</a>`).join(' · ')} · <a href="${encodeURIComponent(r.folder)}/run.json">原始运行</a></li>`).join('')}</ul><a href="summary.json">主汇总</a> · <a href="dense-conclusions.json">独立报告数据</a></section>`);
 await writeFile(join(root,'dense-conclusions.json'),JSON.stringify(data,null,2)+'\n');
 await writeFile(join(root,'dense-conclusions.md'),'# 密集连接图：测量结论\n\n'+sections.join('\n'));
 await writeFile(join(root,'dense-conclusions.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>密集连接图：测量结论</title><style>body{font:15px/1.65 system-ui;color:#233344;background:#f5f7f9;max-width:1440px;margin:32px auto;padding:0 24px}section{background:white;padding:20px;margin:20px 0;border:1px solid #dce2e9;border-radius:8px}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:9px;border-bottom:1px solid #e4e8ed;text-align:left;vertical-align:top}th{background:#edf3f6}td{min-width:75px;max-width:450px;overflow-wrap:anywhere}a{color:#096b88}h1{font-size:30px}h2{font-size:21px}</style><h1>密集连接图：测量结论</h1>'+html.join('')+'</html>');
 return data;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [root,...args]=process.argv.slice(2);if(!root||(args.length&&!(args.length===2&&args[0]==='--history')))throw new Error('Usage: node dense-report.mjs ROOT [--history OLD_ROOT]');
 const report=await buildDenseReport(root,{historyRoot:args[1]});console.log(`已生成 ${resolve(root,'dense-conclusions.html')}；${report.series.length} 个单元，${report.phases.length} 个阶段组。`);
}
