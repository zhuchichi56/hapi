import hashlib,json,os,shutil,signal,subprocess
from pathlib import Path
base=Path.home()/'.local/lib/hapi-mini';receipt=json.loads((base/'orchestra-t008-receipt.json').read_text());live=base/'builds/quick-session-20261026';backup=Path(receipt['backup']);binary=base/'bin/hapi-hub'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(binary)==receipt['deployedBinarySha'],'New deployment found; refusing overwrite'
for rel,value in receipt['changedFiles'].items():assert sha(live/rel)==value,('Source changed',rel)
pids=subprocess.check_output(['/usr/sbin/lsof','-t','-nP','-iTCP:3006','-sTCP:LISTEN'],text=True).split();assert len(pids)==1
pid=int(pids[0]);cmd=subprocess.check_output(['/bin/ps','-p',str(pid),'-o','command='],text=True).strip();assert cmd.startswith(str(binary))
for rel in receipt['changedFiles']:
 old=backup/'source'/rel
 if old.exists():shutil.copy2(old,live/rel)
 else:(live/rel).unlink()
target=binary.with_name('hapi-hub.orchestra-rollback-next');shutil.copy2(backup/'hapi-hub',target);target.chmod(0o755);os.replace(target,binary);os.kill(pid,signal.SIGTERM)
print(json.dumps({'rolledBack':True,'binarySha':sha(binary),'collectorStatePreserved':True}))
