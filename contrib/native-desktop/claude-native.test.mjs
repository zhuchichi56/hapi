import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ClaudeNative, normalizeClaudeTranscript, transcriptStatus} from './claude-native.mjs';
test('closed helper stdin cannot crash the host; the next inspection gets a fresh helper', async t => {
 const root = await mkdtemp('/tmp/claude-pipe-');
 const helper = `${root}/helper`;
 await writeFile(helper, `#!${process.execPath}\nimport {closeSync} from 'node:fs';\ncloseSync(0);process.stdout.write('{"ok":true}\\n');setTimeout(()=>{},10000);`, {mode:0o700});
 const runtime = new ClaudeNative({helper});
 t.after(async()=>{runtime.child?.kill();await rm(root,{recursive:true,force:true})});
 assert.equal((await runtime.ax({op:'inspect'})).ok,true);
 const old = runtime.child;
 await assert.rejects(runtime.ax({op:'send',text:'fixture'}), error => error.delivery === 'unknown');
 assert.equal(runtime.lastView,null);
 await writeFile(helper, `#!${process.execPath}\nimport readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',()=>process.stdout.write('{"ok":true,"selectedId":"recovered"}\\n'));`, {mode:0o700});
 assert.equal((await runtime.ax({op:'inspect'})).selectedId,'recovered');
 assert.notEqual(runtime.child,old);
});
test('Claude desktop history uses transcript messages and omits wire/context blobs',()=>{
 const result=normalizeClaudeTranscript([
  {type:'api-request-blob',message:{role:'user',content:'hidden context'}},
  {type:'user',uuid:'1',message:{role:'user',content:'hello'}},
  {type:'assistant',uuid:'2',message:{role:'assistant',content:[{type:'thinking',thinking:'private'},{type:'text',text:'reply'},{type:'tool_use',id:'t',name:'Bash',input:{command:'pwd'}}]}},
  {type:'user',uuid:'3',message:{role:'user',content:[{type:'tool_result',tool_use_id:'t',content:'/tmp'}]}},
  {type:'user',uuid:'4',isMeta:true,message:{role:'user',content:'meta'}}
 ]);
 assert.deepEqual(result.map(t=>t.id),['1','2','3']);assert.equal(result[1].items[0].text,'reply');assert.equal(result[1].items.length,2);assert.equal(result[2].items[0].output,'/tmp');
});
test('locked Claude desktop keeps history readable and blocks writes before UI navigation', async () => {
 const runtime = new ClaudeNative();
 const operations = [];
 runtime.records = async () => [{id:'local_test',title:'Test'}];
 runtime.lastView = {state:{locked:true,nodes:[],selectedId:''},at:Date.now()};
 runtime.syncState = () => {};
 runtime.ax = async command => { operations.push(command.op); return {locked:true,nodes:[],selectedId:''}; };
 runtime.transcript = async () => ({turns:[{id:'original'}],historyComplete:true});
 const view = await runtime.execute({op:'read',id:'local_test'});
 assert.equal(view.status,'locked'); assert.equal(view.live,false); assert.equal(view.turns[0].id,'original');
 await assert.rejects(runtime.execute({op:'send',id:'local_test',text:'hello'}), /锁屏/);
 assert.deepEqual(operations,['inspect']);
});
test('history is available immediately even while desktop UI inspection is stalled', async()=>{
 const runtime=new ClaudeNative();runtime.records=async()=>[{id:'local_test',title:'Original'}];
 runtime.ax=()=>new Promise(()=>{});runtime.transcript=async()=>({turns:[{id:'native-message'}],historyComplete:true});
 const view=await runtime.execute({op:'read',id:'local_test'});assert.equal(view.turns[0].id,'native-message');assert.equal(view.status,'unknown');
});

test('background Claude completion requires explicit native end-of-turn evidence',()=>{
 const user={type:'user',message:{role:'user',content:'question'}};
 const done={type:'assistant',message:{role:'assistant',stop_reason:'end_turn'}};
 assert.equal(transcriptStatus([user,done]),'idle');
 assert.equal(transcriptStatus([done,user,{type:'api-request'}]),'unknown');
 assert.equal(transcriptStatus([user,{type:'assistant',message:{stop_reason:'tool_use'}}]),'unknown');
 assert.equal(transcriptStatus([user,done,{type:'system',subtype:'stop_hook_summary'}]),'idle');
 assert.equal(transcriptStatus([user,done,{type:'system',subtype:'stop_hook_summary',preventedContinuation:true}]),'unknown');
});

test('native queued human messages stay visible without leaking other attachments',()=>{
 const result=normalizeClaudeTranscript([
  {type:'attachment',uuid:'queued',attachment:{type:'queued_command',prompt:'follow up',humanTurn:true,origin:{kind:'human'},source_uuid:'source'}},
  {type:'attachment',uuid:'internal',attachment:{type:'total_tokens_reminder',text:'internal'}}
 ]);
 assert.equal(result.length,1);assert.equal(result[0].items[0].role,'user');assert.equal(result[0].items[0].text,'follow up');
});

