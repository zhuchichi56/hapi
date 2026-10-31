import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDispatcher,validateCommand,normalizeReadThread,normalizeSnapshot,normalizeItem,nativeRpc,CodexRuntime,startHost} from './native-host.mjs';
import {EventEmitter,once} from 'node:events';
import {spawn} from 'node:child_process';
test('concurrent host recovery has exactly one listener and releases its OS lock on close',async t=>{
 const dir=await mkdtemp('/tmp/native-lock-');const socketPath=join(dir,'host.sock');
 t.after(()=>rm(dir,{recursive:true,force:true}));
 // SIGKILL leaves a stale Unix pathname, matching the recovery path under review.
 const stale=spawn(process.execPath,['--input-type=module','-e',`import net from 'node:net';net.createServer().listen(${JSON.stringify(socketPath)},()=>console.log('ready'));`],{stdio:['ignore','pipe','inherit']});
 t.after(()=>stale.kill());
 await once(stale.stdout,'data');const exited=once(stale,'exit');stale.kill('SIGKILL');await exited;
 const results=await Promise.allSettled(Array.from({length:3},()=>startHost({socketPath,callerThreadId:'fixture'})));
 const servers=results.filter(result=>result.status==='fulfilled').map(result=>result.value);
 t.after(()=>servers.forEach(server=>server.close()));
 assert.equal(servers.length,1);
 assert.equal(results.filter(result=>result.status==='rejected'&&/already running/.test(result.reason.message)).length,2);
 await new Promise(resolve=>servers[0].close(resolve));
 // Guard release is asynchronous to the server's close event.
 let next;
 for(let i=0;i<30;i++) {try {next=await startHost({socketPath,callerThreadId:'fixture'});break} catch(error){if(!/already running/.test(error.message))throw error;await new Promise(resolve=>setTimeout(resolve,10))}}
 assert.ok(next?.listening);await new Promise(resolve=>next.close(resolve));
});

test('pending and uncertain writes survive dedup cleanup, while reads remain available at capacity',async()=>{
 const originalNow=Date.now;let now=originalNow(),calls=0,resolvePending;
 Date.now=()=>now;
 try {
  const dispatch=createDispatcher({codex:{execute:async command=>{
   if(command.op==='list')return{threads:[]};
   calls++;
   if(command.actionId==='pending')return new Promise(resolve=>{resolvePending=resolve});
   if(command.actionId==='uncertain')throw Object.assign(Error('unknown'),{delivery:'unknown'});
   return{native:true};
  }}});
  const base={app:'codex',op:'send',id:'original',text:'fixture'};
  const pending=dispatch({...base,actionId:'pending'});
  await assert.rejects(dispatch({...base,actionId:'uncertain'}));
  for(let i=0;i<254;i++)await dispatch({...base,actionId:`done-${i}`});
  await assert.rejects(dispatch({...base,actionId:'full'}),error=>error.delivery==='not-sent');
  assert.deepEqual(await dispatch({app:'codex',op:'list'}),{threads:[]});
  now+=120001;
  await dispatch({...base,actionId:'cleanup'});
  const duplicate=dispatch({...base,actionId:'pending'});
  await assert.rejects(dispatch({...base,actionId:'uncertain'}));
  resolvePending({native:true});await Promise.all([pending,duplicate]);
  assert.equal(calls,257);
 } finally {Date.now=originalNow}
});

