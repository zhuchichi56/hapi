import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateImages,storeImages} from './native-attachments.mjs';
import {validateCommand,CodexRuntime} from './native-host.mjs';
import {EventEmitter} from 'node:events';
const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XQAAAAASUVORK5CYII=';
test('image uploads validate content, count and native image-only messages',()=>{
 assert.equal(validateImages([{data}]).length,1);
 assert.throws(()=>validateImages([{data:'data:image/png;base64,dGV4dA=='}]),/内容/);
 assert.throws(()=>validateImages(Array(5).fill({data})),/4/);
 assert.doesNotThrow(()=>validateCommand({app:'codex',op:'send',id:'original',actionId:'one',text:'',images:[{data}]}));
 assert.throws(()=>validateCommand({app:'codex',op:'send',id:'original',actionId:'one',text:''}));
});
test('stored images use private content-addressed files and cannot select arbitrary paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-upload-'));
 try{
  const [path]=await storeImages([{name:'../../private',data}],root);
  assert.equal((await stat(path)).mode&0o777,0o600);
  assert.deepEqual(await storeImages([{data}],root),[path]);
  assert.equal((await readFile(path)).subarray(1,4).toString(),'PNG');
 }finally{await rm(root,{recursive:true,force:true})}
});
test('Codex forwards uploaded pictures as native localImage input',async()=>{
 let request;
 const desktop=Object.assign(new EventEmitter(),{clientId:'ready',threads:new Map([['original',{owner:'native',state:{id:'original'}}]]),request:async(name,args)=>{request={name,args};return{resultType:'success'}}});
 const runtime=new CodexRuntime({callerThreadId:'caller',desktop});
 await runtime.execute({op:'send',id:'original',actionId:'image',text:'look',images:[{data}]});
 assert.equal(request.name,'thread-follower-start-turn');
 const input=request.args.turnStart.request.input;
 assert.equal(input[0].text,'look');assert.equal(input[1].type,'localImage');assert.match(input[1].path,/attachments\/\w+\.png$/);
});