test('Claude archive and restore use original UI and confirm native metadata',async()=>{
 const runtime=new ClaudeNative();const record={id:'local_test',title:'Original',archived:false};const calls=[];
 runtime.records=async()=>[record];runtime.ax=async command=>{
  calls.push(command);if(command.op==='archive')record.archived=command.archived;
  return{selectedId:'local_test',nodes:[{role:'AXButton',title:record.archived?'Unarchive':'Send'}]};
 };
 assert.equal((await runtime.execute({op:'archive',id:'local_test',archived:true})).archived,true);
 assert.equal((await runtime.execute({op:'archive',id:'local_test',archived:false})).archived,false);
 assert.deepEqual(calls.filter(c=>c.op==='archive').map(c=>c.archived),[true,false]);
});

test('running Claude accepts a native queue receipt without stopping or replaying input',async()=>{
 const runtime=new ClaudeNative();const calls=[];let submitted=false;
 runtime.records=async()=>[{id:'local_test',title:'Original'}];
 runtime.ax=async command=>{calls.push(command.op);if(command.op==='send')submitted=true;return{selectedId:'local_test',nodes:[{role:'AXButton',title:'Stop'}]}};
 runtime.transcript=async()=>({turns:[],queueReceipts:submitted?[{id:'fresh',hash:createHash('sha256').update('follow up').digest('hex')}]:[]});
 const result=await runtime.execute({op:'send',id:'local_test',text:'follow up'});
 assert.equal(result.queued,true);assert.equal(result.native,true);
 assert.equal(calls.filter(op=>op==='send').length,1);assert.equal(calls.includes('stop'),false);
});

test('Claude pin and unpin confirm original metadata and do not write when already applied',async()=>{
 const runtime=new ClaudeNative();const record={id:'local_test',title:'Original',pinned:false};const calls=[];
 runtime.records=async()=>[record];runtime.ax=async command=>{
  calls.push(command);if(command.op==='pin')record.pinned=command.pinned;
  return{selectedId:'local_test',nodes:[]};
 };
 assert.equal((await runtime.execute({op:'pin',id:'local_test',pinned:true})).pinned,true);
 assert.equal((await runtime.execute({op:'pin',id:'local_test',pinned:true})).pinned,true);
 assert.equal((await runtime.execute({op:'pin',id:'local_test',pinned:false})).pinned,false);
 assert.deepEqual(calls.filter(c=>c.op==='pin').map(c=>c.pinned),[true,false]);
});

test('Claude stop and approvals use the original session controls and reject stale choices',async()=>{
 const runtime=new ClaudeNative();const calls=[];
 runtime.records=async()=>[{id:'local_test',title:'Original'}];
 runtime.ax=async command=>{calls.push(command);return{selectedId:'local_test',nodes:[{role:'AXButton',title:'Stop'},{role:'AXButton',title:'Allow once'}]}};
 await runtime.execute({op:'stop',id:'local_test'});
 await runtime.execute({op:'respond',id:'local_test',requestId:'native-ui-approval',button:'Allow once'});
 assert.equal(calls.filter(c=>c.op==='stop').length,1);assert.equal(calls.filter(c=>c.op==='respond').length,1);
 await assert.rejects(runtime.execute({op:'respond',id:'local_test',requestId:'native-ui-approval',button:'Accept other'}),/已变化/);
 assert.equal(calls.filter(c=>c.op==='respond').length,1);
});

test('Claude list polling inspects existing state without selecting or opening another session',async()=>{
 const runtime=new ClaudeNative();const calls=[];
 runtime.records=async()=>[{id:'local_open',title:'Open'},{id:'local_other',title:'Other'}];
 runtime.lastView={state:{selectedId:'local_open',locked:false,nodes:[{role:'AXButton',title:'Stop'},{role:'AXButton',title:'Allow once'}]},at:Date.now()};
 runtime.ax=async command=>{calls.push(command);throw Error('unexpected '+command.op)};
 runtime.transcript=async()=>({turns:[{id:'native-history'}],status:'idle',historyComplete:true});
 const view=await runtime.execute({op:'list'});
 assert.deepEqual(calls,[]);
 assert.deepEqual(view.threads.map(thread=>[thread.id,thread.status]),[['local_open','active'],['local_other','idle']]);
});

test('Claude read of a different session never opens or selects it and is not live',async()=>{
 const runtime=new ClaudeNative();const calls=[];
 runtime.records=async()=>[{id:'local_open',title:'Open'},{id:'local_other',title:'Other'}];
 runtime.lastView={state:{selectedId:'local_open',locked:false,nodes:[{role:'AXButton',title:'Stop'},{role:'AXButton',title:'Allow once'}]},at:Date.now()};
 runtime.ax=async command=>{calls.push(command);throw Error('unexpected '+command.op)};
 runtime.transcript=async()=>({turns:[{id:'native-history'}],status:'idle',historyComplete:true});
 const view=await runtime.execute({op:'read',id:'local_other'});
 assert.deepEqual(calls,[]);
 assert.equal(view.turns[0].id,'native-history');
 assert.equal(view.status,'idle');assert.equal(view.live,false);assert.deepEqual(view.requests,[]);
});

