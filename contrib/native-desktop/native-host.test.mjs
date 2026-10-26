import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDispatcher,validateCommand,normalizeReadThread,normalizeItem,nativeRpc} from './native-host.mjs';
test('native command validation and explicit action identity',()=>{
 assert.throws(()=>validateCommand({app:'codex',op:'send',id:'x',text:'hi'}));
 assert.throws(()=>validateCommand({app:'codex',op:'send',id:'../x',text:'hi',actionId:'a'}));
 assert.throws(()=>validateCommand({app:'other',op:'list'}));
 assert.equal(validateCommand({app:'codex',op:'send',id:'abc',text:'hi',actionId:'a'}).op,'send');
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
