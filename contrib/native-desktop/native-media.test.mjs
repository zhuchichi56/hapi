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
