import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDispatcher,validateCommand,normalizeReadThread,normalizeSnapshot,normalizeItem,nativeRpc,CodexRuntime} from './native-host.mjs';
import {EventEmitter} from 'node:events';
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
