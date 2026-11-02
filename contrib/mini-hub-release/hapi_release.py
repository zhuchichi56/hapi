#!/usr/bin/env python3
"""COMPACT_RELEASE_V1: transactional updates for the existing Mini Hub only."""
import argparse
import contextlib
import ctypes
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

LABEL = 'com.zhuhe.hapi-mini'
DEFAULT_BASE = Path('/Users/zhuhe/.local/lib/hapi-mini')
DEFAULT_PLIST = Path('/Library/LaunchDaemons/com.zhuhe.hapi-mini.plist')

class Failure(Exception):
    """Messages are fixed error codes, never subprocess output or credentials."""

class Interrupted(BaseException):
    pass

def sha(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else _sha(f)

def _sha(f):
    h = hashlib.sha256()
    for b in iter(lambda: f.read(1024 * 1024), b''):
        h.update(b)
    return h.hexdigest()

def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def copy_bytes(source, target, uid, gid):
    """Always copy to a new inode; never truncate an executable in use."""
    target = Path(target)
    fd, name = tempfile.mkstemp(prefix='.copy-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as out, open(source, 'rb') as src:
            shutil.copyfileobj(src, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(name, 0o755)
        if os.geteuid() == 0:
            os.chown(name, uid, gid)
        os.replace(name, target)
        sync_directory(target.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def atomic_json(path, data):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix='.receipt-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)

@contextlib.contextmanager
def lock(path):
    # The lock file is persistent; the kernel releases its lock on process exit.
    with open(path, 'a') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure('deployment-in-progress')
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)

@contextlib.contextmanager
def catch_signals():
    def interrupted(signum, frame):
        raise Interrupted()
    old = {s: signal.signal(s, interrupted) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        yield
    finally:
        for s, handler in old.items():
            signal.signal(s, handler)

@contextlib.contextmanager
def protect_rollback():
    # A second Ctrl-C must not interrupt restoration halfway through.
    old = {s: signal.signal(s, signal.SIG_IGN) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        yield
    finally:
        for s, handler in old.items():
            signal.signal(s, handler)

class Mac:
    """Small adapter; tests replace OS/service operations, not the transaction."""
    def __init__(self, binary, plist):
        self.binary, self.plist = Path(binary), Path(plist)
        self.last_pid = None
        raw = self.plist.read_bytes()
        self.plist_sha = hashlib.sha256(raw).hexdigest()
        self.config = plistlib.loads(raw)
        c = self.config
        if c.get('Label') != LABEL or c.get('ProgramArguments', [None])[0] != str(self.binary):
            raise Failure('unexpected-service-configuration')
        account = pwd.getpwnam(c['UserName'])
        self.uid, self.gid = account.pw_uid, account.pw_gid
        env = c.get('EnvironmentVariables', {})
        if env.get('HAPI_LISTEN_HOST') != '127.0.0.1':
            raise Failure('expected-loopback-listener')
        self.port = int(env['HAPI_LISTEN_PORT'])
        self.args = c['ProgramArguments'][1:]

    def command(self, args, timeout=15):
        try:
            return subprocess.run(args, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise Failure('command-timeout-' + Path(args[0]).name)

    def require_root(self):
        if os.geteuid() != 0:
            raise Failure('administrator-required')

    def check_plist(self):
        if sha(self.plist) != self.plist_sha:
            raise Failure('service-configuration-changed')

    def verify(self, binary):
        if not os.access(binary, os.X_OK):
            raise Failure('candidate-not-executable')
        with open(binary, 'rb') as f:
            header = f.read(8)
        # This deployment targets the existing thin arm64 Mini Hub.
        if len(header) != 8 or struct.unpack('<II', header) != (0xfeedfacf, 0x0100000c):
            raise Failure('candidate-not-arm64-macho')
        if self.command(['/usr/bin/codesign', '--verify', '--strict', str(binary)]).returncode:
            raise Failure('candidate-signature-invalid')

    def service_state(self):
        r = self.command(['/bin/launchctl', 'print', 'system/' + LABEL])
        if r.returncode:
            # Do not mistake authorization/transport errors for an absent service.
            if b'Could not find service' in r.stderr or b'Could not find service' in r.stdout:
                return False, None
            raise Failure('service-state-unreadable')
        m = re.search(rb'^\s*pid = (\d+)\s*$', r.stdout, re.M)
        return True, int(m[1]) if m else None

    def service_pid(self):
        return self.service_state()[1]

    def alive(self, pid):
        if not pid:
            return False
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False

    def assert_pid(self, pid):
        buf = ctypes.create_string_buffer(4096)
        lib = ctypes.CDLL('/usr/lib/libproc.dylib')
        n = lib.proc_pidpath(pid, buf, len(buf))
        if n <= 0 or Path(os.fsdecode(buf.value)).resolve() != self.binary.resolve():
            raise Failure('unexpected-service-process')

    def stop(self):
        pid = self.service_pid()
        if pid:
            self.assert_pid(pid)
            self.last_pid = pid
        pid = pid or self.last_pid
        r = self.command(['/bin/launchctl', 'bootout', 'system/' + LABEL])
        # bootout may report an already-unregistered job after a rejected launch.
        if r.returncode and self.service_state()[0]:
            raise Failure('bootout-failed')
        end = time.monotonic() + 12
        while self.alive(pid):
            if time.monotonic() >= end:
                raise Failure('old-process-did-not-exit')
            time.sleep(0.1)
        if self.service_state()[0]:
            raise Failure('service-still-registered')
        self.last_pid = None

    def start(self):
        self.check_plist()
        if self.command(['/bin/launchctl', 'bootstrap', 'system', str(self.plist)]).returncode:
            raise Failure('bootstrap-failed')

    def http(self, port):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        origin = 'http://127.0.0.1:' + str(port)
        def get(path, maximum):
            with opener.open(origin + path, timeout=2) as r:
                body = r.read(maximum + 1)
                if r.status != 200 or len(body) > maximum:
                    raise Failure('invalid-http-response')
                return body, r.headers.get('Content-Type', '')
        health, _ = get('/health', 65536)
        data = json.loads(health)
        if data.get('status') != 'ok' or not isinstance(data.get('protocolVersion'), int):
            raise Failure('invalid-health-json')
        html, mime = get('/desktop', 1024 * 1024)
        if 'text/html' not in mime:
            raise Failure('invalid-desktop-page')
        match = re.search(rb'<script\b[^>]*\bsrc=["\']([^"\']+)["\']', html)
        if not match:
            raise Failure('missing-desktop-script')
        asset = match[1].decode('utf-8')
        parts = urllib.parse.urlsplit(asset)
        if parts.scheme or parts.netloc or not parts.path.startswith('/assets/') or '..' in parts.path:
            raise Failure('invalid-desktop-script-path')
        js, mime = get(asset, 16 * 1024 * 1024)
        if not js or ('javascript' not in mime and 'ecmascript' not in mime):
            raise Failure('invalid-desktop-script')
        return {'htmlSHA256': hashlib.sha256(html).hexdigest(),
                'assetSHA256': hashlib.sha256(js).hexdigest(), 'protocolVersion': data['protocolVersion']}

    def ready(self, expected=None, timeout=30, stable=3):
        end, since, last_pid = time.monotonic() + timeout, None, None
        while time.monotonic() < end:
            try:
                pid = self.service_pid()
                if not pid:
                    raise Failure('service-not-running')
                self.assert_pid(pid)
                listener = self.command(['/usr/sbin/lsof', '-t', '-nP', '-iTCP:' + str(self.port), '-sTCP:LISTEN'])
                if set(listener.stdout.split()) != {str(pid).encode()}:
                    raise Failure('listener-identity-mismatch')
                content = self.http(self.port)
                if expected is not None and content != expected:
                    raise Failure('deployed-content-mismatch')
                if pid != last_pid or since is None:
                    since, last_pid = time.monotonic(), pid
                if time.monotonic() - since >= stable:
                    return {'pid': pid, **content}
            except (Failure, OSError, ValueError):
                since = None
            time.sleep(0.2)
        raise Failure('readiness-timeout')

    def probe(self, candidate):
        # Candidate gets a fresh home/database and no production auth or provider env.
        with tempfile.TemporaryDirectory(prefix='hapi-release-probe-') as root:
            if os.geteuid() == 0:
                os.chown(root, self.uid, self.gid)
            with socket.socket() as s:
                s.bind(('127.0.0.1', 0))
                port = s.getsockname()[1]
            env = {'HOME': root, 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
                   'HAPI_HOME': root + '/data', 'DB_PATH': root + '/data/hapi.db',
                   'HAPI_LISTEN_HOST': '127.0.0.1', 'HAPI_LISTEN_PORT': str(port),
                   'HAPI_PUBLIC_URL': 'http://127.0.0.1:' + str(port),
                   'HAPI_READY_NOTIFICATION': 'false', 'TELEGRAM_NOTIFICATION': 'false',
                   'SERVERCHAN_NOTIFICATION': 'false', 'HAPI_IOS_PUSH': 'off', 'HAPI_ANDROID_PUSH': 'off'}
            def drop_user():
                if os.geteuid() == 0:
                    os.setgroups([])
                    os.setgid(self.gid)
                    os.setuid(self.uid)
            process = subprocess.Popen([str(candidate), '--no-relay'], env=env, cwd=root,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, start_new_session=True, preexec_fn=drop_user)
            try:
                end = time.monotonic() + 25
                while time.monotonic() < end:
                    if process.poll() is not None:
                        raise Failure('candidate-exited')
                    try:
                        result = self.http(port)
                        listeners = self.command(['/usr/sbin/lsof', '-t', '-nP',
                                                  '-iTCP:' + str(port), '-sTCP:LISTEN'])
                        if set(listeners.stdout.split()) != {str(process.pid).encode()}:
                            raise Failure('candidate-listener-identity-mismatch')
                        time.sleep(0.25)
                        if process.poll() is None:
                            return result
                    except (Failure, OSError, ValueError):
                        pass
                    time.sleep(0.2)
                raise Failure('candidate-probe-timeout')
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)

class Release:
    def __init__(self, base=DEFAULT_BASE, plist=DEFAULT_PLIST, platform=None):
        self.base, self.binary = Path(base), Path(base) / 'bin/hapi-hub'
        self.state = self.base / 'release-state'
        self.os = platform or Mac(self.binary, plist)

    def directories(self):
        for p in (self.state, self.state / 'receipts', self.state / 'snapshots'):
            p.mkdir(mode=0o700, parents=True, exist_ok=True)
            if os.geteuid() == 0:
                os.chown(p, self.os.uid, self.os.gid)

    def guard(self, expected):
        if not expected or not re.fullmatch('[0-9a-f]{64}', expected):
            raise Failure('expected-current-sha-required')
        if self.binary.is_symlink() or sha(self.binary) != expected:
            raise Failure('live-binary-drift')
        self.os.check_plist()

    @contextlib.contextmanager
    def stage(self, candidate):
        candidate = Path(candidate)
        if not candidate.is_file() or candidate.is_symlink():
            raise Failure('invalid-candidate-path')
        with tempfile.TemporaryDirectory(prefix='.release-stage-', dir=self.binary.parent) as root:
            if os.geteuid() == 0:
                os.chown(root, self.os.uid, self.os.gid)
            stage = Path(root) / 'hapi-hub'
            before = sha(candidate)
            copy_bytes(candidate, stage, self.os.uid, self.os.gid)
            if sha(stage) != before or sha(candidate) != before:
                raise Failure('candidate-changed-while-copying')
            self.os.verify(stage)
            yield stage

    def preflight(self, candidate, expected=None):
        self.directories()
        with lock(self.state / 'deploy.lock'):
            if expected:
                self.guard(expected)
            with self.stage(candidate) as stage:
                content = self.os.probe(stage)
                return {'result': 'preflight-passed', 'candidateSHA256': sha(stage), 'content': content}

    def deploy(self, candidate, expected, reinstall=False, intent='deploy'):
        receipt = {'id': datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8],
                   'startedAt': timestamp(), 'intent': intent, 'result': 'rejected', 'steps': []}
        stopped, old_content, backup = False, None, None
        path = self.state / 'receipts' / (receipt['id'] + '.json')
        receipt['receiptPath'] = str(path)
        def save_receipt():
            atomic_json(path, receipt)
            if os.geteuid() == 0:
                os.chown(path, self.os.uid, self.os.gid)
        def step(name):
            receipt['steps'].append({'name': name, 'at': timestamp()})
            save_receipt()
        self.os.require_root()  # Fail before writing or stopping anything.
        self.directories()
        with lock(self.state / 'deploy.lock'), catch_signals():
            try:
                self.guard(expected)
                receipt['beforeSHA256'] = expected
                receipt['plistSHA256'] = self.os.plist_sha
                with self.stage(candidate) as stage:
                    receipt['afterSHA256'] = sha(stage)
                    if receipt['afterSHA256'] == expected and not reinstall:
                        raise Failure('same-version-use-reinstall')
                    candidate_content = self.os.probe(stage)
                    if sha(stage) != receipt['afterSHA256']:
                        raise Failure('candidate-changed-during-probe')
                    self.os.verify(stage)
                    step('candidate-preflight-passed')
                    old_content = self.os.ready(stable=0)
                    receipt['oldPID'] = old_content['pid']
                    saved = self.state / 'snapshots' / receipt['id']
                    saved.mkdir(mode=0o700)
                    if os.geteuid() == 0:
                        os.chown(saved, self.os.uid, self.os.gid)
                    backup = saved / 'hapi-hub'
                    copy_bytes(self.binary, backup, self.os.uid, self.os.gid)
                    if sha(backup) != expected:
                        raise Failure('snapshot-hash-mismatch')
                    self.os.verify(backup)
                    self.guard(expected)  # Recheck after the potentially slow probe.
                    receipt['snapshot'] = str(backup)
                    start = time.monotonic()
                    receipt['result'] = 'updating'
                    step('bootout-started')
                    stopped = True  # bootout can succeed even if its reply is interrupted.
                    self.os.stop()
                    self.guard(expected)
                    copy_bytes(stage, self.binary, self.os.uid, self.os.gid)
                    if sha(self.binary) != receipt['afterSHA256']:
                        raise Failure('installed-hash-mismatch')
                    step('candidate-installed')
                    self.os.start()
                    verified = self.os.ready(expected=candidate_content)
                    if verified['pid'] == receipt['oldPID']:
                        raise Failure('old-pid-still-running')
                    receipt.update(result='deployed', newPID=verified['pid'], content=candidate_content,
                                   recoverySeconds=round(time.monotonic() - start, 3))
                    step('candidate-ready')
            except (Exception, Interrupted, KeyboardInterrupt) as error:
                receipt['error'] = str(error) if isinstance(error, Failure) else type(error).__name__
                receipt['result'] = 'rejected'
                if stopped:
                    with protect_rollback():
                        try:
                            self.os.check_plist()
                            # Stop any partially started replacement before restoring bytes.
                            self.os.stop()
                            if sha(backup) != expected:
                                raise Failure('rollback-snapshot-changed')
                            # A non-cooperating deployment must never be overwritten silently.
                            if sha(self.binary) not in (expected, receipt['afterSHA256']):
                                raise Failure('live-binary-drift-during-rollback')
                            copy_bytes(backup, self.binary, self.os.uid, self.os.gid)
                            self.os.start()
                            content = {k: v for k, v in old_content.items() if k != 'pid'}
                            verified = self.os.ready(expected=content)
                            receipt.update(result='rolled-back', rollbackPID=verified['pid'])
                            step('rollback-ready')
                        except (Exception, Interrupted, KeyboardInterrupt) as rollback_error:
                            receipt.update(result='rollback-failed', rollbackError=str(rollback_error)
                                           if isinstance(rollback_error, Failure) else type(rollback_error).__name__)
            finally:
                receipt['finishedAt'] = timestamp()
                save_receipt()
        return receipt

    def rollback(self, receipt_path, expected):
        path = Path(receipt_path).resolve()
        if path.parent != (self.state / 'receipts').resolve():
            raise Failure('receipt-outside-release-state')
        data = json.loads(path.read_text())
        if data.get('result') != 'deployed' or not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}', data.get('id', '')):
            raise Failure('invalid-rollback-receipt')
        backup = self.state / 'snapshots' / data['id'] / 'hapi-hub'
        if backup.is_symlink() or sha(backup) != data['beforeSHA256']:
            raise Failure('rollback-snapshot-changed')
        return self.deploy(backup, expected, reinstall=True, intent='manual-rollback')

    def status(self):
        self.os.check_plist()
        info = self.os.ready(stable=0)
        return {'result': 'running', 'binarySHA256': sha(self.binary),
                'plistSHA256': self.os.plist_sha, **info}

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base', type=Path, default=DEFAULT_BASE)
    p.add_argument('--plist', type=Path, default=DEFAULT_PLIST)
    sub = p.add_subparsers(dest='command', required=True)
    pre = sub.add_parser('preflight', help='verify and start candidate in an isolated temporary home')
    pre.add_argument('--candidate', required=True, type=Path)
    pre.add_argument('--expected-current-sha')
    deploy = sub.add_parser('deploy', help='requires administrator; auto-rolls back on launch failure')
    deploy.add_argument('--candidate', required=True, type=Path)
    deploy.add_argument('--expected-current-sha', required=True)
    deploy.add_argument('--reinstall', action='store_true')
    sub.add_parser('status')
    rollback = sub.add_parser('rollback', help='restore exact snapshot through the same release transaction')
    rollback.add_argument('--receipt', required=True, type=Path)
    rollback.add_argument('--expected-current-sha', required=True)
    a = p.parse_args(argv)
    try:
        release = Release(a.base, a.plist)
        if a.command == 'preflight':
            result = release.preflight(a.candidate, a.expected_current_sha)
        elif a.command == 'deploy':
            result = release.deploy(a.candidate, a.expected_current_sha, a.reinstall)
        elif a.command == 'rollback':
            result = release.rollback(a.receipt, a.expected_current_sha)
        else:
            result = release.status()
    except (Exception, Interrupted, KeyboardInterrupt) as e:
        result = {'result': 'rejected', 'error': str(e) if isinstance(e, Failure) else type(e).__name__}
    print(json.dumps(result, indent=2))
    return {'deployed': 0, 'running': 0, 'preflight-passed': 0, 'rolled-back': 1,
            'rejected': 2, 'rollback-failed': 3}[result['result']]

if __name__ == '__main__':
    raise SystemExit(main())
