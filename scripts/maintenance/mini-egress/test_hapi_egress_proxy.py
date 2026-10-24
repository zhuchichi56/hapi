#!/usr/bin/env python3
"""Mocked security, endpoint-fallback and cache tests for hapi-egress-proxy.py.

No network access: every test patches socket.getaddrinfo and _doh_open.  The
module-level resolution cache is cleared before each test.  Run:
    python3 -m unittest -v test_hapi_egress_proxy.py
"""

import importlib.util
import json
import pathlib
import socket
import unittest
import urllib.error
import urllib.parse
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).resolve().with_name("hapi-egress-proxy.py")
SPEC = importlib.util.spec_from_file_location("hapi_egress_proxy", MODULE_PATH)
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)

PUBLIC_IP = "93.184.216.34"
PUBLIC_IP_2 = "1.1.1.1"
PRIVATE_IP = "192.168.1.10"


def system_addrs(*ips, port=443):
    """Build getaddrinfo-shaped results."""
    return [
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, port))
        for ip in ips
    ]


def doh_payload(*answers, status=0):
    return {"Status": status, "Answer": list(answers)}


def a_record(ip, name="fcm.googleapis.com."):
    return {"name": name, "type": 1, "TTL": 60, "data": ip}


class FakeDohResponse:
    """Minimal context-manager response accepted by _doh_lookup."""

    def __init__(self, payload):
        if isinstance(payload, (bytes, bytearray)):
            self._body = bytes(payload)
        else:
            self._body = json.dumps(payload).encode("utf-8")

    def read(self, amt=None):
        if amt is None:
            data, self._body = self._body, b""
            return data
        data, self._body = self._body[:amt], self._body[amt:]
        return data

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def http_error(url, code=503):
    return urllib.error.HTTPError(url, code, "Service Unavailable", {}, None)


