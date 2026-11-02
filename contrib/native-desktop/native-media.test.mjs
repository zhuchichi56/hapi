import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {imageReferences,readNativeImage} from './native-media.mjs';
import {delegationRecord} from './native-delegation.mjs';
test('native images must be referenced by the exact original message and be real images',async()=>{
 assert.deepEqual(imageReferences('![one](/tmp/one.png) ![two](</tmp/two space.png>)'),['/tmp/one.png','/tmp/two space.png']);
 await assert.rejects(readNativeImage({item:{text:'hello'}},'/etc/passwd'),/原始消息/);
 const dir=await mkdtemp(join(tmpdir(),'native-image-test-'));const path=join(dir,'bad.png');
 try{await writeFile(path,'ordinary private text');await assert.rejects(readNativeImage({item:{text:`![x](${path})`}},path),/图片格式/)}finally{await rm(dir,{recursive:true,force:true})}
});
test('DSH badges distinguish delegation and monitoring without claiming child completion',()=>{
 assert.equal(delegationRecord('echo hello'),undefined);
 assert.equal(delegationRecord('cat /tmp/dsh_run.sh'),undefined);
 assert.equal(delegationRecord(JSON.stringify({code:'const pattern = /dsh_run.sh/;'})),undefined);
 assert.equal(delegationRecord(JSON.stringify({command:'bash /tmp/dsh_run.sh brief work'})).phase,'委托调用');
 assert.equal(delegationRecord(JSON.stringify({code:'await tools.exec_command({cmd:"bash /tmp/dsh_run.sh brief work"})'})).phase,'委托调用');
 assert.equal(delegationRecord('bash ~/skills/dsh-delegate/scripts/dsh_run.sh BRIEF.md WORK', '', 'completed').phase,'委托调用');
 assert.equal(delegationRecord('python3 -I ~/scripts/dsh_status.py WORK','','completed').phase,'检查进度');
 assert.equal(delegationRecord('bash /tmp/dsh_steer.sh WORK next','','running').status,'调用中');
 assert.equal(delegationRecord('bash /tmp/dsh_run.sh brief work','','completed').status,'已记录');
});

test('large preview requests cannot authorize unrelated local files',async()=>{
 await assert.rejects(readNativeImage({item:{images:['/tmp/original.png']}},'/tmp/other.png','large'),/原始消息/);
 await assert.rejects(readNativeImage({item:{images:['/tmp/original.png']}},'/tmp/original.png','unbounded'),/image size/);
});
test('already compact native images stay compressed, concurrent previews share one result',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-small-'));const path=join(dir,'small.png');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 try{await writeFile(path,png);const detail={item:{images:[path]}};const [one,two]=await Promise.all([readNativeImage(detail,path),readNativeImage(detail,path)]);assert.equal(one,two);assert.equal(one.image.src,'data:image/png;base64,'+png.toString('base64'));}finally{await rm(dir,{recursive:true,force:true})}
});
test('Markdown-encoded Chinese image paths resolve to the exact original path and cache',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-cjk-'));const path=join(dir,'开源版 图片.png');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 try{
  await writeFile(path,png);const detail={item:{text:`![毛玻璃看板效果](<${path}>)`}};
  const [literal,encoded]=await Promise.all([readNativeImage(detail,path),readNativeImage(detail,encodeURI(path))]);
  assert.equal(literal,encoded);assert.equal(encoded.image.src,'data:image/png;base64,'+png.toString('base64'));
  assert.equal((await readNativeImage(detail,encodeURI(path),'large')).image.src,encoded.image.src);
  assert.equal((await readNativeImage({item:{images:[path]}},encodeURI(path))).image.src,encoded.image.src);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('encoded image requests cannot authorize another file, another message or a second decode',async()=>{
 const path='/tmp/开源版.png';const detail={item:{text:`![original](${path})`}};
 await assert.rejects(readNativeImage(detail,encodeURI('/tmp/other.png')),/原始消息/);
 await assert.rejects(readNativeImage({item:{text:'no image'}},encodeURI(path)),/原始消息/);
 await assert.rejects(readNativeImage(detail,encodeURI(encodeURI(path))),/原始消息/);
 await assert.rejects(readNativeImage(detail,'/tmp/%2e%2e/etc/passwd'),/原始消息/);
});
test('literal filenames win over encoded aliases and existing percent escapes remain literal files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-percent-'));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const spaced=join(dir,'a b.png'),percent=join(dir,'a%20b.png'),chinese=join(dir,'图片 lit%41.png');
 const distinct=Buffer.concat([png,Buffer.from([0])]);
 try{
  await Promise.all([writeFile(spaced,png),writeFile(percent,distinct),writeFile(chinese,png)]);
  const detail={item:{images:[spaced,percent]}};
  assert.equal((await readNativeImage(detail,percent)).image.src,'data:image/png;base64,'+distinct.toString('base64'));
  const encoded=encodeURI(chinese).replace(/%25([\da-f]{2})/gi,'%$1');
  const original={item:{text:`![x](<${chinese}>)`}};
  assert.equal(await readNativeImage(original,encoded),await readNativeImage(original,chinese));
 }finally{await rm(dir,{recursive:true,force:true})}
});
