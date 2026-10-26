#!/bin/zsh
/usr/bin/python3 - <<'PYCODE'
import json, subprocess, sys
try:
    r = subprocess.run(['ssh','-S','none','-o','BatchMode=yes','-o','ConnectTimeout=10','mac-mini',
        'cat ~/.local/lib/hapi-mini/data/web-access-codes.json'],capture_output=True,text=True,check=True,timeout=15)
    entries=json.loads(r.stdout)['codes']
    code=next(x['code'] for x in entries if x['namespace']=='wwx')
    subprocess.run(['/usr/bin/pbcopy'],input=code,text=True,check=True)
    print('WWX 专用（不能访问桌面）'+' HAPI 登录码已复制。请在 https://hapi.urbanclaw.net/ 粘贴登录。')
except Exception:
    print('未复制：连接 Mini 或读取登录码失败；没有修改凭据。',file=sys.stderr)
    sys.exit(1)
PYCODE
