import os,json,pathlib
base=pathlib.Path.home()/'.local/lib/hapi-mini';root=base/'projects/wwx/home/work';out=base/'wwx-consolidation-20261101'
original=json.loads((out/'workspace-audit.json').read_text())
mapping={
 '/Users/zhuhe/overleaf/router':root/'.hapi-imports/overleaf-router',
 '/Users/zhuhe/wwx':root,
 '/Users/zhuhe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules':root/'.hapi-imports/node_modules',
 '/Users/zhuhe/claude-dotfiles-mt/skills/related-work':root/'.hapi-imports/skills/related-work',
 '/Users/zhuhe/claude-dotfiles-mt/skills/make-research-figures':root/'.hapi-imports/skills/make-research-figures',
 '/Users/zhuhe/.codex/plugins/cache/openai-primary-runtime/pdf/26.1025.11240/skills/pdf':root/'.hapi-imports/skills/pdf',
 '/Users/zhuhe/.local/share/uv/python/cpython-3.12-macos-aarch64-none':root/'.hapi-imports/python/3.12',
 '/Users/zhuhe/.local/share/uv/python/cpython-3.14-macos-aarch64-none':root/'.hapi-imports/python/3.14',
}
changed=[]
for entry in original['broken']:
 p=root/entry['path'];target=entry['target']
 if not p.is_symlink() or os.readlink(p)!=target:raise RuntimeError('Link changed during migration')
 for old,new in mapping.items():
  if target==old or target.startswith(old+'/'):
   resolved=new/target[len(old):].lstrip('/')
   if not resolved.exists():raise RuntimeError('Mapped dependency missing: '+str(resolved))
   temporary=p.with_name(p.name+'.wwx-migration-next')
   temporary.symlink_to(os.path.relpath(resolved,p.parent));temporary.replace(p)
   changed.append({'path':entry['path'],'before':target,'after':os.readlink(p)})
   break
# Preserve the generated venv configuration while mapping only path-valued settings.
configs=[]
for rel,version in [('neural-interfaces26/.venv','3.12'),('output/eeg-foundation-survey-20261026/runtime','3.14'),('output/routerxbench-jev-test-20261011/.venv','3.12')]:
 p=root/rel/'pyvenv.cfg'
 if p.exists():
  content=p.read_text();backup=out/'venv-config-before'/rel/'pyvenv.cfg';backup.parent.mkdir(parents=True,exist_ok=True);backup.write_text(content)
  lines=[]
  for line in content.splitlines():
   if line.startswith('home = '):line='home = '+str(root/'.hapi-imports/python'/version/'bin')
   lines.append(line)
  p.write_text('\n'.join(lines)+'\n');configs.append(rel)
broken=[]
for folder,dirs,files in os.walk(root,followlinks=False):
 dirs[:]=[d for d in dirs if d not in ['.git','node_modules','.venvs','.hapi-history','__pycache__']]
 for name in dirs+files:
  p=pathlib.Path(folder)/name
  if p.is_symlink() and not p.exists():broken.append(str(p.relative_to(root)))
result={'repairedLinks':changed,'venvConfigs':configs,'remainingBroken':broken}
(out/'workspace-relocation.json').write_text(json.dumps(result,indent=2));(out/'workspace-relocation.json').chmod(0o600)
print(json.dumps({'repairedLinks':len(changed),'remainingBroken':broken}))
if broken:raise RuntimeError('Broken project dependency links remain')
