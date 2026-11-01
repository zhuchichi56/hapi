// Read-only DOM benchmark on one explicitly owned, already authenticated CDP tab.
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: { cdp: {type:'string'}, url: {type:'string'}, output: {type:'string'}, baseline: {type:'string'}, repeats: {type:'string', default:'3'} } });
const endpoint = new URL(values.cdp);
const target = new URL(values.url);
const repeats = Number(values.repeats);
if (!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname) || target.pathname !== '/desktop' || !Number.isInteger(repeats) || repeats < 3 || repeats > 10 || !values.output) throw Error('Require owned loopback CDP, exact /desktop URL, output, and 3–10 repeats');
const pages = await (await fetch(`http://${endpoint.host}/json/list`)).json();
const page = pages.find(row => row.type === 'page' && row.url === target.href);
if (!page) throw Error('Exact owned tab must already be open and authenticated');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok,no) => { ws.addEventListener('open',ok,{once:true}); ws.addEventListener('error',no,{once:true}); });
let sequence = 0;
const pending = new Map(), api = new Map();
ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), item = pending.get(message.id), p = message.params;
    if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error('CDP operation failed')) : item.resolve(message.result); }
    if (message.method === 'Network.requestWillBeSent' && p.request.url.endsWith('/api/native-desktop/command')) {
        let command; try { command = JSON.parse(p.request.postData); } catch { return; }
        // Never retain postData, URL query, headers, response body or text.
        api.set(p.requestId, {op:command.op, history:command.op === 'read' && !command.itemKey && !command.before, start:p.timestamp});
    }
    if (message.method === 'Network.responseReceived' && api.has(p.requestId)) api.get(p.requestId).status = p.response.status;
    if (['Network.loadingFinished','Network.loadingFailed'].includes(message.method) && api.has(p.requestId)) Object.assign(api.get(p.requestId), {end:p.timestamp, failed:message.method === 'Network.loadingFailed'});
});
const call = (method, params = {}) => new Promise((resolve,reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout')); }, 30000);
    pending.set(id,{resolve,reject,timer}); ws.send(JSON.stringify({id,method,params}));
});
const evaluate = async expression => {
    const result = await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if (result.exceptionDetails) throw Error('Browser measurement failed');
    return result.result.value;
};
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const stats = values => {
    const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
    const mean=sorted.reduce((a,b)=>a+b,0)/sorted.length;
    return sorted.length ? {n:sorted.length,median:sorted.length % 2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2,p95:sorted[Math.ceil(sorted.length*.95)-1],mean,sampleStd:sorted.length>1?Math.sqrt(sorted.reduce((sum,n)=>sum+(n-mean)**2,0)/(sorted.length-1)):null} : null;
};
const source = `window.__hapiBench={readable:null,longTasks:[],cls:0,lcp:null};
new PerformanceObserver(list=>{for(const e of list.getEntries())window.__hapiBench.longTasks.push(e.duration)}).observe({type:'longtask',buffered:true});
new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.__hapiBench.cls+=e.value}).observe({type:'layout-shift',buffered:true});
new PerformanceObserver(list=>{for(const e of list.getEntries())window.__hapiBench.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true});
new MutationObserver(()=>{if(!window.__hapiBench.readable&&document.querySelector('.nd-message-body'))requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__hapiBench.readable??=performance.now()}))}).observe(document,{childList:true,subtree:true});`;
const results = [];
let injected;
try {
    if (!await evaluate("!!document.querySelector('.nd-root')")) throw Error('Authenticate the owned page before measuring');
    await call('Page.enable'); await call('Network.enable');
    await call('Network.setBypassServiceWorker',{bypass:true});
    injected = await call('Page.addScriptToEvaluateOnNewDocument',{source});
    for (const profile of [{name:'normal',latency:0,cpu:1},{name:'constrained',latency:200,cpu:4}]) {
        await call('Network.emulateNetworkConditions',{offline:false,latency:profile.latency,downloadThroughput:profile.latency ? 512000 : -1,uploadThroughput:profile.latency ? 256000 : -1});
        await call('Emulation.setCPUThrottlingRate',{rate:profile.cpu});
        for (let run = 1; run <= repeats; run++) for (const cache of ['cold','warm']) {
            const before = await evaluate('performance.timeOrigin');
            if (cache === 'cold') await call('Network.clearBrowserCache');
            api.clear();
            await call('Page.reload',{ignoreCache:cache === 'cold'});
            const start = Date.now(); let readable = false;
            while (Date.now()-start < 25000) {
                readable = await evaluate(`performance.timeOrigin!==${before} && !!window.__hapiBench?.readable`);
                if (readable) break;
                await wait(100);
            }
            if (readable) await wait(1000);
            const metrics = await evaluate(`(()=>{const b=window.__hapiBench;return {readableMs:b?.readable??null,fcpMs:performance.getEntriesByName('first-contentful-paint')[0]?.startTime??null,lcpMs:b?.lcp??null,cls:b?.cls??null,longTasks:b?.longTasks??[],heapUsedBytes:performance.memory?.usedJSHeapSize??null,domNodes:document.getElementsByTagName('*').length,overflow:document.documentElement.scrollWidth>innerWidth,alerts:document.querySelectorAll('.nd-error,.nd-inline-error').length,assets:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.startsWith('/assets/')).map(e=>({path:new URL(e.name).pathname,transferBytes:e.transferSize,encodedBytes:e.encodedBodySize})),messages:document.querySelectorAll('.nd-message-body').length}})()`);
            // Interaction proxy only: two painted frames after opening the menu.
            // It is explicitly not field INP; no setting is changed.
            metrics.menuPaintMs = readable ? await evaluate(`(async()=>{const b=document.querySelector('.nd-model-trigger');if(!b||b.disabled)return null;const t=performance.now();b.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const elapsed=document.querySelector('.nd-model-menu')?performance.now()-t:null;document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return elapsed})()`) : null;
            const requests = [...api.values()];
            const row = {profile:profile.name,run,cache,...metrics,requests:requests.map(r=>({op:r.op,status:r.status??null,failed:r.failed??false,completed:!!r.end,elapsedMs:r.end ? (r.end-r.start)*1000 : null})),passed:readable && metrics.alerts===0 && !metrics.overflow && metrics.cls!==null && metrics.cls<=.1 && metrics.readableMs<=5000 && (target.searchParams.get('app')!=='codex' || Number.isFinite(metrics.menuPaintMs)) && !requests.some(r=>r.failed || r.status>=400)};
            results.push(row); console.log(JSON.stringify({profile:row.profile,run,cache,readableMs:row.readableMs,menuPaintMs:row.menuPaintMs,passed:row.passed}));
        }
    }
    // Observe normal polling for a bounded window without submitting messages.
    await call('Emulation.setCPUThrottlingRate',{rate:1});
    await call('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    api.clear(); await wait(10000);
    const reads = [...api.values()].filter(r=>r.history).sort((a,b)=>a.start-b.start);
    const edges = reads.flatMap(r=>[{at:r.start,delta:1},...(r.end ? [{at:r.end,delta:-1}] : [])]).sort((a,b)=>a.at-b.at||a.delta-b.delta);
    let active=0, maxInFlight=0;
    for (const edge of edges) { active+=edge.delta; maxInFlight=Math.max(maxInFlight,active); }
    const cadence = {observedMs:10000,started:reads.length,completed:reads.filter(r=>r.end).length,failed:reads.filter(r=>r.failed || r.status>=400).length,maxInFlight,spacingMs:reads.slice(1).map((r,i)=>(r.start-reads[i].start)*1000)};
    const aggregates = [];
    for(const profile of ['normal','constrained']) for(const cache of ['cold','warm']) {
        const rows=results.filter(r=>r.profile===profile&&r.cache===cache);
        aggregates.push({profile,cache,readableMs:stats(rows.map(r=>r.readableMs)),menuPaintMs:stats(rows.map(r=>r.menuPaintMs)),passed:rows.length===repeats&&rows.every(r=>r.passed)});
    }
    const result={protocol:1,at:new Date().toISOString(),targetSHA256:createHash('sha256').update(target.href).digest('hex'),conditions:{repeats,viewport:await evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'),userAgent:await evaluate('navigator.userAgent'),profiles:'normal or 200ms/512000Bps/4xCPU',bypassServiceWorker:true,note:'Authenticated navigation; no login latency. Lab LCP and menu paint are not field p75 or INP.'},aggregates,cadence,passed:aggregates.every(r=>r.passed)&&cadence.completed>0&&cadence.failed===0&&cadence.maxInFlight===1,results};
    result.regressions=[];
    if(values.baseline){
        const baseline=JSON.parse(await readFile(values.baseline,'utf8'));
        if(baseline.protocol!==result.protocol||baseline.targetSHA256!==result.targetSHA256||JSON.stringify(baseline.conditions)!==JSON.stringify(result.conditions))throw Error('Baseline conditions differ');
        for(const before of baseline.aggregates){
            const after=aggregates.find(r=>r.profile===before.profile&&r.cache===before.cache);
            if(!after?.passed||!before.readableMs||after.readableMs.median>Math.max(before.readableMs.median*1.2,before.readableMs.median+100))result.regressions.push({profile:before.profile,cache:before.cache});
        }
        result.passed&&=result.regressions.length===0;
    }
    await writeFile(values.output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
    process.exitCode=result.passed?0:2;
} finally {
    if(injected) await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:injected.identifier}).catch(()=>{});
    await call('Emulation.setCPUThrottlingRate',{rate:1}).catch(()=>{});
    await call('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1}).catch(()=>{});
    await call('Network.setBypassServiceWorker',{bypass:false}).catch(()=>{});
    for(const job of pending.values()){clearTimeout(job.timer);job.reject(Error('CDP closed'));}
    ws.close();
}
