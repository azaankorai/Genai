import http from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {loadConfig} from './config.mjs';
import {createApp} from './app.mjs';
const config=loadConfig();const app=createApp(config);let stopping=false;
const server=http.createServer(async(req,res)=>{
  try{
    const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);
    const request=new Request(new URL(req.url,config.origin),{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const proxyIP=config.trustProxy?req.headers['x-forwarded-for']?.split(',').at(-1)?.trim():null;
    const response=await app.fetch(request,{ip:proxyIP||req.socket.remoteAddress});
    res.statusCode=response.status;response.headers.forEach((value,key)=>{if(key!=='set-cookie')res.setHeader(key,value)});const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);
    if(response.body)await pipeline(Readable.fromWeb(response.body),res);else res.end();
  }catch(e){if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"Request could not be completed."}')}else res.destroy();console.error('HTTP transport error',e.name);}
});
server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
server.listen(config.port,'0.0.0.0',()=>console.log(`FrameForge listening on port ${config.port}`));
const timer=setInterval(()=>{if(!stopping)void app.tick().catch(e=>console.error('Worker tick failed',e.name))},5000);timer.unref();
function stop(){if(stopping)return;stopping=true;clearInterval(timer);server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),20000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
