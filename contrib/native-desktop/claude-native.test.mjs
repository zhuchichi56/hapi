import test from 'node:test';
import assert from 'node:assert/strict';
import {ClaudeNative, normalizeClaudeTranscript} from './claude-native.mjs';
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
 runtime.ax = async command => { operations.push(command.op); return {locked:true,nodes:[],selectedId:''}; };
 runtime.transcript = async () => ({turns:[{id:'original'}],historyComplete:true});
 const view = await runtime.execute({op:'read',id:'local_test'});
 assert.equal(view.status,'locked'); assert.equal(view.live,false); assert.equal(view.turns[0].id,'original');
 await assert.rejects(runtime.execute({op:'send',id:'local_test',text:'hello'}), /锁屏/);
 assert.deepEqual(operations,['inspect','inspect']);
});
