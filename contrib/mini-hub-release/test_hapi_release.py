#!/usr/bin/env python3
"""Focused unittest coverage for the COMPACT_RELEASE_V1 transaction.

The real macOS adapter is replaced by an in-memory fake; the Release transaction
itself and all filesystem byte/inode/snapshot behaviour are exercised in a
temporary base directory. No launchd, codesign, network or production state is
touched.
"""

from __future__ import annotations

import fcntl
import io
import json
import os
from pathlib import Path
import plistlib
import pwd
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hapi_release  # noqa: E402
from hapi_release import Failure, Interrupted, Release  # noqa: E402


def sha_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def sha_file(path: Path) -> str:
    return sha_bytes(path.read_bytes())


class FakePlatform:
    """Injected OS/service seam. Tracks the live binary bytes to derive readiness."""

    uid = 501
    gid = 20
    plist_sha = "c" * 64
    secret = "sk-test-must-not-appear-in-receipt"

    def __init__(self, binary: Path, old_bytes: bytes, new_bytes: bytes,
                 old_content: dict, new_content: dict):
        self.binary = binary
        self.old_bytes = old_bytes
        self.new_bytes = new_bytes
        self.old_content = dict(old_content)
        self.new_content = dict(new_content)
        self.calls: list[str] = []
        self.stop_calls = 0
        self.start_calls = 0
        self.verify_fail = False
        self.check_plist_fail = False
        self.start_fail_times = 0
        self.candidate_ready_failures = 0
        self.old_ready_fails = False
        self.interrupt_candidate_ready = False

    # -- transaction-used API ------------------------------------------------
    def require_root(self) -> None:
        self.calls.append("require_root")

    def check_plist(self) -> None:
        self.calls.append("check_plist")
        if self.check_plist_fail:
            raise Failure("service-configuration-changed")

    def verify(self, binary) -> None:
        self.calls.append("verify")
        if self.verify_fail:
            raise Failure("candidate-signature-invalid")

    def probe(self, candidate) -> dict:
        self.calls.append("probe")
        return self._content_for(Path(candidate))

    def ready(self, expected=None, stable=0, timeout=30) -> dict:
        self.calls.append("ready")
        current = self._content_for(self.binary)
        if expected is not None and expected != current:
            raise Failure("deployed-content-mismatch")
        if self.interrupt_candidate_ready and current == self.new_content and expected is not None:
            self.interrupt_candidate_ready = False
            raise Interrupted()
        if self.candidate_ready_failures and current == self.new_content and expected is not None:
            self.candidate_ready_failures -= 1
            raise Failure("readiness-timeout")
        if self.old_ready_fails and current == self.old_content and expected is not None:
            self.old_ready_fails = False
            raise Failure("rollback-readiness-failure")
        pid = 222 if current == self.new_content else 111
        return {"pid": pid, **current}

    def stop(self) -> None:
        self.calls.append("stop")
        self.stop_calls += 1

    def start(self) -> None:
        self.calls.append("start")
        self.start_calls += 1
        if self.start_fail_times:
            self.start_fail_times -= 1
            raise Failure("bootstrap-failed")

    # -- fake bookkeeping -----------------------------------------------------
    def _content_for(self, path: Path) -> dict:
        data = path.read_bytes()
        if data == self.old_bytes:
            return dict(self.old_content)
        if data == self.new_bytes:
            return dict(self.new_content)
        raise Failure("unexpected-binary-in-fake")


OLD_CONTENT = {"htmlSHA256": "a" * 64, "assetSHA256": "b" * 64, "protocolVersion": 1}
NEW_CONTENT = {"htmlSHA256": "d" * 64, "assetSHA256": "e" * 64, "protocolVersion": 1}


class ReleaseTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hapi-release-test-")
        self.base = Path(self.tmp.name)
        (self.base / "bin").mkdir()
        self.binary = self.base / "bin" / "hapi-hub"
        self.old_bytes = b"OLD-ARM64-HUB-BINARY\x00\x01"
        self.new_bytes = b"NEW-ARM64-HUB-BINARY\x00\x02"
        self.binary.write_bytes(self.old_bytes)
        os.chmod(self.binary, 0o755)
        self.candidate = self.base / "candidate"
        self.candidate.write_bytes(self.new_bytes)
        os.chmod(self.candidate, 0o755)
        self.plist = self.base / "daemon.plist"
        self.plist.write_text("ignored by the fake adapter")
        self.fake = FakePlatform(self.binary, self.old_bytes, self.new_bytes,
                                 OLD_CONTENT, NEW_CONTENT)
        self.release = Release(self.base, self.plist, platform=self.fake)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def deploy_ok(self):
        receipt = self.release.deploy(self.candidate, sha_file(self.binary))
        self.assertEqual("deployed", receipt["result"], receipt)
        return receipt

    def receipt_path(self, receipt) -> Path:
        return Path(receipt["receiptPath"])

    def read_receipt(self, receipt) -> dict:
        return json.loads(self.receipt_path(receipt).read_text())


