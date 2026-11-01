"""Read-only, credential-redacted native/origin/public performance benchmark (stdlib)."""
import argparse
import concurrent.futures
import datetime
import gzip
import hashlib
import http.client
import json
import math
import os
import pathlib
import re
import socket
import statistics
import subprocess
import time
import urllib.error
import urllib.request

READS = {'list', 'read', 'models', 'model-settings'}
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36'


def require_read(command):
    if command.get('op') not in READS:
        raise ValueError('Benchmark only permits explicit read operations')


def summary(values):
    values = sorted(values)
    if not values:
        return None
    return dict(n=len(values), median=round(statistics.median(values), 3),
                p95=round(values[max(0, math.ceil(len(values) * .95) - 1)], 3),
                mean=round(statistics.mean(values), 3),
                sampleStd=round(statistics.stdev(values), 3) if len(values) > 1 else None)


def project_response(status, raw, command):
    """Only a fixed set of measurements leaves memory; never copy response strings."""
    row = dict(status=status, decodedBytes=len(raw), ok=False)
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return {**row, 'failure': 'non-json'}
    result = data.get('result') if isinstance(data, dict) else None
    if status != 200 or not isinstance(data, dict) or data.get('ok') is not True or not isinstance(result, dict):
        return {**row, 'failure': 'http-or-native-rejection'}
    if (command['op'] == 'model-settings' or command['op'] == 'read' and not command.get('itemKey')) and result.get('id') != command.get('id'):
        return {**row, 'failure': 'identity-mismatch'}
    if command['op'] == 'read':
        if command.get('itemKey'):
            if not isinstance(result.get('item'), dict) and not isinstance(result.get('image'), dict):
                return {**row, 'failure': 'missing-detail'}
            if isinstance(result.get('item'), dict) and result['item'].get('key') != command['itemKey']:
                return {**row, 'failure': 'detail-identity-mismatch'}
        elif not result.get('unchanged') and not isinstance(result.get('turns'), list):
            return {**row, 'failure': 'missing-history'}
        row.update(unchanged=result.get('unchanged') is True,
                   items=sum(len(turn.get('items', [])) for turn in result.get('turns', [])),
                   hasEarlier=bool(result.get('hasEarlier')), live=result.get('live') is True)
        if isinstance(result.get('revision'), str):
            row['revisionSHA256'] = hashlib.sha256(result['revision'].encode()).hexdigest()
    if command['op'] == 'list':
        if not isinstance(result.get('threads'), list):
            return {**row, 'failure': 'missing-list'}
        row['threads'] = len(result['threads'])
    if command['op'] == 'models':
        if not isinstance(result.get('models'), list) or not result['models']:
            return {**row, 'failure': 'empty-catalog'}
        row['models'] = len(result['models'])
    return {**row, 'ok': True}


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self.path = os.path.expanduser(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def measure_route(route, scenarios, repetitions, access_code, timeout):
    rows = []
    proxy = route.get('proxy')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({'https': proxy, 'http': proxy} if proxy else {}))

    def request(command, token=None, auth=False):
        if not auth:
            require_read(command)
        start = time.perf_counter()
        row = dict(route=route['label'], scenario='auth' if auth else command.pop('_scenario'), op='auth' if auth else command['op'])
        headers = {'Content-Type': 'application/json', 'User-Agent': UA, 'Accept-Encoding': 'gzip'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        connection = None
        data = {}
        try:
            body = json.dumps(command).encode()
            if route.get('socket'):
                connection = UnixConnection(route['socket'], timeout)
                connection.request('POST', '/command', body, headers)
                response = connection.getresponse()
            else:
                url = route['base'].rstrip('/') + ('/api/auth' if auth else '/api/native-desktop/command')
                try:
                    response = opener.open(urllib.request.Request(url, body, headers), timeout=timeout)
                except urllib.error.HTTPError as error:
                    response = error
            with response:
                row['ttfbMs'] = round((time.perf_counter() - start) * 1000, 3)
                raw = response.read(16 * 1024 * 1024 + 1)
                row['wireBodyBytes'] = len(raw)
                if len(raw) > 16 * 1024 * 1024:
                    raise ValueError('Response limit exceeded')
                if response.headers.get('Content-Encoding') == 'gzip':
                    raw = gzip.decompress(raw)
                if auth:
                    data = json.loads(raw)
                    row.update(status=response.status, ok=response.status == 200 and isinstance(data.get('token'), str))
                else:
                    row.update(project_response(response.status, raw, command))
                    # Parsed content is used only for the next bounded read; never persisted.
                    if row['ok']:
                        data = json.loads(raw)['result']
        except Exception as error:
            row.update(ok=False, failure=type(error).__name__)
        finally:
            if connection:
                connection.close()
        row['elapsedMs'] = round((time.perf_counter() - start) * 1000, 3)
        rows.append(row)
        return data

    token = None
    if not route.get('socket'):
        if not access_code:
            return [dict(route=route['label'], scenario='auth', op='auth', ok=False, failure='missing-access-code', elapsedMs=0)]
        token = request({'accessToken': access_code}, auth=True).get('token')
        if not token:
            return rows
    for scenario in scenarios:
        for repetition in range(repetitions):
            base = {'app': scenario['app'], 'id': scenario['id']}
            def read(op, label, **extra):
                return request({**base, 'op': op, '_scenario': scenario['label'] + '/' + label, **extra}, token)
            if repetition == 0:
                read('list', 'list')
                if scenario['app'] == 'codex':
                    read('models', 'catalog')
                    read('model-settings', 'settings')
            view = read('read', 'history')
            if view and sum(len(turn.get('items', [])) for turn in view.get('turns', [])) < scenario.get('minItems', 1):
                rows[-1].update(ok=False, failure='history-corpus-empty')
                view = {}
            if view.get('revision'):
                read('read', 'incremental', since=view['revision'])
            if repetition == 0 and view.get('hasEarlier') and view.get('before'):
                read('read', 'older', before=view['before'])
            if repetition == 0:
                items = [item for turn in view.get('turns', []) for item in turn.get('items', [])]
                detail = next((item for item in items if item.get('hasDetail')), None)
                if detail:
                    # Detail responses use item identity, not conversation identity.
                    read('read', 'detail', itemKey=detail['key'])
    return rows


def evaluate(rows, routes, baseline=None):
    groups = []
    for route in routes:
        selected = [row for row in rows if row['route'] == route['label']]
        failures = sum(not row['ok'] for row in selected)
        groups.append(dict(route=route['label'], attempts=len(selected), failures=failures,
                           latencyMs=summary([row['elapsedMs'] for row in selected if row['ok'] and row['op'] != 'auth']),
                           passed=bool(selected) and not failures))
    cases = []
    for key in sorted({(row['route'], row['scenario']) for row in rows}):
        selected = [row for row in rows if (row['route'], row['scenario']) == key]
        values = [row['elapsedMs'] for row in selected if row['ok']]
        metric = summary(values)
        budget = next(route.get('budgetMs', 5000) for route in routes if route['label'] == key[0])
        passed = len(values) == len(selected) and metric is not None and metric['p95'] <= budget
        cases.append(dict(route=key[0], scenario=key[1], latencyMs=metric, budgetMs=budget, passed=passed))
    for group in groups:
        group['requestsPassed'] = group['passed']
        group['passed'] = group['requestsPassed'] and all(case['passed'] for case in cases if case['route'] == group['route'])
    regressions, incomparable, unresolved = [], [], []
    if baseline:
        current = {(case['route'], case['scenario']): case for case in cases}
        for before in baseline.get('cases', []):
            key = before['route'], before['scenario']
            after = current.get(key)
            if not before.get('latencyMs'):
                incomparable.append(dict(route=key[0], scenario=key[1], reason='baseline-has-no-successful-sample'))
            elif not after:
                regressions.append(dict(route=key[0], scenario=key[1], reason='missing-or-failed-case'))
            elif not after['passed']:
                (regressions if before['passed'] else unresolved).append(dict(route=key[0], scenario=key[1], reason='case-outside-budget-or-failed'))
            elif min(before['latencyMs']['n'], after['latencyMs']['n']) < 3:
                incomparable.append(dict(route=key[0], scenario=key[1], reason='fewer-than-three-successful-samples'))
            elif after['latencyMs']['median'] > max(before['latencyMs']['median'] * 1.2, before['latencyMs']['median'] + 50):
                regressions.append(dict(route=key[0], scenario=key[1], reason='median-regression'))
        old_revisions = {(row['route'], row['scenario']): row['revisionSHA256'] for row in baseline.get('samples', []) if row.get('revisionSHA256')}
        for row in rows:
            key = row['route'], row['scenario']
            if row.get('revisionSHA256') and key in old_revisions and row['revisionSHA256'] != old_revisions[key]:
                regressions.append(dict(route=key[0], scenario=key[1], reason='history-changed-not-comparable'))
    return dict(routes=groups, cases=cases, regressions=regressions, incomparable=incomparable, unresolved=unresolved,
                passed=bool(groups) and all(group['passed'] for group in groups) and all(case['passed'] for case in cases) and not regressions)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--baseline')
    parser.add_argument('--auth-ssh', help='Read the existing Mini owner access code in memory using this SSH alias')
    args = parser.parse_args()
    config = json.loads(pathlib.Path(args.config).read_text())
    repetitions = config.get('repetitions', 5)
    if not 3 <= repetitions <= 30 or not 1 <= len(config['routes']) <= 4 or not config['scenarios']:
        parser.error('Require 3–30 repeats, 1–4 routes, and existing conversation scenarios')
    signature = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    baseline = json.loads(pathlib.Path(args.baseline).read_text()) if args.baseline else None
    if baseline and (baseline.get('protocol') != 1 or baseline.get('configSHA256') != signature):
        parser.error('Baseline protocol/config differs; comparisons require the same scenarios and conditions')
    access_code = os.environ.get('HAPI_BENCH_ACCESS_CODE')
    if args.auth_ssh:
        if access_code or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.auth_ssh):
            parser.error('Choose one auth source and a plain SSH alias')
        registry = subprocess.run(['ssh', '-S', 'none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', args.auth_ssh,
                                   'cat ~/.local/lib/hapi-mini/data/web-access-codes.json'], capture_output=True, check=True, timeout=15)
        access_code = next((row['code'] for row in json.loads(registry.stdout)['codes'] if row['namespace'] == 'default'), None)
        if not access_code:
            parser.error('Mini owner access code unavailable')
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(config['routes'])) as pool:
        futures = [pool.submit(measure_route, route, config['scenarios'], repetitions, access_code, config.get('timeoutSeconds', 12)) for route in config['routes']]
        rows = [row for future in futures for row in future.result()]
    result = dict(protocol=1, configSHA256=signature, at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  conditions=dict(repetitions=repetitions, maxConcurrentRoutes=len(config['routes']), retries=0,
                                  note='Sequential within each route; all requests read original Apps. No model generation. Small-sample p95 is descriptive.'),
                  **evaluate(rows, config['routes'], baseline), samples=rows)
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + '\n')
    output.chmod(0o600)
    print(json.dumps({key: result[key] for key in ['routes', 'regressions', 'passed']}))
    raise SystemExit(0 if result['passed'] else 2)
