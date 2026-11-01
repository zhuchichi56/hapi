#!/usr/bin/env python3
"""Apply only the scoped Orchestra integration to a current HAPI source copy.

Fails on a missing/ambiguous marker; never copies an old source tree.
"""
from pathlib import Path
import sys
root=Path(sys.argv[1])
def change(rel,old,new):
 p=root/rel;s=p.read_text();assert s.count(old)==1,(rel,s.count(old));p.write_text(s.replace(old,new))
change('web/src/components/nativeDesktop/navigation.ts',"{ app: DesktopApp; thread?: string }", "{ app: DesktopApp; thread?: string; view?: 'orchestra' }")
change('web/src/components/nativeDesktop/navigation.ts',"        app: search.app === 'claude' ? 'claude' : 'codex',", "        app: search.app === 'claude' ? 'claude' : 'codex',\n        ...(search.view === 'orchestra' ? { view: 'orchestra' as const } : {}),")
change('web/src/routes/nativeDesktop.tsx', "import './nativeDesktop.css'", "import './nativeDesktop.css'\nimport { OrchestraBoard } from '@/components/nativeDesktop/OrchestraBoard'")
change('web/src/routes/nativeDesktop.tsx','export default function NativeDesktopPage() {', "export default function NativeDesktopPage() {\n    const { view } = useSearch({ from: '/desktop' })\n    return view === 'orchestra' ? <OrchestraBoard /> : <NativeDesktopChat />\n}\n\nfunction NativeDesktopChat() {")
p=root/'web/src/routes/nativeDesktop.tsx';s=p.read_text();lines=s.splitlines(True);matches=[i for i,l in enumerate(lines) if '<header className="nd-side-head">' in l];assert len(matches)==1;lines.insert(matches[0]+1,'            <a className="nd-orchestra-entry" href="/desktop?app=codex&view=orchestra">任务总控 ↗</a>\n');p.write_text(''.join(lines))
change('hub/src/web/server.ts',"import { createNativeDesktopRoutes } from './routes/nativeDesktop'", "import { createNativeDesktopRoutes } from './routes/nativeDesktop'\nimport { createOrchestraRoutes } from './routes/orchestra'")
change('hub/src/web/server.ts',"    app.route('/api', createNativeDesktopRoutes())", "    app.route('/api', createNativeDesktopRoutes())\n    app.route('/api', createOrchestraRoutes())")
p=root/'web/src/routes/nativeDesktop.css';p.write_text(p.read_text()+'\n.nd-orchestra-entry { display: block; padding: 10px 16px; color: inherit; font: inherit; text-decoration: none; border-bottom: 1px solid rgba(128,128,128,.15); }\n.nd-orchestra-entry:hover { background: rgba(128,128,128,.10); }\n')
