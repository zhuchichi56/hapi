import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import {execFileSync} from 'node:child_process';
const root='/Users/zhuhe/.local/lib/hapi-mini';
if(!process.argv.includes('--run')){
  console.log('Read-only usage preview. --run creates one WWX test session and a project-local proof file, then verifies a real model/tool/network response.');
  process.exit(0);
}
const registry=JSON.parse(readFileSync(root+'/data/web-access-codes.json','utf8'));
const code=registry.codes.find(c=>c.namespace==='wwx')?.code;
if(!code)throw Error('Missing namespace code');
const auth=await fetch('http://127.0.0.1:3006/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken:code}),signal:AbortSignal.timeout(15000)});
if(!auth.ok)throw Error('Authentication failed');
const {token}=await auth.json();
async function api(path,body){
  const r=await fetch('http://127.0.0.1:3006/api'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  if(!r.ok)throw Error('API status '+r.status+' for '+path);
  return r.json();
}
const nonce=randomUUID();
const project='/Users/zhuhe/Workspaces/wwx';
const proof=project+'/.hapi-migration-check-'+nonce+'.json';
const spawned=await api('/machines/1038f411-05fb-454f-a9cd-3c4e226168f0/spawn',{directory:project,agent:'codex',model:'gpt-6.1-sol',permissionMode:'yolo'});
const sessionId=spawned.sessionId;
if(!sessionId)throw Error('Spawn did not return sessionId; no automatic retry');
const dir=root+'/single-user-migration-20261028/acceptance';
mkdirSync(dir,{recursive:true,mode:0o700});
writeFileSync(dir+'/pending-live.json',JSON.stringify({sessionId,nonce,proof,createdAt:new Date().toISOString()}),{mode:0o600});
console.log(JSON.stringify({testSession:sessionId,status:'spawned'}));
const command=`set -eu; test "$(/usr/bin/id -u)" = 501; test "$(/usr/bin/id -un)" = zhuhe; test "$HOME" = /Users/zhuhe; test "$PWD" = ${project}; status=$(/usr/bin/curl --connect-timeout 15 --max-time 40 --silent --show-error --output /dev/null --write-out '%{http_code}' https://example.com); test "$status" = 200; /usr/bin/printf '%s\\n' '{"nonce":"${nonce}","uid":501,"user":"zhuhe","networkStatus":200}' > '${proof}'`;
await api('/sessions/'+sessionId+'/messages',{text:'这是主人授权的迁移验收测试。请只执行下面这条 shell 命令，检查实际系统身份、HOME、项目写入和 HTTPS 联网；成功后回复 MIGRATION_OK，失败如实报告，不改其他文件。\n'+command,localId:'migration-'+nonce});
const deadline=Date.now()+240000;
let last;
while(Date.now()<deadline){
  last=(await api('/sessions/'+sessionId)).session;
  if(existsSync(proof)){
    const result=JSON.parse(readFileSync(proof,'utf8'));
    if(result.nonce!==nonce||result.uid!==501||result.user!=='zhuhe'||result.networkStatus!==200||statSync(proof).uid!==501)throw Error('Proof mismatch');
    const messages=await api('/sessions/'+sessionId+'/messages?limit=100');
    const reply=messages.messages?.some(m=>JSON.stringify(m.content).includes('MIGRATION_OK')&&!JSON.stringify(m.content).includes('这是主人授权的迁移验收测试'));
    if(reply&&!last.thinking){
      const {sessions}=await api('/sessions');
      let candidate;
      for(const s of sessions??[]){
        if(s.id===sessionId)continue;
        const {session:original}=await api('/sessions/'+s.id);
        if(original?.metadata?.codexSessionId&&!original.thinking&&original.metadata.path?.startsWith(project)){candidate=original;break}
      }
      if(!candidate)throw Error('No migrated Codex history was available to resume');
      if(!candidate.active)await api('/sessions/'+candidate.id+'/resume',{permissionMode:'yolo'});
      let resumed=false;
      for(let attempt=0;attempt<30;attempt++){
        const {session:old}=await api('/sessions/'+candidate.id);
        if(old?.active&&old.metadata?.codexSessionId===candidate.metadata.codexSessionId&&Number.isSafeInteger(old.metadata.hostPid)){
          const uid=Number(execFileSync('/bin/ps',['-p',String(old.metadata.hostPid),'-o','uid='],{encoding:'utf8'}).trim());
          if(uid===501){resumed=true;break}
        }
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      if(!resumed)throw Error('An existing Codex conversation did not resume as zhuhe');
      const report={verifiedAt:new Date().toISOString(),sessionId,nonce,proof,uid:501,user:'zhuhe',project,networkStatus:200,model:'gpt-6.1-sol',permissionMode:last.permissionMode,realReply:true,resumedHistory:true,resumedSessionId:candidate.id};
      writeFileSync(dir+'/live-proof.json',JSON.stringify(report,null,2),{mode:0o600});
      console.log(JSON.stringify(report));
      process.exit(0);
    }
  }
  await new Promise(resolve=>setTimeout(resolve,3000));
}
throw Error('Live acceptance did not complete; test session preserved. No automatic account removal.');
