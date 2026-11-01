import json
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from orchestra.context import context_packet
from orchestra.cli import main
from orchestra.errors import NotFoundError, ValidationError
from orchestra.ledger import Ledger


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(self.temp.name)
        self.ledger.register({
            "id": "S1", "title": "继续同任务", "goal": "目标" * 500,
            "threadId": "original-thread", "authorization": "本阶段授权",
            "deliverables": ["/external/proof.json"],
            "acceptance": ["必须核验真实产物"], "evidence": ["proof-reference"],
            "checkpoint": "核对证据后决定下一步", "execution": "running",
        })

    def test_packet_preserves_identity_and_does_not_infer_quality(self):
        packet = context_packet(self.ledger, "S1")
        self.assertEqual(packet["routing"]["originalThreadId"], "original-thread")
        self.assertFalse(packet["routing"]["createsOrSends"])
        self.assertFalse(packet["limits"]["qualityAssessed"])
        self.assertFalse(packet["limits"]["nativeContextCompressionTriggered"])
        self.assertEqual(packet["references"]["deliverables"][0]["id"], "deliverables:0")
        self.assertNotIn("fullContract", packet)
        self.assertLessEqual(len(packet["goal"]), 401)
        self.assertEqual(self.ledger.get_task("S1")["execution"], "running")

    def test_explicit_recall_preserves_unshortened_contract(self):
        packet = context_packet(self.ledger, "S1", full=True)
        self.assertEqual(packet["fullContract"]["goal"], "目标" * 500)
        self.assertFalse(packet["limits"]["referencesRead"])

    def test_unknown_task_is_not_routed_to_new_thread(self):
        with self.assertRaises(NotFoundError):
            context_packet(self.ledger, "missing")

    def test_directives_removed_from_inline_summary(self):
        with self.ledger._connect() as connection:
            connection.execute("UPDATE tasks SET progress=? WHERE id='S1'", ('已恢复。\n::created-thread{threadId="internal"}',))
        packet = context_packet(self.ledger, "S1")
        self.assertEqual(packet["recordedConclusion"], "已恢复。")
        self.assertNotIn("internal", json.dumps(packet, ensure_ascii=False))

    def test_reference_recall_returns_exact_value_and_detects_contract_drift(self):
        packet = context_packet(self.ledger, "S1")
        exact = context_packet(self.ledger, "S1", reference="deliverables:0", revision=packet["revision"])
        self.assertEqual(exact["value"], "/external/proof.json")
        self.assertFalse(exact["contentRead"])
        self.ledger.update_contract("S1", {"deliverables": ["/different/proof.json"]})
        with self.assertRaises(ValidationError):
            context_packet(self.ledger, "S1", reference="deliverables:0", revision=packet["revision"])
        with self.assertRaises(ValidationError):
            context_packet(self.ledger, "S1", reference="evidence:999")

    def test_cli_packet_and_reference_recall_do_not_mutate_task(self):
        def cli(*args):
            output = io.StringIO()
            with redirect_stdout(output):
                result = main(["--state", self.temp.name, *args])
            self.assertEqual(result, 0)
            return json.loads(output.getvalue())
        before = self.ledger.get_task("S1")
        packet = cli("context", "S1")
        item = packet["references"]["deliverables"][0]
        recalled = cli(*item["recall"][1:])
        self.assertEqual(recalled["value"], "/external/proof.json")
        self.assertEqual(self.ledger.get_task("S1"), before)


if __name__ == "__main__":
    unittest.main()
