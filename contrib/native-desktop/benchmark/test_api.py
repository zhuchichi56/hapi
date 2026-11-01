import json
import unittest
from api import evaluate, measure_route, project_response, require_read, summary


class BenchmarkTests(unittest.TestCase):
    def test_summary_small_sample_is_explicit(self):
        self.assertIsNone(summary([]))
        self.assertEqual(summary([9, 1, 5])['median'], 5)
        self.assertEqual(summary([9, 1, 5])['p95'], 9)
        self.assertIsNone(summary([1])['sampleStd'])

    def test_redaction_and_identity(self):
        raw = json.dumps({'ok': True, 'result': {'id': 'original', 'turns': [{'items': [{'text': 'PRIVATE_CONTENT', 'output': 'PRIVATE_TOKEN'}]}]}}).encode()
        result = project_response(200, raw, {'op': 'read', 'id': 'original'})
        self.assertTrue(result['ok'])
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertFalse(project_response(200, raw, {'op': 'read', 'id': 'different'})['ok'])
        self.assertFalse(project_response(502, b'<html>PRIVATE</html>', {'op': 'list'})['ok'])

    def test_native_error_is_failure_not_zero_latency_success(self):
        result = project_response(409, b'{"ok":false,"error":"PRIVATE_TOKEN"}', {'op': 'list'})
        self.assertFalse(result['ok'])
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertFalse(project_response(200, b'{"ok":true,"result":{"models":[]}}', {'op': 'models'})['ok'])

    def test_detail_identity_has_own_shape(self):
        raw = b'{"ok":true,"result":{"item":{"key":"key","output":"PRIVATE"}}}'
        self.assertTrue(project_response(200, raw, {'op': 'read', 'id': 'original', 'itemKey': 'key'})['ok'])
        self.assertFalse(project_response(200, raw, {'op': 'read', 'id': 'original', 'itemKey': 'other'})['ok'])

    def test_empty_missing_failure_budget_and_comparison_fail(self):
        routes = [{'label': 'local', 'budgetMs': 100}]
        self.assertFalse(evaluate([], routes)['passed'])
        rows = [dict(route='local', scenario='history', op='read', ok=True, elapsedMs=50)] * 3
        before = evaluate(rows, routes)
        self.assertTrue(before['passed'])
        self.assertFalse(evaluate([{**rows[0], 'ok': False}], routes)['passed'])
        self.assertFalse(evaluate([{**rows[0], 'elapsedMs': 101}], routes)['passed'])
        self.assertFalse(evaluate([{**rows[0], 'scenario': 'other'}], routes, before)['passed'])
        self.assertFalse(evaluate([{**rows[0], 'elapsedMs': 110}]*3, [{'label': 'local', 'budgetMs': 1000}], before)['passed'])

    def test_existing_failures_and_single_samples_are_not_new_latency_regressions(self):
        routes = [{'label': 'local', 'budgetMs': 100}]
        slow = [dict(route='local', scenario='history', op='read', ok=True, elapsedMs=110)]
        result = evaluate(slow, routes, evaluate(slow, routes))
        self.assertFalse(result['passed'])
        self.assertFalse(result['regressions'])
        self.assertTrue(result['unresolved'])
        one = [dict(route='local', scenario='list', op='list', ok=True, elapsedMs=10)]
        result = evaluate([{**one[0], 'elapsedMs': 90}], routes, evaluate(one, routes))
        self.assertFalse(result['regressions'])
        self.assertTrue(result['incomparable'])

    def test_mutation_rejected_before_io(self):
        for op in ['send', 'create', 'stop', 'archive', 'pin', 'respond', 'set-model', None]:
            with self.assertRaises(ValueError):
                require_read({'op': op})
        require_read({'op': 'read'})

    def test_real_http_auth_and_history_never_persist_secrets_or_send_mutations(self):
        import http.server
        import threading
        seen = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                command = json.loads(self.rfile.read(int(self.headers['content-length'])))
                if self.path == '/api/auth':
                    result = {'token': 'PRIVATE_AUTH_TOKEN'}
                else:
                    if self.headers.get('Authorization') != 'Bearer PRIVATE_AUTH_TOKEN':
                        self.send_error(401)
                        return
                    seen.append(command['op'])
                    value = {'id': 'original', 'revision': 'revision', 'turns': [{'items': [{'text': 'PRIVATE_TEXT'}]}]}
                    if command['op'] == 'list':
                        value = {'threads': []}
                    result = {'ok': True, 'result': value}
                raw = json.dumps(result).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            rows = measure_route({'label': 'fixture', 'base': 'http://127.0.0.1:' + str(server.server_port)},
                                 [{'app': 'claude', 'id': 'original', 'label': 'history'}], 3, 'PRIVATE_ACCESS_CODE', 2)
            self.assertTrue(all(row['ok'] for row in rows))
            self.assertEqual(seen, ['list', 'read', 'read', 'read', 'read', 'read', 'read'])
            self.assertNotIn('PRIVATE', json.dumps(rows))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
