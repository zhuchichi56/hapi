// Supplemental read-only UI checks: responsive images, menu fit, scroll frames.
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
const {values} = parseArgs({options:{cdp:{type:'string'},url:{type:'string'},output:{type:'string'}}});
const endpoint=new URL(values.cdp);
if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||!values.output)throw Error('Explicit owned loopback CDP and output required');
const pages=await(await fetch(`http://${endpoint.host}/json/list`)).json();
const page=pages.find(p=>p.type==='page'&&p.url===new URL(values.url).href);
if(!page)throw Error('Exact owned tab missing');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok,no)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true})});
let id=0;const jobs=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=jobs.get(m.id);if(p){clearTimeout(p.timer);jobs.delete(m.id);m.error?p.reject(Error('CDP failed')):p.resolve(m.result)}});
const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{jobs.delete(key);reject(Error('CDP timeout'))},15000);jobs.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}))});
const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('UI check failed');return r.result.value};
const responsive=[];
try{
 if(!await ev("!!document.querySelector('.nd-root')"))throw Error('Authenticated page required');
 for(const width of [1440,390,320]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});
  await new Promise(r=>setTimeout(r,500));
  const row=await ev(`(async()=>{const t=document.querySelector('.nd-model-trigger');if(t&&!t.disabled)t.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const m=document.querySelector('.nd-model-menu')?.getBoundingClientRect();const images=Array.from(document.querySelectorAll('.nd-image img')).map(i=>({width:i.getBoundingClientRect().width,height:i.getBoundingClientRect().height,loaded:i.complete&&i.naturalWidth>0}));const result={width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,images,menuVisible:!!m,menuFits:!!m&&m.left>=0&&m.right<=innerWidth&&m.top>=0&&m.bottom<=innerHeight,alerts:document.querySelectorAll('.nd-error,.nd-inline-error').length};document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return result})()`);
  responsive.push({...row,passed:!row.overflow&&row.menuVisible&&row.menuFits&&row.alerts===0&&row.images.every(i=>i.loaded&&i.width<=180.5)});
 }
 await call('Emulation.clearDeviceMetricsOverride');
 const scroll=await ev(`(async()=>{const el=document.querySelector('.nd-scroll');if(!el)return {available:false};const old=el.scrollTop,max=el.scrollHeight-el.clientHeight,frames=[];let last=performance.now();for(let i=0;i<60;i++){await new Promise(r=>requestAnimationFrame(r));const now=performance.now();frames.push(now-last);last=now;el.scrollTop=max*(i%20)/19}el.scrollTop=old;frames.sort((a,b)=>a-b);return {available:true,scrollable:max>0,frames:frames.length,p95FrameGapMs:frames[Math.ceil(frames.length*.95)-1],maxFrameGapMs:frames.at(-1),note:'Synthetic scroll-frame probe, not hardware FPS or field INP'}})()`);
 const result={protocol:1,at:new Date().toISOString(),responsive,scroll,passed:responsive.every(r=>r.passed)&&scroll.available};
 await writeFile(values.output,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
 process.exitCode=result.passed?0:2;
}finally{await call('Emulation.clearDeviceMetricsOverride').catch(()=>{});ws.close()}
