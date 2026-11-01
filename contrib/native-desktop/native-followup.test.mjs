import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexRuntime} from './native-host.mjs';
function fixture(reply) {
 const calls=[];
 const desktop=Object.assign(new EventEmitter(), {clientId:'ready',threads:new Map([['original',{owner:'owner',state:{id:'original',threadRuntimeStatus:{type:'idle'},turns:[{id:'completed',status:'completed'}]}}]]),request:async(method,params,owner)=>{calls.push({method,params,owner});return reply}});
 const runtime=new CodexRuntime({callerThreadId:'caller',desktop,callTool:async()=>{throw Error('must not dispatch via stale automatic follow-up route')}});
 return {runtime,calls};
}
test('idle original session follows supported start-turn route and requires native turn receipt', async()=>{
 const {runtime,calls}=fixture({resultType:'success',result:{result:{turn:{id:'new-native-turn'}}}});
 const response=await runtime.execute({op:'send',id:'original',text:'routing fixture only',actionId:'unique'});
 assert.equal(calls.length,1);assert.equal(calls[0].method,'thread-follower-start-turn');
 assert.equal(calls[0].owner,'owner');assert.equal(calls[0].params.conversationId,'original');
 assert.equal(calls[0].params.turnStart.request.threadId,'original');
 assert.deepEqual(response,{threadId:'original',turnId:'new-native-turn',native:true});
});
test('thread identity or transport success without native turn receipt is unknown, never automatically retried', async()=>{
 for(const reply of [{resultType:'success'}, {resultType:'success',result:{threadId:'original'}}]){
  const {runtime,calls}=fixture(reply);
  await assert.rejects(runtime.execute({op:'send',id:'original',text:'fixture',actionId:'unique'}),error=>error.delivery==='unknown');
  assert.equal(calls.length,1);
 }
});