test('failed model discovery clears the old native pipe for rediscovery',async()=>{
 const runtime=new CodexRuntime({callerThreadId:'fixture'});
 runtime.pipe='/tmp/native-missing-model-fixture.sock';
 await assert.rejects(runtime.models());assert.equal(runtime.pipe,null);
});
test('native command validation and explicit action identity',()=>{
 assert.throws(()=>validateCommand({app:'codex',op:'send',id:'x',text:'hi'}));
 assert.throws(()=>validateCommand({app:'codex',op:'send',id:'../x',text:'hi',actionId:'a'}));
 assert.throws(()=>validateCommand({app:'other',op:'list'}));
 assert.equal(validateCommand({app:'codex',op:'send',id:'abc',text:'hi',actionId:'a'}).op,'send');
});
test('Codex history does not wait for stalled native owner discovery',async()=>{
 const desktop=Object.assign(new EventEmitter(),{clientId:'ready',threads:new Map(),subscribe:()=>new Promise(()=>{})});
 const runtime=new CodexRuntime({callerThreadId:'caller',desktop,callTool:async name=>{assert.equal(name,'read_thread');return{thread:{status:'idle'},turns:[],page:{hasMore:false}}}});
 const result=await Promise.race([runtime.read('original'),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('history blocked on owner')),1500);timer.unref()})]);
 assert.equal(result.id,'original');assert.equal(result.live,false);
});
test('multiple open Codex conversations retain their native subscriptions',async()=>{
 const desktop=Object.assign(new EventEmitter(),{clientId:'ready',threads:new Map(),subscribe:async id=>desktop.threads.set(id,{owner:'native',state:{id,turns:[],threadRuntimeStatus:{type:'idle'}}}),unsubscribe:id=>desktop.threads.delete(id)});
 const runtime=new CodexRuntime({callerThreadId:'caller',desktop});await Promise.all([runtime.read('one'),runtime.read('two')]);
 assert.deepEqual([...desktop.threads.keys()],['one','two']);
});
test('concurrent duplicate writes execute once; altered content rejected',async()=>{
 let calls=0;const dispatch=createDispatcher({codex:{execute:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return{sent:true}}}});
 const cmd={app:'codex',op:'send',id:'abc',text:'hi',actionId:'a'};
 const result=await Promise.all([dispatch(cmd),dispatch({...cmd})]);assert.equal(calls,1);assert.deepEqual(result[0],result[1]);
 await assert.rejects(dispatch({...cmd,text:'different'}),/reused/);
});
test('failed delivery is never automatically replayed',async()=>{
 let calls=0;const dispatch=createDispatcher({codex:{execute:async()=>{calls++;throw Error('lost')}}});
 const cmd={app:'codex',op:'stop',id:'abc',actionId:'b'};
 await assert.rejects(dispatch(cmd));await assert.rejects(dispatch(cmd));assert.equal(calls,1);
 await assert.rejects(dispatch({app:'claude',op:'list'}),/尚未连接/);
});
test('history preserves order and command output without reasoning payloads',()=>{
 assert.equal(normalizeItem({type:'reasoning',id:'opaque',summary:['internal']}),null);
 const result=normalizeReadThread({thread:{status:{type:'idle'}},turns:[{id:'new',items:[{type:'commandExecution',output:{text:'ok'}}]},{id:'old',items:[{type:'userMessage',content:[{text:'hello'}]}]}],page:{hasMore:true}},'abc');
 assert.deepEqual(result.turns.map(t=>t.id),['old','new']);assert.equal(result.turns[1].items[0].output,'ok');assert.equal(result.historyComplete,false);
});
test('RPC uses framed responses and marks disconnected dispatch uncertain',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-host-'));const socket=join(dir,'rpc.sock');let calls=0;
 const server=net.createServer(s=>s.once('data',()=>{calls++;if(calls===1){const b=Buffer.from(JSON.stringify({id:1,jsonrpc:'2.0',result:{ok:true}}));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);s.write(h);setTimeout(()=>s.end(b),5)}else s.destroy()}));
 await new Promise(r=>server.listen(socket,r));
 try{assert.deepEqual(await nativeRpc(socket,'tools/list',{}),{ok:true});await assert.rejects(nativeRpc(socket,'tools/call',{}),e=>e.delivery==='unknown');assert.equal(calls,2)}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
});

test('confirmed native input hides only its null-ID shadow and preserves real repeated messages',()=>{
 const state={id:'original',turns:[
  {turnId:'real-one',items:[{id:'first',type:'userMessage',content:[{text:'Same question'}]}]},
  {turnId:'real-two',items:[{id:'second',type:'userMessage',content:[{text:'Same question'}]}]},
  {turnId:null,params:{input:[{text:'Same question'}]},items:[]}
 ]};
 const result=normalizeSnapshot(state);
 assert.deepEqual(result.turns.map(turn=>turn.id),['real-one','real-two']);
 assert.deepEqual(result.turns.flatMap(turn=>turn.items).map(item=>item.id),['first','second']);
 state.turns[2].params.input[0].text='New pending question';
 assert.equal(normalizeSnapshot(state).turns.at(-1).items[0].text,'New pending question');
});