class ResolverFallbackTests(unittest.TestCase):
    def setUp(self):
        with proxy._DNS_CACHE_LOCK:
            proxy._DNS_CACHE.clear()

    @staticmethod
    def _urls(doh_open):
        return [
            urllib.parse.urlsplit(call.args[0].full_url)
            for call in doh_open.call_args_list
        ]

    def test_public_system_result_does_not_use_doh(self):
        """Acceptance: public system result -> no fallback."""
        with mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs(PUBLIC_IP)
        ) as getaddrinfo, mock.patch.object(
            proxy, "_doh_open", side_effect=AssertionError("DoH must not be called")
        ) as doh_open:
            result = proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(result, [(socket.AF_INET, (PUBLIC_IP, 443))])
        getaddrinfo.assert_called_once_with(
            "push.example.com", 443, socket.AF_UNSPEC, socket.SOCK_STREAM
        )
        doh_open.assert_not_called()

    def test_public_system_result_is_cached(self):
        """Successful public system results are cached for <=60s."""
        clock = [1000.0]
        with mock.patch.object(
            proxy.time, "monotonic", side_effect=lambda: clock[0]
        ), mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs(PUBLIC_IP)
        ) as getaddrinfo, mock.patch.object(
            proxy, "_doh_open", side_effect=AssertionError("DoH must not be called")
        ):
            first = proxy.resolve_destination("push.example.com", 443)
            clock[0] = 1059.5
            second = proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(second, first)
        self.assertEqual(getaddrinfo.call_count, 1)

    def test_nonpublic_system_result_uses_primary_alidns_doh(self):
        """Primary DoH is AliDNS /resolve with a validated public A answer."""
        response = FakeDohResponse(doh_payload(a_record(PUBLIC_IP)))
        with mock.patch.object(
            proxy.socket,
            "getaddrinfo",
            return_value=system_addrs("10.0.0.5", "198.18.0.7"),
        ), mock.patch.object(proxy, "_doh_open", return_value=response) as doh_open:
            result = proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(result, [(socket.AF_INET, (PUBLIC_IP, 443))])
        doh_open.assert_called_once()
        request = doh_open.call_args.args[0]
        self.assertLessEqual(doh_open.call_args.kwargs["timeout"], 10.0)
        self.assertEqual(request.get_header("Accept"), "application/dns-json")
        parsed = urllib.parse.urlsplit(request.full_url)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.netloc, "dns.alidns.com")
        self.assertEqual(parsed.path, "/resolve")
        self.assertEqual(
            urllib.parse.parse_qs(parsed.query),
            {"name": ["push.example.com"], "type": ["A"]},
        )

    def test_private_literal_is_refused_without_doh_or_cache(self):
        """Acceptance: private IP literal refused first, never sent to DoH."""
        for host in ("127.0.0.1", "10.1.2.3", "[::1]"):
            with self.subTest(host=host):
                with mock.patch.object(
                    proxy.socket,
                    "getaddrinfo",
                    side_effect=AssertionError("literal must not resolve"),
                ) as getaddrinfo, mock.patch.object(
                    proxy,
                    "_doh_open",
                    side_effect=AssertionError("literal must not use DoH"),
                ) as doh_open:
                    with self.assertRaises(proxy.ProxyError) as caught:
                        proxy.resolve_destination(host, 443)

                self.assertEqual(caught.exception.status, 403)
                getaddrinfo.assert_not_called()
                doh_open.assert_not_called()

    def test_private_doh_answer_is_rejected_without_fallback(self):
        """Acceptance: private DoH answer fails closed; no Cloudflare fallback."""
        response = FakeDohResponse(doh_payload(a_record(PRIVATE_IP)))
        with mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
        ), mock.patch.object(proxy, "_doh_open", return_value=response) as doh_open:
            with self.assertRaises(proxy.ProxyError) as caught:
                proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(doh_open.call_count, 1)
        self.assertEqual(self._urls(doh_open)[0].netloc, "dns.alidns.com")

    def test_mixed_public_and_private_doh_answers_are_rejected(self):
        """One private answer rejects the response; no cherry-picking."""
        response = FakeDohResponse(
            doh_payload(a_record(PUBLIC_IP), a_record(PRIVATE_IP))
        )
        with mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
        ), mock.patch.object(proxy, "_doh_open", return_value=response):
            with self.assertRaises(proxy.ProxyError) as caught:
                proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(caught.exception.status, 403)

    def test_primary_transport_error_falls_back_to_cloudflare(self):
        """Cloudflare is used only after primary transport failure."""
        primary_error = http_error(proxy.DOH_PRIMARY_ENDPOINT, 503)
        response = FakeDohResponse(doh_payload(a_record(PUBLIC_IP_2)))
        with mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
        ), mock.patch.object(
            proxy, "_doh_open", side_effect=[primary_error, response]
        ) as doh_open:
            result = proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(result, [(socket.AF_INET, (PUBLIC_IP_2, 443))])
        self.assertEqual(doh_open.call_count, 2)
        urls = self._urls(doh_open)
        self.assertEqual(
            [url.netloc for url in urls],
            ["dns.alidns.com", "cloudflare-dns.com"],
        )
        self.assertEqual([url.path for url in urls], ["/resolve", "/dns-query"])
        for call in doh_open.call_args_list:
            self.assertEqual(
                call.args[0].get_header("Accept"), "application/dns-json"
            )

    def test_primary_semantic_failure_does_not_fall_back(self):
        """Status != 0 is a response failure, not a transport failure."""
        response = FakeDohResponse(doh_payload(a_record(PUBLIC_IP), status=2))
        with mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
        ), mock.patch.object(proxy, "_doh_open", return_value=response) as doh_open:
            with self.assertRaises(proxy.ProxyError) as caught:
                proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(caught.exception.status, 502)
        self.assertEqual(doh_open.call_count, 1)
        self.assertEqual(self._urls(doh_open)[0].netloc, "dns.alidns.com")

    def test_http_errors_fail_closed_when_fallback_also_fails(self):
        """Acceptance: HTTP errors fail closed (both endpoints error)."""
        errors = [
            http_error(proxy.DOH_PRIMARY_ENDPOINT, 503),
            http_error(proxy.DOH_FALLBACK_ENDPOINT, 502),
        ]
        with mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
        ), mock.patch.object(proxy, "_doh_open", side_effect=errors) as doh_open:
            with self.assertRaises(proxy.ProxyError) as caught:
                proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(caught.exception.status, 502)
        self.assertEqual(doh_open.call_count, 2)

    def test_transport_errors_fail_closed(self):
        """URLError/timeouts fail closed after primary + Cloudflare attempts."""
        for error in (
            urllib.error.URLError("connection reset"),
            socket.timeout("timed out"),
        ):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(
                    proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
                ), mock.patch.object(
                    proxy, "_doh_open", side_effect=error
                ) as doh_open:
                    with self.assertRaises(proxy.ProxyError) as caught:
                        proxy.resolve_destination("push.example.com", 443)

                self.assertEqual(caught.exception.status, 502)
                self.assertEqual(doh_open.call_count, 2)

    def test_non_a_doh_answers_are_not_used(self):
        """Only type 1 (A) answers may become AF_INET destinations."""
        response = FakeDohResponse(
            doh_payload(
                {
                    "name": "push.example.com.",
                    "type": 28,
                    "data": "2606:2800:220:1::1",
                }
            )
        )
        with mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
        ), mock.patch.object(proxy, "_doh_open", return_value=response) as doh_open:
            with self.assertRaises(proxy.ProxyError) as caught:
                proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(doh_open.call_count, 1)

    def test_doh_hostname_is_url_encoded(self):
        """Hostile characters in the name cannot inject extra query fields."""
        host = "push.example.com&type=AAAA"
        response = FakeDohResponse(doh_payload(a_record(PUBLIC_IP)))
        with mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
        ), mock.patch.object(proxy, "_doh_open", return_value=response) as doh_open:
            proxy.resolve_destination(host, 443)

        request = doh_open.call_args.args[0]
        parsed = urllib.parse.urlsplit(request.full_url)
        self.assertEqual(
            urllib.parse.parse_qs(parsed.query),
            {"name": [host], "type": ["A"]},
        )

    def test_doh_timeout_is_capped_at_ten_seconds(self):
        """Timeout can never exceed 10s even if a caller asks for more."""
        response = FakeDohResponse(doh_payload(a_record(PUBLIC_IP)))
        with mock.patch.object(proxy, "_doh_open", return_value=response) as doh_open:
            proxy._doh_lookup("push.example.com", 443, timeout=120.0)

        self.assertLessEqual(doh_open.call_args.kwargs["timeout"], 10.0)

    def test_gaierror_uses_primary_doh(self):
        """A local resolution failure for a name is a fair DoH fallback case."""
        response = FakeDohResponse(doh_payload(a_record(PUBLIC_IP)))
        with mock.patch.object(
            proxy.socket, "getaddrinfo", side_effect=socket.gaierror("boom")
        ), mock.patch.object(proxy, "_doh_open", return_value=response) as doh_open:
            result = proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(result, [(socket.AF_INET, (PUBLIC_IP, 443))])
        self.assertEqual(self._urls(doh_open)[0].netloc, "dns.alidns.com")

    def test_successful_doh_result_is_cached_until_60_seconds(self):
        """Cache hit before 60s; entry expires at exactly 60s and is refreshed."""
        clock = [1000.0]
        responses = [
            FakeDohResponse(doh_payload(a_record(PUBLIC_IP))),
            FakeDohResponse(doh_payload(a_record(PUBLIC_IP_2))),
        ]
        with mock.patch.object(
            proxy.time, "monotonic", side_effect=lambda: clock[0]
        ), mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
        ) as getaddrinfo, mock.patch.object(
            proxy, "_doh_open", side_effect=responses
        ) as doh_open:
            first = proxy.resolve_destination("push.example.com", 443)
            clock[0] = 1059.999
            second = proxy.resolve_destination("push.example.com", 443)
            self.assertEqual(second, first)
            self.assertEqual(doh_open.call_count, 1)
            self.assertEqual(getaddrinfo.call_count, 1)

            clock[0] = 1060.0
            third = proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(third, [(socket.AF_INET, (PUBLIC_IP_2, 443))])
        self.assertEqual(doh_open.call_count, 2)
        self.assertEqual(getaddrinfo.call_count, 2)

    def test_transport_failure_is_not_cached(self):
        """A failed resolution must be retried, not served from cache."""
        response = FakeDohResponse(doh_payload(a_record(PUBLIC_IP)))
        errors = [
            urllib.error.URLError("primary down"),
            urllib.error.URLError("fallback down"),
        ]
        with mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
        ), mock.patch.object(
            proxy, "_doh_open", side_effect=errors + [response]
        ) as doh_open:
            with self.assertRaises(proxy.ProxyError):
                proxy.resolve_destination("push.example.com", 443)
            result = proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(result, [(socket.AF_INET, (PUBLIC_IP, 443))])
        self.assertEqual(doh_open.call_count, 3)

    def test_private_answer_is_not_cached(self):
        """A rejected private DoH answer must not poison the cache."""
        private_response = FakeDohResponse(doh_payload(a_record(PRIVATE_IP)))
        public_response = FakeDohResponse(doh_payload(a_record(PUBLIC_IP)))
        with mock.patch.object(
            proxy.socket, "getaddrinfo", return_value=system_addrs("10.0.0.5")
        ), mock.patch.object(
            proxy, "_doh_open", side_effect=[private_response, public_response]
        ) as doh_open:
            with self.assertRaises(proxy.ProxyError) as caught:
                proxy.resolve_destination("push.example.com", 443)
            result = proxy.resolve_destination("push.example.com", 443)

        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(result, [(socket.AF_INET, (PUBLIC_IP, 443))])
        self.assertEqual(doh_open.call_count, 2)

    def test_cache_is_bounded_and_evicts_oldest(self):
        """At most 128 entries; least-recently-used entry is evicted."""
        max_entries = proxy.DNS_CACHE_MAX_ENTRIES
        self.assertEqual(max_entries, 128)
        for index in range(max_entries + 1):
            proxy._cache_store(
                f"host{index}.example.com",
                443,
                [(socket.AF_INET, (PUBLIC_IP, 443))],
                now=1000.0,
            )

        with proxy._DNS_CACHE_LOCK:
            self.assertEqual(len(proxy._DNS_CACHE), max_entries)
        self.assertIsNone(
            proxy._cache_lookup("host0.example.com", 443, now=1001.0)
        )
        self.assertIsNotNone(
            proxy._cache_lookup(f"host{max_entries}.example.com", 443, now=1001.0)
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
