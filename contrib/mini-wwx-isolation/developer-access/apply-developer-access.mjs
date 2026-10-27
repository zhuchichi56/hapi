import {readFileSync,writeFileSync,mkdirSync,copyFileSync,chmodSync,chownSync,statSync,existsSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
const pkg=dirname(fileURLToPath(import.meta.url));const mode=process.argv[2]??'--check';
if(!['--check','--apply'].includes(mode))throw Error('Use --check or --apply');
if(process.platform!=='darwin')throw Error('Mac mini macOS only');
const iso='/Library/Application Support/HAPI-WWX-Isolation';const home='/Users/hapi-wwx';const policy=join(iso,'policy/wwx.sb');const wrapper=join(iso,'bin/hapi-tenant-run');const bun='/opt/hapi-wwx/bin/bun';
for(const p of [policy,wrapper,join(pkg,'wwx.developer.sb'),join(pkg,'wrapper.developer.sh')])if(!existsSync(p))throw Error('Required file missing: '+p);
execFileSync('/usr/bin/sandbox-exec',['-f',join(pkg,'wwx.developer.sb'),'/bin/echo','POLICY_PARSE_OK'],{stdio:'inherit'});
execFileSync('/bin/sh',['-n',join(pkg,'wrapper.developer.sh')]);
console.log('Plan: restore WWX public HTTPS egress, SSH/SCP/SFTP commands, user-local tool PATH, normal temporary files, Codex full-access and Claude bypass defaults. Preserve owner/tenant data and private owner loopback isolation. RJJ existing conversation is resumed separately through its native API.');
if(mode==='--check'){console.log('CHECK_OK: no files changed');process.exit(0)}
if(process.getuid()!==0)throw Error('Administrator authentication required: run with sudo');
const settings=JSON.parse(readFileSync(join(home,'.hapi/settings.json'),'utf8'));
const auth=await fetch('http://127.0.0.1:3026/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken:settings.cliApiToken+':wwx'})});
if(!auth.ok)throw Error('Guest authentication failed; no changes made');const {token}=await auth.json();const headers={Authorization:'Bearer '+token};
const list=await fetch('http://127.0.0.1:3026/api/sessions',{headers});if(!list.ok)throw Error('Guest activity could not be checked; no changes made');
const sessions=(await list.json()).sessions??[];
for(const s of sessions.filter(s=>s.active)){const r=await fetch(`http://127.0.0.1:3026/api/sessions/${s.id}`,{headers});if(!r.ok)throw Error('Activity unknown; no changes made');const d=await r.json();const live=d.session??d;if(live.thinking||live.backgroundTaskCount>0)throw Error('An active task is running; finish it and rerun. No changes made.');}
const stamp=new Date().toISOString().replaceAll(':','-');const backup=join(iso,'backups','developer-'+stamp);mkdirSync(backup,{recursive:true,mode:0o700});
const tracked=[policy,wrapper,join(home,'.codex/config.toml'),join(home,'.claude/settings.json')];
const manifest=[];for(let i=0;i<tracked.length;i++){const p=tracked[i];if(existsSync(p)){const st=statSync(p);copyFileSync(p,join(backup,String(i)));chmodSync(join(backup,String(i)),0o600);manifest.push({path:p,backup:String(i),mode:st.mode&0o777,uid:st.uid,gid:st.gid})}else manifest.push({path:p,absent:true})}
writeFileSync(join(backup,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
function install(src,dst,mode){copyFileSync(src,dst);chownSync(dst,0,0);chmodSync(dst,mode)}
const uid=statSync(home).uid;const cfg=join(home,'.codex/config.toml');let text=existsSync(cfg)?readFileSync(cfg,'utf8'):'';let section=false;const lines=text.split('\n').filter(line=>{if(/^\s*\[/.test(line))section=true;return section||!/^\s*(sandbox_mode|approval_policy)\s*=/.test(line)});
const claude=join(home,'.claude/settings.json');const json=existsSync(claude)?JSON.parse(readFileSync(claude,'utf8')):{};json.permissions={...json.permissions,defaultMode:'bypassPermissions'};
try{install(join(pkg,'wwx.developer.sb'),policy,0o444);install(join(pkg,'wrapper.developer.sh'),wrapper,0o555);mkdirSync(dirname(cfg),{recursive:true});writeFileSync(cfg,'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n'+lines.join('\n'),{mode:0o600});chownSync(cfg,uid,20);chmodSync(cfg,0o600);mkdirSync(dirname(claude),{recursive:true});chownSync(dirname(claude),uid,20);writeFileSync(claude,JSON.stringify(json,null,2)+'\n',{mode:0o600});chownSync(claude,uid,20);chmodSync(claude,0o600);execFileSync('/bin/launchctl',['kickstart','-k','system/run.hapi.wwx.runner']);console.log('APPLIED; runner restarted while no thinking/background task was reported. Reopen existing conversations to inherit the new process policy.');console.log('Rollback backup: '+backup)}catch(error){for(const m of manifest){if(m.absent){if(existsSync(m.path))unlinkSync(m.path);continue}copyFileSync(join(backup,m.backup),m.path);chmodSync(m.path,m.mode);chownSync(m.path,m.uid,m.gid)}throw error}
