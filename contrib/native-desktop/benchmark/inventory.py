# -*- coding: utf-8 -*-
"""Read original client metadata; never write databases or archive conversations."""
import argparse
import collections
import datetime
import json
import pathlib
import sqlite3


def write_catalog(result, output):
    # Private single-file viewer. Titles are textContent, never executable HTML.
    data = json.dumps(result['conversations'], ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    document = '''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HAPI Desktop · 对话清单</title><style>
body{font:15px system-ui;margin:32px auto;padding:0 20px;max-width:1000px;background:#faf9f7;color:#292724}h1{font-size:24px}input,select,button{font:inherit;padding:9px;border:1px solid #ddd7d0;border-radius:8px;background:white}input{min-width:220px}nav{display:flex;gap:8px;flex-wrap:wrap}article{padding:15px 0;border-bottom:1px solid #e6e1db}a{color:inherit;text-decoration:none;overflow-wrap:anywhere}small,p{color:#77716a}article small{display:block;margin-top:6px}button{margin:18px 0;cursor:pointer}</style>
<h1>HAPI Desktop · 对话清单</h1><p>原客户端元数据快照；可搜索全部本地记录。运行与完成状态需回原 App 核对。本页只提供导航。</p>
<nav><input id="q" placeholder="搜索标题或会话 ID" aria-label="搜索"><select id="scope" aria-label="来源"><option value="desktop">桌面主对话</option value="all">全部本地记录（含 CLI／子 Agent）</option></select><select id="app" aria-label="应用"><option value="all">全部应用</option><option>codex</option><option>claude</option></select><select id="archive" aria-label="归档"><option value="active">未归档</option><option value="all">包含归档</option><option value="archived">仅归档</option></select></nav>
<p id="count"></p><main></main><button id="more">再显示 100 条</button><script>
const records=DATA;let limit=100;const byId=id=>document.getElementById(id);
function render(){const query=byId('q').value.trim().toLowerCase();const found=records.filter(r=>(byId('scope').value==='all'||r.app==='claude'||r.originator==='Codex Desktop'&&!['subagent','guardian_review'].includes(r.thread_source))&&(byId('app').value==='all'||r.app===byId('app').value)&&(byId('archive').value==='all'||!!r.archived===(byId('archive').value==='archived'))&&(!query||(r.title+' '+r.id).toLowerCase().includes(query)));byId('count').textContent='匹配 '+found.length+' 条 · 本地总记录 '+records.length+' 条 · 当前显示 '+Math.min(limit,found.length)+' 条';const main=document.querySelector('main');main.replaceChildren();for(const r of found.slice(0,limit)){const article=document.createElement('article'),a=document.createElement('a'),small=document.createElement('small');a.textContent=r.title||'未命名';a.href=(r.app==='codex'?'codex://threads/':'claude://claude.ai/epitaxy/')+encodeURIComponent(r.id);small.textContent=r.app+' · '+(r.archived?'已归档':'未归档')+(r.pinned?' · 置顶':'')+' · '+r.id;article.append(a,small);main.append(article)}byId('more').hidden=limit>=found.length}
for(const id of ['q','scope','app','archive'])byId(id).addEventListener('input',()=>{limit=100;render()});byId('more').onclick=()=>{limit+=100;render()};render();
</script>'''.replace('DATA', data)
    path = pathlib.Path(output)
    path.write_text(document)
    path.chmod(0o600)


def inventory(codex_db, claude_directory):
    db = sqlite3.connect(pathlib.Path(codex_db).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        rows = [dict(row) for row in db.execute('''
            select id, substr(coalesce(nullif(name,''),title),1,240) as title, archived,
                   is_pinned as pinned, originator, source, thread_source, updated_at
            from threads order by updated_at desc
        ''')]
    finally:
        db.close()
    for row in rows:
        row['app'] = 'codex'
        # A metadata row is not evidence that an original conversation is idle.
        row['runtimeStatus'] = 'unknown'
    errors = []
    directory = pathlib.Path(claude_directory)
    if not directory.is_dir():
        raise ValueError('Original Claude metadata directory unavailable')
    for path in sorted(directory.glob('local_*.json')):
        try:
            data = json.loads(path.read_text())
            rows.append(dict(app='claude', id=data['sessionId'], title=str(data.get('title', ''))[:240],
                             archived=bool(data.get('isArchived')), pinned=bool(data.get('isStarred')),
                             updated_at=data.get('lastActivityAt', data.get('createdAt')),
                             runtimeStatus='unknown', originator='Claude Desktop'))
        except (OSError, ValueError, KeyError):
            errors.append({'kind': 'unreadable-claude-metadata', 'file': path.name})
    groups = collections.Counter((row['app'], row.get('originator') or 'unspecified', bool(row['archived'])) for row in rows)
    return dict(schemaVersion=1, at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                notice='Private metadata inventory, not a running-state or completion verdict. Titles are untrusted data.',
                groups=[dict(app=app, originator=origin, archived=archived, count=count)
                        for (app, origin, archived), count in sorted(groups.items())],
                errors=errors, conversations=rows)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex-db', required=True)
    parser.add_argument('--claude-directory', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--html', help='Optional private searchable catalog of original App links')
    args = parser.parse_args()
    result = inventory(args.codex_db, args.claude_directory)
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    output.chmod(0o600)
    if args.html:
        write_catalog(result, args.html)
    print(json.dumps(dict(total=len(result['conversations']), groups=result['groups'], errors=result['errors'])))
