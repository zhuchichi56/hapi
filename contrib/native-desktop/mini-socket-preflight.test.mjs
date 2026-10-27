import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile), script=new URL('./mini-socket-preflight.pl',import.meta.url).pathname;
test('tunnel reconnect removes only stale owned sockets and preserves live sockets and files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-forward-'));const path=join(dir,'host.sock');
 try{
  const server=net.createServer(socket=>socket.end());await new Promise(r=>server.listen(path,r));
  try{await run('/usr/bin/perl',[script,path]);assert.equal((await stat(path)).isSocket(),true)}finally{await new Promise(r=>server.close(r))}
  await writeFile(path,'preserve');await assert.rejects(run('/usr/bin/perl',[script,path]),/foreign forward path/);assert.equal((await stat(path)).isFile(),true);await rm(path);
  const child=spawn(process.execPath,['--input-type=module','-e',`import net from 'node:net';net.createServer().listen(${JSON.stringify(path)},()=>console.log('ready'));`],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>{if(code)reject(Error('Socket fixture exited'))})});
  const closed=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await closed;
  assert.equal((await stat(path)).isSocket(),true);
  await run('/usr/bin/perl',[script,path]);await assert.rejects(stat(path),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true})}
});