class PreflightAndGuardTests(ReleaseTestBase):
    def test_signature_rejection_leaves_live_untouched(self):
        self.fake.verify_fail = True
        before = self.binary.read_bytes()
        receipt = self.release.deploy(self.candidate, sha_file(self.binary))
        self.assertEqual("rejected", receipt["result"])
        self.assertEqual("candidate-signature-invalid", receipt["error"])
        self.assertEqual(0, self.fake.stop_calls)
        self.assertEqual(before, self.binary.read_bytes())
        self.assertNotIn("candidate-installed", [s["name"] for s in receipt["steps"]])

    def test_preflight_is_read_only_and_does_not_stop_service(self):
        before = self.binary.read_bytes()
        result = self.release.preflight(self.candidate)
        self.assertEqual("preflight-passed", result["result"])
        self.assertEqual(0, self.fake.stop_calls)
        self.assertNotIn("require_root", self.fake.calls)
        self.assertEqual(before, self.binary.read_bytes())
        self.assertEqual(self.new_bytes, self.candidate.read_bytes())

    def test_status_is_read_only(self):
        result = self.release.status()
        self.assertEqual("running", result["result"])
        self.assertEqual(sha_file(self.binary), result["binarySHA256"])
        self.assertEqual(0, self.fake.stop_calls)
        self.assertNotIn("require_root", self.fake.calls)

    def test_apply_requires_root_before_live_mutation(self):
        def deny_root():
            raise Failure("administrator-required")

        self.fake.require_root = deny_root
        with self.assertRaises(Failure) as caught:
            self.release.deploy(self.candidate, sha_file(self.binary))
        self.assertEqual("administrator-required", str(caught.exception))
        self.assertEqual(0, self.fake.stop_calls)
        self.assertEqual(self.old_bytes, self.binary.read_bytes())

    def test_stale_expected_current_sha_rejects_before_stage(self):
        before = self.binary.read_bytes()
        receipt = self.release.deploy(self.candidate, "0" * 64)
        self.assertEqual("rejected", receipt["result"])
        self.assertEqual("live-binary-drift", receipt["error"])
        self.assertEqual(0, self.fake.stop_calls)
        self.assertEqual(before, self.binary.read_bytes())

    def test_concurrent_process_lock_rejects_deploy(self):
        self.release.directories()
        lock_path = self.release.state / "deploy.lock"
        with open(lock_path, "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(Failure) as caught:
                self.release.deploy(self.candidate, sha_file(self.binary))
            self.assertEqual("deployment-in-progress", str(caught.exception))
        self.assertEqual(0, self.fake.stop_calls)
        self.assertEqual(self.old_bytes, self.binary.read_bytes())

    def test_same_hash_requires_reinstall(self):
        same = self.base / "same"
        same.write_bytes(self.old_bytes)
        os.chmod(same, 0o755)
        receipt = self.release.deploy(same, sha_file(self.binary))
        self.assertEqual("same-version-use-reinstall", receipt["error"])
        self.assertEqual(0, self.fake.stop_calls)


class TransactionTests(ReleaseTestBase):
    def test_success_order_and_receipt(self):
        plist_before = self.plist.read_bytes()
        receipt = self.deploy_ok()
        self.assertEqual(plist_before, self.plist.read_bytes())
        calls = self.fake.calls
        self.assertLess(calls.index("probe"), calls.index("stop"))
        self.assertLess(calls.index("stop"), calls.index("start"))
        self.assertEqual(1, self.fake.stop_calls)
        self.assertEqual(1, self.fake.start_calls)
        self.assertEqual(
            ["candidate-preflight-passed", "bootout-started",
             "candidate-installed", "candidate-ready"],
            [step["name"] for step in receipt["steps"]],
        )
        self.assertEqual(sha_file(self.binary), receipt["afterSHA256"])
        self.assertEqual(111, receipt["oldPID"])
        self.assertEqual(222, receipt["newPID"])
        self.assertEqual(NEW_CONTENT, receipt["content"])
        self.assertEqual(sha_file(Path(receipt["snapshot"])), receipt["beforeSHA256"])
        self.assertTrue(self.receipt_path(receipt).is_file())

    def test_readiness_failure_rolls_back_exact_snapshot(self):
        self.fake.candidate_ready_failures = 1
        receipt = self.release.deploy(self.candidate, sha_file(self.binary))
        self.assertEqual("rolled-back", receipt["result"], receipt)
        self.assertEqual("readiness-timeout", receipt["error"])
        self.assertEqual(2, self.fake.stop_calls)
        self.assertEqual(2, self.fake.start_calls)
        self.assertEqual(111, receipt["rollbackPID"])
        self.assertEqual(self.old_bytes, self.binary.read_bytes())
        self.assertEqual(sha_bytes(self.old_bytes), receipt["beforeSHA256"])

    def test_bootstrap_failure_rolls_back(self):
        self.fake.start_fail_times = 1
        receipt = self.release.deploy(self.candidate, sha_file(self.binary))
        self.assertEqual("rolled-back", receipt["result"], receipt)
        self.assertEqual("bootstrap-failed", receipt["error"])
        self.assertNotIn("rollbackError", receipt)
        self.assertEqual(2, self.fake.start_calls)
        self.assertEqual(self.old_bytes, self.binary.read_bytes())

    def test_interrupted_candidate_readiness_rolls_back(self):
        self.fake.interrupt_candidate_ready = True
        receipt = self.release.deploy(self.candidate, sha_file(self.binary))
        self.assertEqual("rolled-back", receipt["result"], receipt)
        self.assertEqual("Interrupted", receipt["error"])
        self.assertEqual(self.old_bytes, self.binary.read_bytes())
        self.assertEqual(2, self.fake.stop_calls)

    def test_rollback_failure_is_explicit(self):
        self.fake.candidate_ready_failures = 1
        self.fake.old_ready_fails = True
        receipt = self.release.deploy(self.candidate, sha_file(self.binary))
        self.assertEqual("rollback-failed", receipt["result"], receipt)
        self.assertEqual("rollback-readiness-failure", receipt["rollbackError"])
        # Rollback installed the previous bytes before its readiness probe failed.
        self.assertEqual(self.old_bytes, self.binary.read_bytes())
        self.assertEqual("rollback-failed", self.read_receipt(receipt)["result"])

    def test_candidate_bytes_and_inode_are_immutable(self):
        candidate_before = self.candidate.read_bytes()
        candidate_inode = self.candidate.stat().st_ino
        target_inode = self.binary.stat().st_ino
        self.deploy_ok()
        self.assertEqual(candidate_before, self.candidate.read_bytes())
        self.assertEqual(candidate_inode, self.candidate.stat().st_ino)
        self.assertEqual(sha_bytes(candidate_before), sha_file(self.binary))
        self.assertNotEqual(candidate_inode, self.binary.stat().st_ino)
        self.assertNotEqual(target_inode, self.binary.stat().st_ino)

    def test_receipts_contain_no_secret_or_raw_stream_fields(self):
        receipt = self.deploy_ok()
        text = json.dumps(receipt)
        self.assertNotIn(self.fake.secret, text)
        forbidden = {"env", "environment", "token", "secret", "stdout", "stderr", "log"}
        for key in receipt:
            self.assertFalse(
                any(word in key.lower() for word in forbidden),
                f"unsafe receipt key: {key}",
            )
        self.assertEqual("deployed", self.read_receipt(receipt)["result"])


class ManualRollbackTests(ReleaseTestBase):
    def test_manual_rollback_uses_exact_snapshot_and_expected_current(self):
        receipt = self.deploy_ok()
        deployed_sha = sha_file(self.binary)
        self.assertEqual(deployed_sha, sha_bytes(self.new_bytes))
        result = self.release.rollback(self.receipt_path(receipt), deployed_sha)
        self.assertEqual("deployed", result["result"], result)
        self.assertEqual("manual-rollback", result["intent"])
        self.assertEqual(self.old_bytes, self.binary.read_bytes())
        self.assertEqual(111, result["newPID"])
        self.assertEqual(sha_bytes(self.old_bytes), result["afterSHA256"])

    def test_manual_rollback_rejects_newer_deployment(self):
        receipt = self.deploy_ok()
        before = self.binary.read_bytes()
        rejected = self.release.rollback(self.receipt_path(receipt), sha_bytes(self.old_bytes))
        self.assertEqual("rejected", rejected["result"])
        self.assertEqual("live-binary-drift", rejected["error"])
        self.assertEqual(before, self.binary.read_bytes())
        self.assertEqual(self.new_bytes, self.binary.read_bytes())

    def test_manual_rollback_rejects_changed_snapshot(self):
        receipt = self.deploy_ok()
        backup = Path(receipt["snapshot"])
        backup.write_bytes(b"TAMPERED")
        with self.assertRaises(Failure) as caught:
            self.release.rollback(self.receipt_path(receipt), sha_file(self.binary))
        self.assertEqual("rollback-snapshot-changed", str(caught.exception))
        self.assertEqual(self.new_bytes, self.binary.read_bytes())


class PlistAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hapi-release-plist-")
        self.base = Path(self.tmp.name)
        (self.base / "bin").mkdir()
        self.binary = self.base / "bin" / "hapi-hub"
        self.binary.write_bytes(b"thin-arm64-placeholder")
        os.chmod(self.binary, 0o755)
        self.plist = self.base / "com.zhuhe.hapi-mini.plist"
        self.payload = {
            "Label": hapi_release.LABEL,
            "ProgramArguments": [str(self.binary), "--no-relay"],
            "UserName": pwd.getpwuid(os.getuid()).pw_name,
            "KeepAlive": True,
            "ThrottleInterval": 10,
            "EnvironmentVariables": {
                "HAPI_LISTEN_HOST": "127.0.0.1",
                "HAPI_LISTEN_PORT": "3006",
                "HAPI_HOME": "/Users/zhuhe/.hapi-mini",
                "HTTP_PROXY": "http://proxy.invalid:8080",
                "HAPI_TENANT": "tenant-fixture",
            },
        }
        self.plist.write_bytes(plistlib.dumps(self.payload))
        self.original_plist = self.plist.read_bytes()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_plist_environment_is_read_verbatim_and_not_rewritten(self):
        adapter = hapi_release.Mac(self.binary, self.plist)
        self.assertEqual(3006, adapter.port)
        self.assertEqual(["--no-relay"], adapter.args)
        self.assertEqual(self.original_plist, self.plist.read_bytes())
        self.assertEqual("http://proxy.invalid:8080",
                         adapter.config["EnvironmentVariables"]["HTTP_PROXY"])

    def test_plist_drift_is_detected(self):
        adapter = hapi_release.Mac(self.binary, self.plist)
        changed = dict(self.payload)
        changed["EnvironmentVariables"] = dict(self.payload["EnvironmentVariables"])
        changed["EnvironmentVariables"]["HAPI_HOME"] = "/tmp/changed"
        self.plist.write_bytes(plistlib.dumps(changed))
        with self.assertRaises(Failure) as caught:
            adapter.check_plist()
        self.assertEqual("service-configuration-changed", str(caught.exception))

    def test_non_loopback_listener_is_rejected(self):
        changed = dict(self.payload)
        changed["EnvironmentVariables"] = dict(self.payload["EnvironmentVariables"])
        changed["EnvironmentVariables"]["HAPI_LISTEN_HOST"] = "0.0.0.0"
        self.plist.write_bytes(plistlib.dumps(changed))
        with self.assertRaises(Failure) as caught:
            hapi_release.Mac(self.binary, self.plist)
        self.assertEqual("expected-loopback-listener", str(caught.exception))


class CliExitCodeTests(unittest.TestCase):
    def test_failure_exit_codes_include_rolled_back_and_rollback_failed(self):
        for result, code in (
            ("deployed", 0),
            ("rolled-back", 1),
            ("rejected", 2),
            ("rollback-failed", 3),
        ):
            stub = mock.Mock()
            stub.deploy.return_value = {"result": result}
            with self.subTest(result=result):
                with mock.patch.object(hapi_release, "Release", return_value=stub):
                    with redirect_stdout(io.StringIO()):
                        actual = hapi_release.main([
                            "--base", "/tmp/base", "--plist", "/tmp/plist",
                            "deploy", "--candidate", "/tmp/candidate",
                            "--expected-current-sha", "0" * 64,
                        ])
                self.assertEqual(code, actual)


if __name__ == "__main__":
    unittest.main()