test('fallback history retains MCP tools and file changes while excluding reasoning', () => {
 const result=normalizeReadThread({turns:[{id:'turn',items:[
  {id:'mcp',type:'mcpToolCall',tool:'read_file',status:'inProgress',result:{content:[{type:'text',text:'read ok'}]}},
  {id:'file',type:'fileChange',changes:[{path:'a.ts',kind:'update'}],status:'completed'},
  {id:'reason',type:'reasoning',text:'private'}]}]},'original');
 assert.deepEqual(result.turns[0].items.map(item=>item.id),['mcp','file']);
 assert.equal(result.turns[0].items[0].status,'inProgress');
 assert.equal(result.turns[0].items[0].output,'read ok');
 assert.match(result.turns[0].items[1].output,/a.ts/);
});

test('oversized fallback history retries only the read with a bounded metadata request',async()=>{
 let calls=0;
 const desktop=Object.assign(new EventEmitter(),{clientId:'ready',threads:new Map(),subscribe:async()=>{}});
 const runtime=new CodexRuntime({callerThreadId:'caller',desktop,callTool:async(name,args)=>{
  calls++; if(calls===1)throw Error('Tool response exceeds the size limit.');
  assert.equal(args.turnLimit,1);assert.equal(args.includeOutputs,false);
  return{thread:{status:'active'},turns:[{id:'native',items:[{id:'tool',type:'mcpToolCall',tool:'Bash',status:'inProgress'}]}]};
 }});
 const result=await runtime.read('original');assert.equal(calls,2);assert.equal(result.turns[0].items[0].role,'tool');
});

test('native archive requires identity/state, invokes the original App and invalidates lists',async()=>{
 assert.throws(()=>validateCommand({app:'codex',op:'archive',id:'original',actionId:'archive'}),/状态/);
 assert.throws(()=>validateCommand({app:'codex',op:'archive',id:'original',archived:true}),/action/);
 const calls=[];const runtime=new CodexRuntime({callerThreadId:'caller',callTool:async(name,args)=>{calls.push({name,args});return{threadId:args.threadId,archived:args.archived}}});
 runtime.lastList={at:Date.now(),value:{threads:[]}};
 const dispatch=createDispatcher({codex:runtime});
 const command={app:'codex',op:'archive',id:'original',archived:true,actionId:'archive'};
 const result=await Promise.all([dispatch(command),dispatch({...command})]);
 assert.equal(calls.length,1);assert.deepEqual(calls[0],{name:'set_thread_archived',args:{threadId:'original',archived:true,source:'codex'}});
 assert.equal(result[0].native,true);assert.equal(runtime.lastList,null);
 await dispatch({...command,archived:false,actionId:'restore'});assert.equal(calls[1].args.archived,false);
});
test('native archived listing uses the original App and returns only local Codex records',async()=>{
 const runtime=new CodexRuntime({callerThreadId:'caller',callTool:async(name,args)=>{
  assert.equal(name,'list_archived_threads');assert.equal(args.cursor,'next');
  return{threads:[{id:'one',kind:'codex',hostId:'local'},{id:'other',kind:'chatgpt'},{id:'remote',kind:'codex',hostId:'elsewhere'}],nextCursor:'more'};
 }});
 const result=await runtime.execute({op:'list',archived:true,cursor:'next'});
 assert.deepEqual(result.threads.map(t=>t.id),['one']);assert.equal(result.threads[0].archived,true);assert.equal(result.nextCursor,'more');
});

