"""Synthetic-only tests for the explicit project sidecar (stdlib unittest)."""

import contextlib
import copy
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from orchestra import projects


def project(pid='synthetic', name='Synthetic project'):
    return {'id': pid, 'name': name, 'directions': [{'id': 'general', 'name': 'General'}]}


def thread(tid='thread-example', **changes):
    return {'id': tid, 'title': 'Synthetic entry', 'updatedAt': 1700000000,
            'archived': False, 'source': 'synthetic-index', **changes}


def assignment(pid='synthetic', evidence='Explicit synthetic evidence'):
    return {'projectId': pid, 'directionId': 'general', 'evidence': evidence}


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='.synthetic-project-tests-', dir=ROOT)
        self.root = Path(self.temporary.name)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o750)
        # Opaque stand-in: no SQLite parser is imported or invoked.
        self.ledger = self.state / 'ledger.sqlite'
        self.ledger.write_bytes(b'synthetic-ledger-must-stay-byte-identical\x00')
        self.ledger.chmod(0o640)
        self.original = self.ledger.read_bytes()
        self.original_stat = self.ledger.stat()
        self.index = self.root / 'index.json'
        self.fixture = {'version': 1, 'projects': [project()], 'threads': [thread()],
                        'assignments': {'thread-example': assignment()}}
        self.index.write_text(json.dumps(self.fixture))

    def tearDown(self):
        self.assertEqual(self.ledger.read_bytes(), self.original)
        current = self.ledger.stat()
        self.assertEqual(current.st_mtime_ns, self.original_stat.st_mtime_ns)
        self.assertEqual(stat.S_IMODE(current.st_mode), 0o640)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o750)
        self.temporary.cleanup()

    def cli(self, *args, expected=0):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = projects.main(['--state', str(self.state), *args])
        self.assertEqual(result, expected)
        return projects.read_catalog(self.state) if expected == 0 else None

    def save(self, data):
        (self.state / projects.CATALOG_FILE).write_text(json.dumps(data))

    def test_import_assignment_roundtrip_permissions_and_idempotence(self):
        catalog = self.cli('import-index', str(self.index))
        self.assertEqual(catalog['threads'][0]['updatedAt'], '2023-11-14T22:13:20.000+00:00')
        self.assertEqual(catalog['assignments']['thread-example']['evidence'], 'Explicit synthetic evidence')
        path = self.state / projects.CATALOG_FILE
        before = path.read_bytes()
        before_stat = path.stat()
        self.cli('import-index', str(self.index))
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(path.stat().st_mtime_ns, before_stat.st_mtime_ns)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.state / projects.LOCK_FILE).stat().st_mode), 0o600)
        self.assertFalse(list(self.state.glob('.project-catalog-*')))
        self.cli('assign', '--thread', 'thread-example', '--project', 'synthetic', '--direction', 'general', '--evidence', 'Manual synthetic mapping')
        self.cli('assign-task', '--task', 'task-example', '--project', 'synthetic', '--direction', 'general', '--evidence', 'Explicit task override')
        self.cli('import-index', str(self.index))
        wire = projects.catalog_wire(self.state)
        self.assertEqual(wire['assignments']['thread-example']['evidence'], 'Manual synthetic mapping')
        self.assertEqual(wire['taskAssignments']['task-example']['evidence'], 'Explicit task override')
        self.assertNotIn('_manual', wire['assignments']['thread-example'])

    def test_manual_assignment_preserves_source_evidence(self):
        self.cli('import-index', str(self.index))
        self.cli('assign', '--thread', 'thread-example', '--project', 'synthetic', '--direction', 'general', '--evidence', 'Manual evidence')
        self.fixture['assignments']['thread-example']['evidence'] = 'Second source evidence'
        self.fixture['threads'][0]['source'] = 'second-synthetic-index'
        self.index.write_text(json.dumps(self.fixture))
        result = self.cli('import-index', str(self.index))
        value = result['assignments']['thread-example']
        self.assertEqual(value['evidence'], 'Manual evidence')
        evidence = [item['evidence'] for item in value['_importEvidence']]
        self.assertIn('Explicit synthetic evidence', evidence)
        self.assertIn('Second source evidence', evidence)
        self.assertEqual(result['threads'][0]['_sources'], ['synthetic-index', 'second-synthetic-index'])

    def test_unknown_metadata_survives_every_update(self):
        initial = projects.empty_catalog()
        initial.update(projects=[{**project(), 'custom': {'flag': True}}], privateExtension={'enabled': True})
        initial['threads'] = [{**thread(), 'unknown': {'keep': 'synthetic'}}]
        initial['assignments'] = {'thread-example': {**assignment(), 'extension': 7}}
        self.save(initial)
        result = self.cli('import-index', str(self.index))
        self.assertEqual(result['privateExtension'], {'enabled': True})
        self.assertEqual(result['projects'][0]['custom'], {'flag': True})
        self.assertEqual(result['threads'][0]['unknown'], {'keep': 'synthetic'})
        self.assertEqual(result['assignments']['thread-example']['extension'], 7)
        wire = projects.catalog_wire(self.state)
        self.assertNotIn('privateExtension', wire)
        self.assertNotIn('unknown', wire['threads'][0])

    def test_batch_assign_and_catalog_add_explicit_project(self):
        self.cli('init')
        extra = self.root / 'catalog.json'
        extra.write_text(json.dumps({'projects': [project('paper-learning', 'Paper learning')]}))
        self.cli('catalog', '--json', str(extra))
        batch = self.root / 'batch.json'
        batch.write_text(json.dumps({'assignments': {'thread-batch': assignment('paper-learning')},
                                    'taskAssignments': {'task-batch': assignment('paper-learning')}}))
        result = self.cli('apply', '--json', str(batch))
        self.assertEqual(result['assignments']['thread-batch']['projectId'], 'paper-learning')
        self.assertTrue(result['taskAssignments']['task-batch']['_manual'])
        self.assertIn('learning-deployment', {item['id'] for item in result['projects']})
        self.assertIn('deepswe', {item['id'] for item in result['projects']})
        self.assertNotEqual('learning-deployment', 'deepswe')
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(projects.main(['--state', str(self.state), 'catalog']), 0)
        self.assertEqual(json.loads(output.getvalue())['version'], 1)

    def test_presentation_is_explicit_persistent_and_snapshot_only(self):
        self.fixture['taskPresentations'] = {'task-example': {
            'title': 'Measure synthetic throughput', 'delivery': 'Timing report',
            'summary': 'Measurements pending', 'summaryAt': 1700000000,
            'phaseState': 'blocked', 'phaseEvidence': 'Explicit synthetic phase'}}
        self.index.write_text(json.dumps(self.fixture))
        self.cli('import-index', str(self.index))
        original = {'tasks': [{'id': 'task-example', 'execution': 'reported'}]}
        result = projects.attach_project_catalog(original, self.state)
        self.assertNotIn('presentation', original['tasks'][0])
        self.assertEqual(result['tasks'][0]['presentation']['phaseState'], 'blocked')
        self.assertEqual(result['tasks'][0]['execution'], 'reported')
        self.assertEqual(result['tasks'][0]['presentation']['summaryAt'], '2023-11-14T22:13:20.000+00:00')
        self.fixture['taskPresentations']['task-example']['phaseState'] = 'fabricated'
        self.index.write_text(json.dumps(self.fixture))
        self.cli('import-index', str(self.index), expected=2)

    def test_explicit_multilevel_directions_preserve_parent_and_reject_cycles(self):
        self.fixture['projects'][0]['directions'].append({'id': 'child', 'name': 'Child', 'parentId': 'general'})
        self.index.write_text(json.dumps(self.fixture))
        self.cli('import-index', str(self.index))
        self.assertEqual(projects.catalog_wire(self.state)['projects'][0]['directions'][1]['parentId'], 'general')
        self.fixture['projects'][0]['directions'][0]['parentId'] = 'child'
        self.index.write_text(json.dumps(self.fixture))
        self.cli('import-index', str(self.index), expected=2)

    def test_import_does_not_classify_title(self):
        self.fixture['assignments'] = {}
        self.fixture['threads'][0]['title'] = 'DeepSWE and Learning from Deployment synthetic title'
        self.index.write_text(json.dumps(self.fixture))
        result = self.cli('import-index', str(self.index))
        self.assertEqual(result['assignments'], {})
        self.assertNotIn('projectId', result['threads'][0])

    def test_missing_sidecar_is_read_only_compatible(self):
        payload = {'tasks': [{'id': 'task-example'}], 'collector': {'stale': True}}
        original = copy.deepcopy(payload)
        result = projects.attach_project_catalog(payload, self.state)
        self.assertEqual(payload, original)
        self.assertIs(result['tasks'], payload['tasks'])
        self.assertEqual(result['projectCatalog']['threads'], [])
        self.assertNotIn('projectCatalogError', result)
        self.assertEqual(set(item.name for item in self.state.iterdir()), {'ledger.sqlite'})

    def test_malformed_sidecar_reports_error_without_losing_tasks(self):
        payload = {'tasks': [{'id': 'task-example', 'review': 'pending'}], 'collector': {'connected': False}}
        for malformed in [b'{', b'[]', b'{"version":2}', b'{"version":1,"threads":null}', b'{"version":1,"unknown":NaN}',
                          json.dumps({'version': 1, 'threads': [thread(title='\ud800')]}).encode(),
                          json.dumps({'version': 1, 'threads': [thread(projectId=[])]}).encode(),
                          json.dumps({'version': 1, 'projects': [project()], 'threads': [thread(archived='idle')]}).encode()]:
            with self.subTest(malformed=malformed[:50]):
                path = self.state / projects.CATALOG_FILE
                path.write_bytes(malformed)
                result = projects.attach_project_catalog(payload, self.state)
                self.assertEqual(result['projectCatalogError'], 'catalog_unavailable_or_invalid')
                self.assertIs(result['tasks'], payload['tasks'])
                self.assertEqual(path.read_bytes(), malformed)

    def test_invalid_assignments_never_replace_existing_catalog(self):
        self.cli('import-index', str(self.index))
        path = self.state / projects.CATALOG_FILE
        before = path.read_bytes()
        self.cli('assign-task', '--task', 'task-example', '--project', 'absent', '--direction', 'general', '--evidence', 'Synthetic invalid mapping', expected=2)
        self.assertEqual(path.read_bytes(), before)
        self.fixture['threads'][0]['updatedAt'] = 'invalid-time'
        self.index.write_text(json.dumps(self.fixture))
        self.cli('import-index', str(self.index), expected=2)
        self.assertEqual(path.read_bytes(), before)

    def test_seconds_milliseconds_and_iso_normalize_identically(self):
        expected = '2023-11-14T22:13:20.000+00:00'
        for value in (1700000000, 1700000000000, '1700000000000', '2023-11-14T22:13:20Z'):
            self.assertEqual(projects.normalize_time(value), expected)
        for value in (True, float('nan'), {}, 'garbage'):
            with self.assertRaises(projects.CatalogError):
                projects.normalize_time(value)

    def test_wire_supports_250_entries_and_bounds_large_optional_fields(self):
        catalog = projects.empty_catalog()
        catalog['projects'] = [project()]
        catalog['threads'] = [thread('synthetic-%03d' % i, title='Synthetic item %d' % i,
                                     summary='x' * 2000, cwd='y' * 2000) for i in range(250)]
        self.save(catalog)
        wire = projects.catalog_wire(self.state)
        self.assertEqual(wire['coverage']['indexed'], 250)
        self.assertEqual(wire['coverage']['emitted'], 250)
        self.assertTrue(wire['coverage']['truncated'])
        self.assertLessEqual(len(json.dumps(wire, ensure_ascii=False).encode()), projects.MAX_WIRE_BYTES)
        self.assertLessEqual(len(wire['threads'][0].get('summary', '')), 320)
        self.assertLessEqual(len(wire['threads'][0].get('cwd', '')), 160)

    def test_wire_bounds_even_identity_heavy_catalog_and_reports_coverage(self):
        catalog = projects.empty_catalog()
        catalog['threads'] = [thread('synthetic-%04d-' % i + 'x' * 180, title='例' * 240, source='s' * 120) for i in range(400)]
        self.save(catalog)
        wire = projects.catalog_wire(self.state)
        self.assertLess(wire['coverage']['emitted'], 400)
        self.assertTrue(wire['coverage']['truncated'])
        self.assertLessEqual(len(json.dumps(wire, ensure_ascii=False).encode()), projects.MAX_WIRE_BYTES)

    def test_oversized_file_and_unshrinkable_wire_fail_safely(self):
        path = self.state / projects.CATALOG_FILE
        path.write_bytes(b' ' * (projects.MAX_FILE_BYTES + 1))
        self.assertIn('projectCatalogError', projects.attach_project_catalog({'tasks': []}, self.state))
        catalog = projects.empty_catalog()
        catalog['projects'] = [project()]
        catalog['assignments'] = {'synthetic-%04d' % i: assignment(evidence='x' * 256) for i in range(1000)}
        self.save(catalog)
        result = projects.attach_project_catalog({'tasks': [{'id': 'retained'}]}, self.state)
        self.assertIn('projectCatalogError', result)
        self.assertEqual(result['tasks'], [{'id': 'retained'}])

    def test_atomic_failure_keeps_original(self):
        self.cli('import-index', str(self.index))
        before = (self.state / projects.CATALOG_FILE).read_bytes()
        with patch.object(projects.os, 'replace', side_effect=OSError('synthetic failure')):
            self.cli('assign', '--thread', 'thread-example', '--project', 'synthetic', '--direction', 'general', '--evidence', 'Synthetic change', expected=2)
        self.assertEqual((self.state / projects.CATALOG_FILE).read_bytes(), before)
        self.assertFalse(list(self.state.glob('.project-catalog-*')))

    def test_concurrent_cli_writes_keep_both_assignments(self):
        self.cli('import-index', str(self.index))
        env = {**os.environ, 'PYTHONPATH': str(ROOT)}
        children = [subprocess.Popen([sys.executable, '-m', 'orchestra.projects', '--state', str(self.state),
                    'assign-task', '--task', 'synthetic-task-%d' % i, '--project', 'synthetic', '--direction', 'general',
                    '--evidence', 'Concurrent synthetic evidence'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(2)]
        for child in children:
            stdout, stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, (stdout, stderr))
        self.assertEqual(len(projects.read_catalog(self.state)['taskAssignments']), 2)

    def test_snapshot_hook_only_attaches_to_snapshot_and_stays_read_only(self):
        # Input snapshot omits ledger/artifacts; synthetic modules isolate hook behavior.
        artifacts = types.ModuleType('orchestra.artifacts')
        artifacts.ArtifactError = type('ArtifactError', (Exception,), {})
        artifacts.read_prepared_artifact = lambda *args: {'artifact': True}
        ledger = types.ModuleType('orchestra.ledger')
        ledger.Ledger = object
        errors = types.ModuleType('orchestra.errors')
        errors.TransitionError = type('TransitionError', (Exception,), {})
        spec = importlib.util.spec_from_file_location('orchestra.server', ROOT / 'orchestra' / 'server.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'orchestra.artifacts': artifacts, 'orchestra.ledger': ledger, 'orchestra.errors': errors}):
            spec.loader.exec_module(module)
        original = {'tasks': [{'id': 'synthetic-task'}], 'collector': {'stale': True}}
        handler = object.__new__(module._SnapshotHandler)
        handler.server = types.SimpleNamespace(ledger=types.SimpleNamespace(snapshot=lambda: original), project_state_dir=self.state)
        responses = []
        handler._send_json = lambda status, payload: responses.append((status, payload))
        handler.path = '/snapshot'
        handler.do_GET()
        self.assertEqual(responses[-1][0], 200)
        self.assertEqual(responses[-1][1]['tasks'], original['tasks'])
        self.assertIn('projectCatalog', responses[-1][1])
        self.assertNotIn('projectCatalog', original)
        original['tasks'][0]['deliverables'] = ['unavailable synthetic', 'prepared synthetic']
        def artifact_read(_ledger, _task, index):
            if index == 0:
                raise artifacts.ArtifactError('not_prepared')
            return {'name': 'Synthetic report', 'content': 'Private synthetic content',
                    'preparedAt': '2026-01-01T00:00:00Z'}
        module.read_artifact = artifact_read
        handler.do_GET()
        self.assertEqual(responses[-1][1]['tasks'][0]['artifacts'], [
            {'index': 1, 'name': 'Synthetic report', 'preparedAt': '2026-01-01T00:00:00Z'}])
        self.assertNotIn('artifacts', original['tasks'][0])
        self.assertNotIn('Private synthetic content', json.dumps(responses[-1][1]))
        handler.path = '/health'
        handler.do_GET()
        self.assertNotIn('projectCatalog', responses[-1][1])
        handler.do_POST()
        self.assertEqual(responses[-1], (405, {'ok': False, 'error': 'read_only_endpoint'}))


if __name__ == '__main__':
    unittest.main()
