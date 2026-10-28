import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {mapPath,rewriteStructured,sqliteBackup,sqliteIntegrity,sqliteStructuredRewrite,historyDigest,inventory,repairCopiedPaths,hasPendingWork,cfg} from './migrate-single-user.mjs';

const sql=(db,text)=>execFileSync('/usr/bin/sqlite3',[db,text],{encoding:'utf8'}).trim();
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
test('only structured paths move; actual HOME and project cwd stay distinct',()=>{
  assert.equal(mapPath('/Users/hapi-wwx/work/a'),cfg.canonicalCwd+'/a');
  assert.equal(mapPath('/Users/hapi-wwx2/work'),'/Users/hapi-wwx2/work');
  assert.deepEqual(rewriteStructured({homeDir:'/Users/hapi-wwx',path:'/Users/hapi-wwx/work',message:'/Users/hapi-wwx/work'}),{homeDir:cfg.newHome,path:cfg.canonicalCwd,message:'/Users/hapi-wwx/work'});
});

test('WAL backup retains committed messages; HAPI metadata and Codex rollout paths move',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hapi-wal-test-'));
  const source=path.join(tmp,'source.sqlite'),home=path.join(tmp,'copied'),dest=path.join(home,'.hapi/hapi.db');
  const writer=spawn('/usr/bin/sqlite3',[source],{stdio:['pipe','pipe','pipe']});
  let errors='';writer.stderr.on('data',d=>errors+=d);
  try{
    const meta=JSON.stringify({path:'/Users/hapi-wwx/work/a',homeDir:'/Users/hapi-wwx',happyHomeDir:'/Users/hapi-wwx/.hapi',note:'historical /Users/hapi-wwx/work'});
    const ready=new Promise((resolve,reject)=>{
      let out='';writer.stdout.on('data',d=>{out+=d;if(out.includes('READY'))resolve()});
      writer.once('error',reject);writer.once('exit',code=>reject(Error('writer exited '+code+' '+errors)));
    });
    writer.stdin.write(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
CREATE TABLE sessions(id TEXT PRIMARY KEY,metadata TEXT,metadata_version INTEGER);
CREATE TABLE machines(id TEXT PRIMARY KEY,metadata TEXT,metadata_version INTEGER);
CREATE TABLE messages(id TEXT,session_id TEXT,content TEXT,seq INTEGER);
CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT);
INSERT INTO sessions VALUES('s',${quote(meta)},7);
INSERT INTO machines VALUES('m',${quote(meta)},2);
INSERT INTO messages VALUES('msg','s','history /Users/hapi-wwx/work is preserved',1);
INSERT INTO threads VALUES('t','/Users/hapi-wwx/work/a','/Users/hapi-wwx/.codex/sessions/r.jsonl');
SELECT 'READY';\n`);
    await ready;
    assert.ok(fs.statSync(source+'-wal').size>0);
    sqliteBackup(source,dest);
    assert.equal(sqliteIntegrity(dest),true);
    const before=historyDigest(home);
    assert.equal(before.messages,1);
    sqliteStructuredRewrite(dest);
    assert.deepEqual(historyDigest(home),before);
    const actual=JSON.parse(sql(dest,"SELECT metadata FROM sessions WHERE id='s';"));
    assert.equal(actual.path,cfg.canonicalCwd+'/a');
    assert.equal(actual.homeDir,cfg.newHome);
    assert.equal(actual.happyHomeDir,cfg.projectHome+'/.hapi');
    assert.equal(actual.note,'historical /Users/hapi-wwx/work');
    assert.equal(sql(dest,'SELECT metadata_version FROM sessions;'),'8');
    assert.equal(sql(dest,'SELECT rollout_path FROM threads;'),cfg.projectHome+'/.codex/sessions/r.jsonl');
    assert.equal(sql(dest,'SELECT cwd FROM threads;'),cfg.canonicalCwd+'/a');
  }finally{
    const done=new Promise(resolve=>writer.once('exit',resolve));writer.stdin.end();await done;
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});

test('copied links and Claude project aliases are repaired without editing transcript text',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hapi-links-test-')),original={...cfg};
  try{
    cfg.projectHome=path.join(tmp,'copy');cfg.canonicalCwd=path.join(tmp,'project');
    const oldClaude=path.join(cfg.projectHome,'.claude/projects/-Users-hapi-wwx-work');
    fs.mkdirSync(oldClaude,{recursive:true});fs.mkdirSync(path.join(cfg.projectHome,'.hapi'),{recursive:true});
    fs.writeFileSync(path.join(oldClaude,'chat.jsonl'),'historical /Users/hapi-wwx/work');
    fs.symlinkSync('/Users/hapi-wwx/.codex/sessions',path.join(cfg.projectHome,'legacy-link'));
    repairCopiedPaths([{metadata:{path:'/Users/hapi-wwx/work'}}]);
    assert.equal(fs.readlinkSync(path.join(cfg.projectHome,'legacy-link')),cfg.projectHome+'/.codex/sessions');
    const newClaude=path.join(cfg.projectHome,'.claude/projects',cfg.canonicalCwd.replace(/[^a-zA-Z0-9]/g,'-'));
    assert.equal(fs.readFileSync(path.join(newClaude,'chat.jsonl'),'utf8'),'historical /Users/hapi-wwx/work');
    const manifest=inventory(cfg.projectHome);
    assert.ok(manifest.some(f=>f.type==='link'));
    fs.writeFileSync(path.join(oldClaude,'chat.jsonl'),'changed');
    assert.notDeepEqual(inventory(cfg.projectHome),manifest);
  }finally{Object.assign(cfg,original);fs.rmSync(tmp,{recursive:true,force:true});}
});

test('thinking, pending approvals and unknown background tasks block migration',()=>{
  assert.equal(hasPendingWork({thinking:true}),true);
  assert.equal(hasPendingWork({agentState:{requests:{x:{}}}}),true);
  assert.equal(hasPendingWork({agentState:{backgroundTasks:[{id:'unknown'}]}}),true);
  assert.equal(hasPendingWork({agentState:{backgroundTasks:[{status:'completed'}],completedRequests:{x:{}}}}),false);
});

test('ordinary user cannot apply a root migration', {skip:process.getuid?.()===0},()=>{
  const result=spawnSync(process.execPath,[new URL('./migrate-single-user.mjs',import.meta.url).pathname,'--apply'],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/require root/);
});
