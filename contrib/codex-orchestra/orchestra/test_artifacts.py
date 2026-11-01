import json
import os
import tempfile
import unittest

from .artifacts import MAX_BYTES, ArtifactError, read_artifact


class FakeLedger:
    def __init__(self, deliverables, import_source=None, artifact_roots=None):
        self.deliverables = deliverables
        self.meta = {}
        if import_source is not None:
            self.meta["import_source"] = import_source
        if artifact_roots is not None:
            self.meta["artifact_roots"] = json.dumps(artifact_roots)

    def get_task(self, task_id):
        if task_id != "T003":
            return None
        return {"id": task_id, "deliverables": self.deliverables}

    def get_meta(self, key, default=None):
        return self.meta.get(key, default)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.outside = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self.root, "docs"))
        self._write("REPORT.md", "# report")
        self._write("docs/EVIDENCE.md", "evidence")
        self._write("notes.txt", "plain")
        self._write("bad.md", b"\xff\xfe")
        self._write("large.md", "x" * (MAX_BYTES + 1))
        self._write("script.py", "print(1)")

    def tearDown(self):
        self.tmp.cleanup()
        self.outside.cleanup()

    def _write(self, relative, content):
        path = os.path.join(self.root, relative)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = "wb" if isinstance(content, bytes) else "w"
        with open(path, mode) as handle:
            handle.write(content)

    def ledger(self, *deliverables):
        return FakeLedger(list(deliverables), os.path.join(self.root, "任务总览.md"))

    def test_markdown_link_and_plain_path(self):
        result = read_artifact(self.ledger("[报告](REPORT.md)", "docs/EVIDENCE.md", "notes.txt"), "T003", 0)
        self.assertEqual(result, {"name": "报告", "content": "# report"})
        result = read_artifact(self.ledger("[报告](REPORT.md)", "docs/EVIDENCE.md", "notes.txt"), "T003", 1)
        self.assertEqual(result, {"name": "EVIDENCE.md", "content": "evidence"})
        result = read_artifact(self.ledger("[报告](REPORT.md)", "docs/EVIDENCE.md", "notes.txt"), "T003", 2)
        self.assertEqual(result, {"name": "notes.txt", "content": "plain"})

    def test_rejects_unregistered_index_and_unknown_task(self):
        ledger = self.ledger("REPORT.md")
        with self.assertRaises(ArtifactError):
            read_artifact(ledger, "T003", 1)
        with self.assertRaises(ArtifactError):
            read_artifact(ledger, "T004", 0)

    def test_rejects_traversal_url_and_absolute_outside(self):
        outside = os.path.join(self.outside.name, "secret.md")
        with open(outside, "w") as handle:
            handle.write("secret")
        for target in ("../secret.md", "https://example.com/a.md", "mailto:x@y", "/etc/passwd", outside):
            with self.assertRaises(ArtifactError):
                read_artifact(self.ledger("[x](" + target + ")"), "T003", 0)

    def test_rejects_symlink_escape(self):
        outside = os.path.join(self.outside.name, "secret.md")
        with open(outside, "w") as handle:
            handle.write("secret")
        link = os.path.join(self.root, "link.md")
        try:
            os.symlink(outside, link)
        except OSError:
            self.skipTest("symlink is not available")
        with self.assertRaises(ArtifactError):
            read_artifact(self.ledger("link.md"), "T003", 0)

    def test_rejects_invalid_utf8_large_and_extension(self):
        for target in ("bad.md", "large.md", "script.py"):
            with self.assertRaises(ArtifactError):
                read_artifact(self.ledger(target), "T003", 0)

    def test_allows_explicit_artifact_root(self):
        shared = os.path.join(self.outside.name, "shared.md")
        with open(shared, "w") as handle:
            handle.write("shared")
        ledger = FakeLedger(
            [shared],
            os.path.join(self.root, "任务总览.md"),
            [self.outside.name],
        )
        result = read_artifact(ledger, "T003", 0)
        self.assertEqual(result["name"], "shared.md")
        self.assertEqual(result["content"], "shared")


if __name__ == "__main__":
    unittest.main()
