import http from 'node:http';
import { createStaticHandler, send } from './static-server.mjs';
import { applyHostHttpTiming } from './host-http-timing.mjs';
import { injectReleaseLinkHtml } from './extension-release-catalog.mjs';

/** 把宿主实际监听端口写回 env，供本机 Agent MCP 回环地址使用。 */
export function publishDesktopLoopbackPort(port, targets = [process.env]) {
  const value = String(port);
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) {
    throw new Error(`非法回环端口：${port}`);
  }
  for (const target of targets) {
    if (!target) continue;
    target.PORT = value;
    target.BACKEND_PORT = value;
  }
}

export async function startDesktopServer({ backend, frontendDir, instance, extensionHost=null, port=0, devOrigin=null, env=null }) {
 const readiness=await (backend.modules ? backend.modules().canvas.readiness() : backend.readiness());
 if(!readiness.ready){await backend.close();throw new Error(`宿主未就绪：${readiness.reason??'unknown'}`);}
 devOrigin=devOrigin?new URL(devOrigin).origin:null;
 let stopping=false;const sockets=new Set();let origin;
 const serveStatic=createStaticHandler(frontendDir,{...(extensionHost?.browserRelease?.href?{transformHtml:html=>injectReleaseLinkHtml(html,extensionHost.browserRelease.href)}:{})});
 const permitted=(req)=>{
  const host=req.headers.host;
  return host===new URL(origin).host && (!req.headers.origin || req.headers.origin===origin || req.headers.origin===devOrigin);
 };
 const server=applyHostHttpTiming(http.createServer((req,res)=>{
  if(stopping){send(res,503,'宿主正在退出');return;}
  if(!permitted(req)){send(res,403,'origin rejected');return;}
  if(req.url==='/health/ready'){send(res,200,JSON.stringify({status:'ready'}),'application/json');return;}
  if(extensionHost?.handleReleaseRequest?.(req,res))return;
  Promise.resolve(backend.handle(req,res)).then(handled=>{if(!handled)serveStatic(req,res);}).catch(error=>{process.stderr.write(`[desktop-host] request failed: ${error.message}\n`);if(!res.headersSent)send(res,500,'请求失败');else res.end();});
 }));
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 server.on('upgrade',(req,socket,head)=>{if(stopping||!permitted(req)||!backend.upgrade?.(req,socket,head))socket.destroy();});
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
 catch(error){await backend.close();throw error;}
 origin=`http://127.0.0.1:${server.address().port}`;
 publishDesktopLoopbackPort(server.address().port, [process.env, env]);
 let closing;
 return {ready:{type:'ready',protocol:1,instance,origin,pid:process.pid},close(){
  if(closing)return closing;stopping=true;
  closing=(async()=>{
   const serverClosed=new Promise(resolve=>server.close(resolve));
   try{
    const task=backend.modules?.().task;
    if(task){
     // Persist cancellation before worker shutdown; application exit must not resume queued work.
     const seen=new Set();
     for(;;){const pending=task.history().listUnsettled(1000).filter(record=>!seen.has(record.taskKey));if(!pending.length)break;
      for(const record of pending){seen.add(record.taskKey);await task.port().cancel(record.taskKey);}
     }
    }
   }finally{await backend.close();for(const socket of sockets)socket.destroy();await serverClosed;}
  })();return closing;
 }};
}