test('native pin is validated, deduplicated and confirmed by the original App',async()=>{
 assert.throws(()=>validateCommand({app:'codex',op:'pin',id:'original',actionId:'one'}),/置顶/);
 assert.throws(()=>validateCommand({app:'codex',op:'pin',id:'original',pinned:true}),/action/);
 const calls=[];const runtime=new CodexRuntime({callerThreadId:'caller',callTool:async(name,args)=>{calls.push({name,args});return{threadId:args.threadId,pinned:args.pinned}}});
 runtime.lastList={at:Date.now(),value:{threads:[]}};
 const dispatch=createDispatcher({codex:runtime});const command={app:'codex',op:'pin',id:'original',pinned:true,actionId:'one'};
 const results=await Promise.all([dispatch(command),dispatch({...command})]);
 assert.deepEqual(calls,[{name:'set_thread_pinned',args:{threadId:'original',pinned:true,source:'codex'}}]);
 assert.equal(results[0].native,true);assert.equal(runtime.lastList,null);
 await dispatch({...command,pinned:false,actionId:'two'});assert.equal(calls[1].args.pinned,false);
 const unconfirmed=new CodexRuntime({callerThreadId:'caller',callTool:async()=>({threadId:'original',pinned:false})});
 await assert.rejects(unconfirmed.execute(command),/尚未确认/);
});

test('stop and approvals address the real owner/turn/request, and reject stale requests',async()=>{
 const calls=[];const state={id:'original',turns:[{turnId:'running-turn',status:'inProgress',items:[]}],requests:[{id:'approval',method:'item/commandExecution/requestApproval'}]};
 const desktop=Object.assign(new EventEmitter(),{clientId:'ready',threads:new Map([['original',{owner:'native-owner',state}]]),request:async(...args)=>{calls.push(args);return{resultType:'success'}}});
 const runtime=new CodexRuntime({callerThreadId:'caller',desktop});
 await runtime.execute({op:'stop',id:'original'});
 await runtime.execute({op:'respond',id:'original',requestId:'approval',decision:'decline'});
 assert.deepEqual(calls,[
  ['thread-follower-interrupt-turn',{conversationId:'original',mode:'user-stop',expectedTurnId:'running-turn'},'native-owner'],
  ['thread-follower-command-approval-decision',{conversationId:'original',requestId:'approval',decision:'decline'},'native-owner']
 ]);
 await assert.rejects(runtime.execute({op:'respond',id:'original',requestId:'stale',decision:'accept'}),/已经结束/);
 assert.equal(calls.length,2);
});

test('large images retain exact original-message authorization and bounded size choices',()=>{
 assert.equal(validateCommand({app:'codex',op:'read',id:'native',itemKey:'original-image',imageSrc:'/tmp/chart.png',imageSize:'large'}).imageSize,'large');
 assert.throws(()=>validateCommand({app:'codex',op:'read',id:'native',imageSize:'large'}),/image size/);
 assert.throws(()=>validateCommand({app:'codex',op:'read',id:'native',itemKey:'image',imageSrc:'/tmp/chart.png',imageSize:'original'}),/image size/);
});

test('answers use the original question request and reject an already-resolved request',async()=>{
 const calls=[], response={answers:{choice:{answers:['Keep current']}}};
 const state={id:'original',turns:[],requests:[{id:'question-1',request:{method:'item/tool/requestUserInput',params:{questions:[{id:'choice'}]}}}]};
 const desktop=Object.assign(new EventEmitter(),{clientId:'ready',threads:new Map([['original',{owner:'native-owner',state}]]),request:async(...args)=>{calls.push(args);return{resultType:'success'}}});
 const runtime=new CodexRuntime({callerThreadId:'caller',desktop});
 await runtime.execute({op:'respond',id:'original',requestId:'question-1',response});
 assert.deepEqual(calls,[['thread-follower-submit-user-input',{conversationId:'original',requestId:'question-1',response},'native-owner']]);
 state.requests=[];await assert.rejects(runtime.execute({op:'respond',id:'original',requestId:'question-1',response}),/已经结束/);assert.equal(calls.length,1);
});

