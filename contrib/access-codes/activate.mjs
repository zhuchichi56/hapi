import {readFileSync,writeFileSync,copyFileSync,existsSync,renameSync,chmodSync,mkdirSync}from'node:fs';
import{homedir}from'node:os';import{randomBytes,createHash}from'node:crypto';import{execFileSync}from'node:child_process';
const root=homedir()+'/.local/lib/hapi-mini',backup=root+'/access-repair-20261027',runner=homedir()+'/.local/lib/hapi-runner/home/.hapi/settings.json';
const registry=root+'/data/web-access-codes.json',state=backup+'/activation-state.json';
if(existsSync(state))throw Error('Activation already attempted; inspect private activation state before continuing');
if(existsSync(registry))throw Error('Existing code registry; inspect before continuing');
mkdirSync(backup,{recursive:true,mode:0o700});chmodSync(backup,0o700);
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const atomic=(p,v)=>{const t=p+'.access-repair.tmp';writeFileSync(t,JSON.stringify(v,null,2),{mode:0o600});chmodSync(t,0o600);renameSync(t,p);};
const base='http://127.0.0.1:3006';
async function req(path,body,jwt){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(jwt?{Authorization:'Bearer '+jwt}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(6000)});return{status:r.status,data:await r.json()};}
const settings=read(root+'/data/settings.json');const oldRoot=settings.cliApiToken;
const prior=await req('/api/auth',{accessToken:oldRoot});if(prior.status!==200)throw Error('Pre-activation owner auth failed');
const sessions=await req('/api/sessions',undefined,prior.data.token);
if(sessions.status!==200)throw Error('Cannot verify active HAPI sessions');
const active=(sessions.data.sessions??[]).filter(x=>x.active);
if(active.some(x=>x.thinking))throw Error('HAPI agent is generating; wait before credential rotation');
console.log(JSON.stringify({check:'rotation-preflight',openIdleSessions:active.length,generatingSessions:0}));
for(const[n,p]of[['settings.json',root+'/data/settings.json'],['jwt-secret.json',root+'/data/jwt-secret.json'],['runner-settings.json',runner],['hapi-hub',root+'/bin/hapi-hub']]){const b=backup+'/'+n;if(!existsSync(b))copyFileSync(p,b);chmodSync(b,n==='hapi-hub'?0o700:0o600);}
const freshRoot=randomBytes(32).toString('base64url'),owner=randomBytes(32).toString('base64url'),guest=randomBytes(32).toString('base64url');
const currentRunner=read(runner);if(currentRunner.machineId!=='40cc1516-0d86-42bf-9d60-2cc393343217')throw Error('Runner identity changed');
settings.cliApiToken=freshRoot;currentRunner.cliApiToken=freshRoot;
const pidText=execFileSync('/usr/sbin/lsof',['-tiTCP:3006','-sTCP:LISTEN'],{encoding:'utf8'}).trim();if(!/^\d+$/.test(pidText))throw Error('Hub process not unique');
atomic(state,{phase:'prepared',previousHubPid:Number(pidText),activeSessions:active.length});
atomic(root+'/data/settings.json',settings);atomic(runner,currentRunner);
atomic(root+'/data/jwt-secret.json',{secretBase64:randomBytes(32).toString('base64')});
atomic(registry,{version:1,codes:[{code:owner,namespace:'default'},{code:guest,namespace:'wwx'}]});
const candidate=root+'/builds/quick-session-20261026/hapi-hub.access-codes-20261027';
copyFileSync(candidate,root+'/bin/hapi-hub.access-repair.tmp');chmodSync(root+'/bin/hapi-hub.access-repair.tmp',0o755);renameSync(root+'/bin/hapi-hub.access-repair.tmp',root+'/bin/hapi-hub');
process.kill(Number(pidText),'SIGTERM');
let ownerAuth;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,300));try{const a=await req('/api/auth',{accessToken:owner});if(a.status===200){ownerAuth=a.data;break;}}catch{}}
if(!ownerAuth)throw Error('New owner login not ready; inspect service with private backup retained');
execFileSync('/bin/launchctl',['kickstart','-k',`gui/${process.getuid()}/run.hapi.runner-mini`]);
let machines;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,300));try{const m=await req('/api/machines',undefined,ownerAuth.token);machines=m.data.machines??[];if(m.status===200&&machines.some(x=>x.id===currentRunner.machineId&&x.active))break;}catch{}}
const guestAuth=await req('/api/auth',{accessToken:guest});if(guestAuth.status!==200)throw Error('Guest auth failed');
const checks=[];checks.push({check:'owner-login',status:200});
const ownerDesktop=await req('/api/native-desktop/command',{app:'codex',op:'projects'},ownerAuth.token);checks.push({check:'owner-desktop-project-list',status:ownerDesktop.status,ok:ownerDesktop.data.ok});
for(const path of ['/api/native-desktop/command','/api/native-desktop/command?namespace=default']){const d=await req(path,{app:'codex',op:'list'},guestAuth.data.token);checks.push({check:'guest-desktop-denied',status:d.status});if(d.status!==403)throw Error('Guest desktop access not denied');}
const guestMachines=await req('/api/machines',undefined,guestAuth.data.token);checks.push({check:'guest-machines-isolated',status:guestMachines.status,count:(guestMachines.data.machines??[]).length});
for(const code of [oldRoot,freshRoot,guest+':default',guest.slice(0,-1)]){const a=await req('/api/auth',{accessToken:code});checks.push({check:'retired-or-manipulated-code-denied',status:a.status});if(a.status!==401)throw Error('Unexpected accepted code');}
const oldJWT=await req('/api/machines',undefined,prior.data.token);checks.push({check:'previous-owner-jwt-revoked',status:oldJWT.status});
if(oldJWT.status!==401)throw Error('Old JWT remains valid');
checks.push({check:'owner-runner-online',active:machines?.some(x=>x.id===currentRunner.machineId&&x.active)??false});
if(!checks.at(-1).active)throw Error('Owner runner did not reconnect');
if(ownerDesktop.status!==200||!ownerDesktop.data.ok)throw Error('Owner desktop connection not healthy');
atomic(state,{phase:'verified',checks,binarySha256:createHash('sha256').update(readFileSync(root+'/bin/hapi-hub')).digest('hex')});
console.log(JSON.stringify({phase:'verified',checks},null,2));
