import json,subprocess,urllib.request,urllib.error
r=subprocess.run(['ssh','-S','none','-o','BatchMode=yes','mac-mini','cat ~/.local/lib/hapi-mini/data/web-access-codes.json'],capture_output=True,text=True,check=True)
codes={x['namespace']:x['code'] for x in json.loads(r.stdout)['codes']}
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
base='https://hapi.urbanclaw.net'
def req(path,body=None,jwt=None):
    headers={'Content-Type':'application/json','User-Agent':'curl/8.7.1'}
    if jwt:headers['Authorization']='Bearer '+jwt
    q=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
    try:
        with opener.open(q,timeout=20) as response:return response.status,json.loads(response.read())
    except urllib.error.HTTPError as e:return e.code,{}
checks=[]
for ns in ['default','wwx']:
    status,auth=req('/api/auth',{'accessToken':codes[ns]})
    assert status==200,(ns,status)
    status,data=req('/api/native-desktop/command',{'app':'codex','op':'projects'},auth['token'])
    assert status==(200 if ns=='default' else 403),(ns,status)
    checks.append({'identity':ns,'desktop_http':status})
    status,data=req('/api/machines',jwt=auth['token'])
    checks.append({'identity':ns,'machine_http':status,'machines':len(data.get('machines',[]))})
    if ns=='default':assert any(m.get('active') and m['id']=='40cc1516-0d86-42bf-9d60-2cc393343217' for m in data['machines'])
    else:assert len(data.get('machines',[]))==0
status,_=req('/api/auth',{'accessToken':codes['wwx']+':default'});assert status==401
checks.append({'check':'suffix-tampering','http':status})
print(json.dumps({'public_checks':checks},ensure_ascii=False,indent=2))
