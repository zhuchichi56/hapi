#!/usr/bin/env python3
"""Install the deterministic local collector; never creates or resumes a model chat."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import time

HOME_DIR = Path.home()
PROGRAM = HOME_DIR / '.local/lib/codex-orchestra'
STATE = HOME_DIR / '.local/state/codex-orchestra'
LABEL = 'com.zhuhe.codex-orchestra'
TUNNEL = LABEL + '-mini-tunnel'
AGENTS = HOME_DIR / 'Library/LaunchAgents'

def call(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)

def plist(label, args):
    return {'Label': label, 'ProgramArguments': args, 'RunAtLoad': True,
            'KeepAlive': True, 'ThrottleInterval': 10, 'Umask': 63,
            'StandardOutPath': str(STATE / (label + '.log')),
            'StandardErrorPath': str(STATE / (label + '.stderr.log')),
            'WorkingDirectory': str(PROGRAM)}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['install', 'start', 'stop', 'restart', 'status'])
    p.add_argument('--mini-tunnel', action='store_true', help='also manage the dedicated private Mini socket forward')
    args = p.parse_args()
    labels = [LABEL] + ([TUNNEL] if args.mini_tunnel else [])
    domain = f'gui/{os.getuid()}'
    if args.action == 'install':
        source = Path(__file__).resolve().parent
        uv = shutil.which('uv') or str(HOME_DIR / '.local/bin/uv')
        python = call(uv, 'python', 'find').stdout.strip()
        for path in [PROGRAM, STATE, AGENTS, HOME_DIR / '.local/bin']:
            path.mkdir(parents=True, exist_ok=True)
        STATE.chmod(0o700)
        if source != PROGRAM:
            shutil.copytree(source / 'orchestra', PROGRAM / 'orchestra', dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
            for name in ['orchestra.py', 'install.py']:
                shutil.copy2(source / name, PROGRAM / name)
        wrapper = '#!/bin/sh\nexec ' + ' '.join(map(shlex.quote, [uv, 'run', '--offline', '--no-project', '--python', python, str(PROGRAM / 'orchestra.py'), '--state', str(STATE)])) + ' "$@"\n'
        cli = HOME_DIR / '.local/bin/codex-orchestra'
        cli.write_text(wrapper); cli.chmod(0o755)
        data = plist(LABEL, [uv, 'run', '--offline', '--no-project', '--python', python, str(PROGRAM / 'orchestra.py'), '--state', str(STATE), 'serve', '--socket', str(STATE / 'snapshot.sock'), '--enable-archive-run'])
        (AGENTS / (LABEL + '.plist')).write_bytes(plistlib.dumps(data))
        if args.mini_tunnel:
            remote = str(HOME_DIR / '.local/lib/hapi-mini/desktop/orchestra.sock')
            ssh = ['/usr/bin/ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes', '-o', 'StreamLocalBindMask=0177', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-R', remote + ':' + str(STATE / 'snapshot.sock'), 'mac-mini']
            (AGENTS / (TUNNEL + '.plist')).write_bytes(plistlib.dumps(plist(TUNNEL, ssh)))
        print(json.dumps({'installed': str(PROGRAM), 'state': str(STATE), 'cli': str(cli), 'started': False, 'labels': labels}))
        return
    result = []
    for label in labels:
        target = domain + '/' + label
        file = str(AGENTS / (label + '.plist'))
        if args.action in ('stop', 'restart'):
            call('launchctl', 'bootout', target, check=False)
            # bootout returns before launchd necessarily removes the service.
            deadline = time.monotonic() + 6
            while call('launchctl', 'print', target, check=False).returncode == 0:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f'{label} did not unload; inspect before retry')
                time.sleep(.1)
        if args.action in ('start', 'restart'):
            existing = call('launchctl', 'print', target, check=False)
            if existing.returncode != 0:
                call('launchctl', 'bootstrap', domain, file)
        check = call('launchctl', 'print', target, check=False)
        # launchctl output contains local paths only; keep status compact.
        pid = next((line.strip() for line in check.stdout.splitlines() if line.strip().startswith('pid =')), None)
        result.append({'label': label, 'loaded': check.returncode == 0, 'pid': pid})
    print(json.dumps(result))

if __name__ == '__main__':
    main()
