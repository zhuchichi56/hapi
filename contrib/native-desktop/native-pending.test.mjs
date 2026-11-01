import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePendingState, normalizeSnapshot, CodexRuntime} from './native-host.mjs';
import {EventEmitter} from 'node:events';
test('native pending flags and valid requests override active, never idle guesses',()=>{
 assert.equal(nativePendingState({type:'active',activeFlags:['waitingOnApproval']}),'approval');
 assert.equal(nativePendingState({type:'active',activeFlags:['waitingOnUserInput']}),'input');
 assert.equal(nativePendingState('idle'),null);
 assert.equal(nativePendingState('completed'),null);
 assert.equal(nativePendingState('active',[{method:'item/tool/requestUserInput'}]),'input');
 assert.equal(nativePendingState('active',[{method:'item/commandExecution/requestApproval'}]),'approval');
 assert.equal(nativePendingState('active',[{method:'unrecognized'}]),null);
});
test('list recovers real pending state on refresh and clears it when requests clear',async()=>{
 const desktop=new EventEmitter(); desktop.clientId='test'; desktop.threads=new Map();
 const runtime=new CodexRuntime({callerThreadId:'fixture',desktop,callTool:async()=>({threads:[{id:'blog',kind:'codex',status:'active'}]})});
 let waiting=true;
 runtime.connectStream=async id=>desktop.threads.set(id,{state:{threadRuntimeStatus:{type:'active',activeFlags:waiting?['waitingOnApproval']:[]},requests:[]}});
 assert.equal((await runtime.list()).threads[0].pendingState,'approval');
 waiting=false;runtime.lastList=null;
 assert.equal((await runtime.list()).threads[0].pendingState,null);
});
