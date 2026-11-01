import hashlib,json,os,shutil,signal,subprocess
from pathlib import Path
base=Path.home()/'.local/lib/hapi-mini';live=base/'builds/quick-session-20261026';stage=base/'builds/codex-orchestra-t008-20261102'
expected='26367f6955fd8700a3fed3abfa59e570a4ac1c5db9f0e6f275f18a36c5ab2eff'
sha=lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
changed=['web/src/components/nativeDesktop/navigation.ts','web/src/routes/nativeDesktop.tsx','web/src/routes/nativeDesktop.css','hub/src/web/server.ts']
new=['web/src/components/nativeDesktop/OrchestraBoard.tsx','web/src/components/nativeDesktop/OrchestraBoard.css','hub/src/web/routes/orchestra.ts']
manifest={};diffs=[]
for folder in ['web/src','hub/src','shared/src']:
 for p in (live/folder).rglob('*'):
  if not p.is_file() or '.before-' in p.name or p.name.endswith(('.test.ts','.test.tsx')) or p.name=='embeddedAssets.generated.ts':continue
  rel=p.relative_to(live).as_posix()
  if rel in changed:continue
  manifest[rel]=sha(p)
  if not (stage/rel).exists() or sha(stage/rel)!=sha(p):diffs.append(rel)
for rel in ['web/index.html','web/vite.config.ts','web/.env.local','web/package.json','hub/package.json','package.json','bun.lock']:
 if (live/rel).exists():
  manifest[rel]=sha(live/rel)
  if not (stage/rel).exists() or sha(stage/rel)!=sha(live/rel):diffs.append(rel)
assert not diffs,('Untouched source changed',diffs)
binary=base/'bin/hapi-hub';assert sha(binary)==expected,'Production binary changed; reconcile first'
backup=base/'orchestra-t008-backup-20261102';assert not backup.exists(),'Deploy already attempted; inspect receipt'
pids=subprocess.check_output(['/usr/sbin/lsof','-t','-nP','-iTCP:3006','-sTCP:LISTEN'],text=True).split();assert len(pids)==1
pid=int(pids[0]);cmd=subprocess.check_output(['/bin/ps','-p',str(pid),'-o','command='],text=True).strip();assert cmd.startswith(str(binary))
backup.mkdir();shutil.copy2(binary,backup/'hapi-hub')
for rel in changed:
 target=backup/'source'/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(live/rel,target)
for rel in changed+new:
 target=live/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(stage/rel,target)
nextbin=base/'bin/hapi-hub.orchestra-next';shutil.copy2(stage/'hapi-hub.orchestra-t008',nextbin);nextbin.chmod(0o755);os.replace(nextbin,binary)
receipt={'task':'T008','baseBinarySha':expected,'deployedBinarySha':sha(binary),'backup':str(backup),'sourceFilesChecked':len(manifest),'untouchedSourceMismatches':diffs,'changedFiles':{r:sha(live/r) for r in changed+new},'reloadedExactListener':pid,'buildDirectory':str(stage)}
(base/'orchestra-t008-receipt.json').write_text(json.dumps(receipt,indent=2));os.kill(pid,signal.SIGTERM)
print(json.dumps(receipt,indent=2))