test('Claude list and read with unloaded UI stay passive',async()=>{
 const runtime=new ClaudeNative();const calls=[];
 runtime.records=async()=>[{id:'local_other',title:'Other'}];
 runtime.lastView={state:{selectedId:'',locked:false,nodes:[]},at:Date.now()};
 runtime.ax=async command=>{calls.push(command);throw Error('unexpected '+command.op)};
 runtime.transcript=async()=>({turns:[{id:'native-history'}],status:'unknown',historyComplete:true});
 const view=await runtime.execute({op:'read',id:'local_other'});
 const list=await runtime.execute({op:'list'});
 assert.deepEqual(calls,[]);
 assert.equal(view.live,false);assert.equal(view.status,'unknown');assert.equal(view.turns[0].id,'native-history');
 assert.deepEqual(list.threads.map(thread=>thread.status),['unknown']);
});

test('Claude read with a stale prior selection only inspects and never navigates',async()=>{
 const runtime=new ClaudeNative();const calls=[];
 runtime.records=async()=>[{id:'local_other',title:'Other'}];
 runtime.lastView={state:{selectedId:'local_stale',locked:false,nodes:[]},at:0};
 runtime.ax=async command=>{calls.push(command);return{selectedId:'local_stale',locked:false,nodes:[]}};
 runtime.transcript=async()=>({turns:[{id:'native-history'}],status:'idle',historyComplete:true});
 const view=await runtime.execute({op:'read',id:'local_other'});
 await runtime.tail;
 assert.ok(calls.length>0);
 assert.deepEqual([...new Set(calls.map(command=>command.op))],['inspect']);
 assert.equal(view.live,false);
});

test('Claude read of the currently selected session keeps live state and approvals',async()=>{
 const runtime=new ClaudeNative();const calls=[];
 runtime.records=async()=>[{id:'local_open',title:'Open'}];
 runtime.lastView={state:{selectedId:'local_open',locked:false,nodes:[{role:'AXButton',title:'Stop'},{role:'AXButton',title:'Allow once'}]},at:Date.now()};
 runtime.ax=async command=>{calls.push(command);throw Error('unexpected '+command.op)};
 runtime.transcript=async()=>({turns:[{id:'native-history'}],status:'idle',historyComplete:true});
 const view=await runtime.execute({op:'read',id:'local_open'});
 assert.deepEqual(calls,[]);
 assert.equal(view.live,true);assert.equal(view.status,'active');
 assert.deepEqual(view.requests,[{id:'native-ui-approval',method:'native/approval',buttons:['Stop','Allow once'].filter(label=>['Allow once'].includes(label))}]);
});

test('explicit Claude send to another session still targets it through native select',async()=>{
 const runtime=new ClaudeNative();const calls=[];let opened=false;let submitted=false;
 const record={id:'local_other',title:'Other'};
 runtime.records=async()=>[record];
 runtime.ax=async command=>{
  calls.push(command);
  if(command.op==='open'){opened=true;return{ok:true}};
  if(command.op==='send'){submitted=true;return{ok:true,dispatched:true}};
  return{selectedId:opened?'local_other':'local_open',locked:false,nodes:opened?[{role:'AXTextArea',description:'Prompt',value:''}]:[]};
 };
 runtime.transcript=async()=>({turns:[],queueReceipts:submitted?[{id:'fresh',hash:createHash('sha256').update('follow up').digest('hex')}]:[]});
 const result=await runtime.execute({op:'send',id:'local_other',text:'follow up'});
 assert.equal(result.queued,true);assert.equal(result.native,true);
 assert.deepEqual(calls.map(command=>command.op).slice(0,3),['inspect','open','inspect']);
 assert.equal(calls.filter(command=>command.op==='send').length,1);
});

test('Claude Swift snapshot stays passive and activation remains explicit',async()=>{
 const source=await readFile(new URL('./claude-ax.swift',import.meta.url),'utf8');
 const body=name=>{
  const start=source.indexOf(`func ${name}(`);assert.notEqual(start,-1,`missing ${name}`);
  const open=source.indexOf('{',start);let depth=0;
  for(let i=open;i<source.length;i++){
   if(source[i]==='{')depth++;
   else if(source[i]==='}'&&--depth===0)return source.slice(open,i+1);
  }
  throw Error(`unterminated ${name}`);
 };
 const snapshot=body('snapshot');
 assert.doesNotMatch(snapshot,/activate|focusApp|NSWorkspace/);
 assert.match(snapshot,/if nodes\.count < 3 \{ return nodes \}/);
 assert.doesNotMatch(body('inspect'),/activate|focusApp|NSWorkspace/);
 assert.match(body('activeSnapshot'),/focusApp\(\)/);
 assert.equal((source.match(/app\.activate\(options: \[\]\)/g)??[]).length,1);
});