test('native model changes preserve effort and target the owner without starting or interrupting a turn',async()=>{
 let settings={model:'gpt-6.1-sol',reasoningEffort:'high'},updates=0;const calls=[];
 const desktop=Object.assign(new EventEmitter(),{clientId:'ready',threads:new Map([['original',{owner:'native-owner',state:{id:'original',turns:[{turnId:'running',status:'inProgress',items:[]}]}}]]),request:async(method,params,owner)=>{
  calls.push({method,params,owner});assert.equal(owner,'native-owner');
  if(method==='thread-follower-read-model-settings')return{result:{settings}};
  assert.equal(method,'thread-follower-update-thread-settings');assert.deepEqual(params.condition,{ifModelEquals:'gpt-6.1-sol',ifEffortEquals:'high'});
  assert.equal(params.activeTurnId,undefined);updates++;settings={model:params.threadSettings.model,reasoningEffort:params.threadSettings.effort};return{result:{applied:true}};
 }});
 const runtime=new CodexRuntime({callerThreadId:'caller',desktop});runtime.models=async()=>({models:[{id:'gpt-6-sol',reasoningEfforts:['medium','high']}]});
 const dispatch=createDispatcher({codex:runtime});const command={app:'codex',op:'set-model',id:'original',model:'gpt-6-sol',actionId:'once'};
 const results=await Promise.all([dispatch(command),dispatch({...command})]);
 assert.equal(updates,1);assert.deepEqual(results[0],{id:'original',model:'gpt-6-sol',reasoningEffort:'high',native:true});
 assert.equal(calls.length,3);assert.deepEqual(calls[1].params.threadSettings,{model:'gpt-6-sol',effort:'high'});
});
test('model changes reject stale or unconfirmed native state, and never retry uncertain writes',async()=>{
 let updates=0,applied=false,fail=false;
 const desktop=Object.assign(new EventEmitter(),{clientId:'ready',threads:new Map([['original',{owner:'owner',state:{id:'original'}}]]),request:async method=>{
  if(method==='thread-follower-read-model-settings')return{result:{settings:{model:'gpt-6.1-sol',reasoningEffort:'high'}}};
  updates++;if(fail)throw Error('connection lost');return{result:{applied}};
 }});
 const runtime=new CodexRuntime({callerThreadId:'caller',desktop});runtime.models=async()=>({models:[{id:'gpt-6-sol',reasoningEfforts:['high']},{id:'medium-only',reasoningEfforts:['medium']}]});
 const command={app:'codex',op:'set-model',id:'original',model:'gpt-6-sol',actionId:'first'};const dispatch=createDispatcher({codex:runtime});
 await assert.rejects(dispatch(command),/已变化/);assert.equal(updates,1);
 applied=true;await assert.rejects(dispatch({...command,actionId:'second'}),/尚未确认/);
 fail=true;await assert.rejects(dispatch({...command,actionId:'uncertain'}),/lost/);await assert.rejects(dispatch({...command,actionId:'uncertain'}),/lost/);assert.equal(updates,3);
 await assert.rejects(dispatch({...command,model:'medium-only',actionId:'incompatible'}),/不支持当前思考强度/);assert.equal(updates,3);
 await assert.rejects(dispatch({...command,model:'unknown',actionId:'unknown'}),/不支持这个模型/);assert.equal(updates,3);
});
test('model control requires an explicit Codex model, thread and write identity',()=>{
 for(const command of [
  {app:'codex',op:'set-model',id:'original',model:'gpt-6-sol'},
  {app:'codex',op:'set-model',id:'original',actionId:'one'},
  {app:'claude',op:'set-model',id:'original',model:'gpt-6-sol',actionId:'one'},
  {app:'codex',op:'model-settings',id:'../wrong'},
  {app:'codex',op:'send',id:'original',text:'Hi',actionId:'one',reasoningEffort:'high'},
 ])assert.throws(()=>validateCommand(command));
 assert.equal(validateCommand({app:'codex',op:'set-model',id:'original',model:'gpt-6-sol',reasoningEffort:'high',actionId:'one'}).model,'gpt-6-sol');
 const result=normalizeSnapshot({id:'original',turns:[],latestModel:'old',latestCollaborationMode:{settings:{model:'gpt-6-sol'}},latestReasoningEffort:'high'});
 assert.deepEqual(result.modelSettings,{model:'gpt-6-sol',reasoningEffort:'high'});
});
