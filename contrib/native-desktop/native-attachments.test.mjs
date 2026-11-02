import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateImages,storeImages,resolveZipAttachments,receiveZipUpload,validateZipSignature,safeZipName,zipDirectory} from './native-attachments.mjs';
import {validateCommand,CodexRuntime} from './native-host.mjs';
import {EventEmitter} from 'node:events';
const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XQAAAAASUVORK5CYII=';
const emptyZip=Buffer.concat([Buffer.from([0x50,0x4b,0x05,0x06]),Buffer.alloc(18)]);
const zipBytes=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.alloc(26),emptyZip]);
async function* chunks(...parts){for(const part of parts) yield part}
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
 const desktop=Object.assign(new EventEmitter(),{clientId:'ready',threads:new Map([['original',{owner:'native',state:{id:'original'}}]]),request:async(name,args)=>{request={name,args};return{resultType:'success',result:{result:{turn:{id:'image-turn'}}}}}});
 const runtime=new CodexRuntime({callerThreadId:'caller',desktop});
 await runtime.execute({op:'send',id:'original',actionId:'image',text:'look',images:[{data}]});
 assert.equal(request.name,'thread-follower-start-turn');
 const input=request.args.turnStart.request.input;
 assert.equal(input[0].text,'look');assert.equal(input[1].type,'localImage');assert.match(input[1].path,/attachments\/\w+\.png$/);
});
test('ZIP names and signatures are validated before private atomic storage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-zip-'));
 try{
  assert.equal(safeZipName('Report.ZIP'),'Report.ZIP');
  assert.throws(()=>safeZipName('../evil.zip'),/文件名/);
  assert.throws(()=>safeZipName('notes.txt'),/zip/i);
  assert.throws(()=>safeZipName('bad\u0000.zip'),/文件名/);
  assert.equal(validateZipSignature(emptyZip),true);
  assert.equal(validateZipSignature(zipBytes),true);
  assert.equal(validateZipSignature(Buffer.from('not a zip')),false);
  const meta=await receiveZipUpload(chunks(zipBytes),'Report.ZIP',root);
  assert.match(meta.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(meta.name,'Report.ZIP');assert.equal(meta.size,zipBytes.length);
  const path=join(zipDirectory(root),`${meta.id}.zip`);
  assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal((await stat(zipDirectory(root))).mode&0o777,0o700);
  assert.deepEqual(await readFile(path),zipBytes);
  const [resolved]=await resolveZipAttachments([meta.id],root);
  assert.equal(resolved.path,path);
  assert.match(resolved.canonicalText,/Report\.ZIP/);
  assert.match(resolved.canonicalText,/本机路径/);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('ZIP uploads reject arbitrary paths, duplicates and more than four ids',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-zip-'));
 try{
  const id='00000000-0000-4000-8000-000000000000';
  await assert.rejects(resolveZipAttachments(['../../etc/passwd'],root),/标识/);
  await assert.rejects(resolveZipAttachments([id],root),/不存在/);
  assert.throws(()=>validateCommand({app:'codex',op:'send',id:'abc',text:'',actionId:'a',attachmentIds:['../../etc/passwd']}),/标识/);
  assert.throws(()=>validateCommand({app:'codex',op:'send',id:'abc',text:'',actionId:'a',attachmentIds:[id,id]}),/标识/);
  assert.throws(()=>validateCommand({app:'codex',op:'send',id:'abc',text:'',actionId:'a',attachmentIds:Array(5).fill(id)}),/4/);
  assert.doesNotThrow(()=>validateCommand({app:'codex',op:'send',id:'abc',text:'',actionId:'a',attachmentIds:[id]}));
  assert.doesNotThrow(()=>validateCommand({app:'claude',op:'create',text:'',actionId:'a',attachmentIds:[id]}));
  assert.throws(()=>validateCommand({app:'codex',op:'send',id:'abc',text:'',actionId:'a',images:Array(4).fill({data}),attachmentIds:[id]}),/4 个附件/);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('ZIP upload enforces the limit while streaming and removes partial files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-zip-'));
 try{
  const parts=Array.from({length:21},()=>Buffer.alloc(1024*1024,1));
  await assert.rejects(receiveZipUpload((async function*(){for(const part of parts)yield part})(),'big.zip',root),/20 MiB/);
  assert.deepEqual(await readdir(zipDirectory(root)),[]);
  await assert.rejects(receiveZipUpload((async function*(){yield Buffer.from([0x50,0x4b,0x03,0x04]);throw Error('client aborted')})(),'abort.zip',root),/client aborted/);
  assert.deepEqual(await readdir(zipDirectory(root)),[]);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('Codex create and send resolve stored ZIPs into readable native input',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-zip-'));
 try{
  const meta=await receiveZipUpload(chunks(zipBytes),'Report.ZIP',root);
  let createArgs,request;
  const desktop=Object.assign(new EventEmitter(),{clientId:'ready',threads:new Map([['original',{owner:'native',state:{id:'original'}}]]),request:async(name,args)=>{request={name,args};return{resultType:'success',result:{result:{turn:{id:'zip-turn'}}}}}});
  const runtime=new CodexRuntime({callerThreadId:'caller',desktop,attachmentRoot:root,callTool:async(name,args)=>{createArgs={name,args};return{threadId:'new'}}});
  await runtime.execute({op:'create',actionId:'create-zip',text:'',attachmentIds:[meta.id]});
  assert.equal(createArgs.name,'create_thread');
  assert.match(createArgs.args.prompt,/Report\.ZIP/);
  assert.ok(createArgs.args.prompt.includes(meta.path));
  await runtime.execute({op:'send',id:'original',actionId:'send-zip',text:'',attachmentIds:[meta.id]});
  assert.equal(request.name,'thread-follower-start-turn');
  const input=request.args.turnStart.request.input;
  assert.equal(input.length,1);assert.equal(input[0].type,'text');
  assert.match(input[0].text,/Report\.ZIP/);assert.ok(input[0].text.includes(meta.path));
  await assert.rejects(runtime.execute({op:'send',id:'original',actionId:'missing-zip',text:'',attachmentIds:['00000000-0000-4000-8000-000000000000']}),error=>error.delivery==='not-sent');
 }finally{await rm(root,{recursive:true,force:true})}
});
test('ZIP signature is assembled when the PK header is split across tiny chunks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-zip-'));
 try{
  const split=(async function*(){for(const byte of zipBytes)yield Buffer.from([byte])})();
  const meta=await receiveZipUpload(split,'Split.ZIP',root);
  assert.equal(meta.size,zipBytes.length);
  assert.deepEqual(await readFile(join(zipDirectory(root),`${meta.id}.zip`)),zipBytes);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('ZIP chunks preserve bytes and reject wrong offsets without corrupting the upload',async()=>{
 const {receiveZipChunk,MAX_CHUNK_BYTES}=await import('./native-attachments.mjs');
 const root=await mkdtemp(join(tmpdir(),'native-chunk-'));
 try {
  const bytes=Buffer.concat([zipBytes.subarray(0,30),Buffer.alloc(MAX_CHUNK_BYTES),emptyZip]);
  const first=await receiveZipChunk(chunks(bytes.subarray(0,MAX_CHUNK_BYTES)),'资料.zip',{total:bytes.length,offset:0},root);
  assert.equal(first.complete,false);assert.equal(first.offset,MAX_CHUNK_BYTES);
  await assert.rejects(receiveZipChunk(chunks(Buffer.from('x')),'资料.zip',{total:bytes.length,offset:1,uploadId:first.uploadId},root),/顺序/);
  const result=await receiveZipChunk(chunks(bytes.subarray(MAX_CHUNK_BYTES)),'资料.zip',{total:bytes.length,offset:first.offset,uploadId:first.uploadId},root);
  assert.equal(result.complete,true);assert.deepEqual(await readFile(result.path),bytes);
  assert.equal((await readdir(zipDirectory(root))).some(x=>x.includes('.chunk')),false);
  await assert.rejects(receiveZipChunk(chunks(Buffer.alloc(MAX_CHUNK_BYTES+1)),'大.zip',{total:MAX_CHUNK_BYTES+10,offset:0},root),e=>e.status===413);
  async function* interrupted(){yield Buffer.from('PK');throw Error('interrupted')}
  await assert.rejects(receiveZipChunk(interrupted(),'中断.zip',{total:100,offset:0},root),/interrupted/);
  assert.equal((await readdir(zipDirectory(root))).some(x=>x.includes('.chunk')),false);
 } finally {await rm(root,{recursive:true,force:true})}
});
