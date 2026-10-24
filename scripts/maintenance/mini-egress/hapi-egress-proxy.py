#!/usr/bin/env python3
"""Loopback-only HTTP CONNECT egress proxy for the offline HAPI Mac mini.

Why this exists
---------------
The mini has no default route.  The MacBook keeps one SSH session to the mini
for ingress (`-L 127.0.0.1:3006`).  We add one remote forward to that same
session (`-R 127.0.0.1:18080:127.0.0.1:18080`), so a listener on the mini's
loopback is this proxy.  The hub then gets HTTP_PROXY/HTTPS_PROXY pointing at
that loopback listener.

Safety properties
-----------------
* Binds 127.0.0.1 only.  There is deliberately no option to bind elsewhere.
* CONNECT only, destination port 443 by default (add --allow-port 80 only if
  truly needed).
* Resolves the destination once and refuses anything that is not globally
  routable (loopback, RFC1918, link-local, CGNAT, multicast, ULA, reserved).
  This prevents a local process on the mini from using the proxy to reach the
  MacBook or the LAN through the SSH tunnel.
* If a DNS name resolves only to non-public addresses (e.g. macOS VPN fake-IP
  DNS), asks AliDNS's public DNS-over-HTTPS JSON API for type-A records
  (Cloudflare is a fallback only when AliDNS is unreachable) and applies the
  same global-only check.  IP literals never use DoH, and any JSON or
  validation failure is fail-closed.  Successful public results are cached for
  at most 60 seconds in a bounded, thread-safe cache.
* Never terminates TLS, never installs a CA, never logs request paths or
  headers (CONNECT targets carry no secrets; push endpoint paths do).
* No credentials are stored here.  The SSH key/channel is the authentication
  boundary; the listener is loopback on both machines.

Usage
-----
  python3 hapi-egress-proxy.py --port 18080
  python3 hapi-egress-proxy.py --port 18080 --allow-port 80 --verbose

Exit codes: 0 healthy shutdown, 2 bad arguments/bind failure.
"""

from __future__ import annotations

from collections import OrderedDict
import argparse
import http.client
import ipaddress
import json
import logging
import os
import select
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

LISTEN_HOST = "127.0.0.1"
DEFAULT_PORT = 18080
MAX_HEADER_BYTES = 16 * 1024
UPSTREAM_CONNECT_TIMEOUT = 15.0
CLIENT_HEADER_TIMEOUT = 10.0
DEFAULT_IDLE_TIMEOUT = 120.0
DEFAULT_MAX_CONNECTIONS = 128
DOH_PRIMARY_ENDPOINT = "https://dns.alidns.com/resolve"
DOH_FALLBACK_ENDPOINT = "https://cloudflare-dns.com/dns-query"
DOH_TIMEOUT = 5.0
DOH_MAX_TIMEOUT = 10.0
DOH_MAX_RESPONSE_BYTES = 64 * 1024
DNS_CACHE_TTL = 60.0
DNS_CACHE_MAX_ENTRIES = 128

LOG = logging.getLogger("hapi-egress-proxy")
_DNS_CACHE = OrderedDict()
_DNS_CACHE_LOCK = threading.Lock()


class ProxyError(Exception):
    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


class DohTransportError(ProxyError):
    """The DoH endpoint could not be reached/read; fallback is allowed."""


def _reject_private(ip_text: str) -> None:
    try:
        ip = ipaddress.ip_address(ip_text)
    except ValueError as exc:
        raise ProxyError(403, "bad destination address") from exc
    # is_global is False for loopback, RFC1918, link-local, CGNAT, ULA,
    # multicast, unspecified and other special-use ranges.
    if not ip.is_global:
        raise ProxyError(403, "destination is not globally routable")


def _cache_lookup(host: str, port: int, now: float | None = None):
    """Return cached public addresses, or None on miss/expiry (LRU touch)."""
    if now is None:
        now = time.monotonic()
    key = (host.lower(), port)
    with _DNS_CACHE_LOCK:
        entry = _DNS_CACHE.get(key)
        if entry is None:
            return None
        expires_at, addresses = entry
        if now >= expires_at:
            del _DNS_CACHE[key]
            return None
        _DNS_CACHE.move_to_end(key)
        return list(addresses)


def _cache_store(host: str, port: int, addresses, now: float | None = None) -> None:
    """Cache a successful, already-validated public result for <=60 seconds."""
    if not addresses:
        return
    if now is None:
        now = time.monotonic()
    key = (host.lower(), port)
    expires_at = now + min(DNS_CACHE_TTL, 60.0)
    with _DNS_CACHE_LOCK:
        _DNS_CACHE[key] = (expires_at, tuple(addresses))
        _DNS_CACHE.move_to_end(key)
        while len(_DNS_CACHE) > DNS_CACHE_MAX_ENTRIES:
            _DNS_CACHE.popitem(last=False)


def _doh_open(request: urllib.request.Request, timeout: float):
    """Open a DoH request with environment proxies disabled.

    HTTPS_PROXY on the mini points at this very listener.  The default urllib
    opener would recurse through the proxy and the DoH lookup could never
    finish, so always use an opener with an empty ProxyHandler.
    """
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(request, timeout=timeout)


def _doh_lookup(
    host: str,
    port: int,
    endpoint: str = DOH_PRIMARY_ENDPOINT,
    timeout: float = DOH_TIMEOUT,
) -> list[tuple[int, tuple]]:
    """Resolve a DNS name at one DoH JSON endpoint; fail closed on any doubt.

    Only ``Status == 0`` responses with type-A (1) answers are accepted.  Every
    returned address is checked with the same global-only rule as the system
    resolver path; one non-public answer rejects the whole response rather than
    cherry-picking public ones.  A valid response with no public A answer is
    refused.  Transport/HTTP/read errors raise ``DohTransportError`` so the
    caller may try the fallback endpoint; JSON, schema, status and answer
    validation failures raise ``ProxyError`` and never trigger a fallback.
    """
    timeout = min(float(timeout), DOH_MAX_TIMEOUT)
    query = urllib.parse.urlencode({"name": host, "type": "A"})
    request = urllib.request.Request(
        f"{endpoint}?{query}",
        headers={"Accept": "application/dns-json"},
        method="GET",
    )
    try:
        with _doh_open(request, timeout=timeout) as response:
            body = response.read(DOH_MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as exc:
        raise DohTransportError(502, "doh transport failed") from exc

    if not isinstance(body, (bytes, bytearray)):
        raise ProxyError(502, "doh response invalid")
    if len(body) > DOH_MAX_RESPONSE_BYTES:
        raise ProxyError(502, "doh response too large")
    try:
        payload = json.loads(bytes(body).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ProxyError(502, "doh response invalid") from exc
    if not isinstance(payload, dict):
        raise ProxyError(502, "doh response invalid")

    status = payload.get("Status")
    if isinstance(status, bool) or not isinstance(status, int) or status != 0:
        raise ProxyError(502, "doh response status is not NOERROR")

    answers = payload.get("Answer", [])
    if not isinstance(answers, list):
        raise ProxyError(502, "doh response invalid")

    out: list[tuple[int, tuple]] = []
    seen = set()
    for answer in answers:
        if not isinstance(answer, dict):
            raise ProxyError(502, "doh response invalid")
        answer_type = answer.get("type")
        if not isinstance(answer_type, int) or isinstance(answer_type, bool):
            raise ProxyError(502, "doh response invalid")
        if answer_type != 1:
            continue  # DoH was asked for A records only; ignore other types.
        data = answer.get("data")
        if not isinstance(data, str):
            raise ProxyError(502, "doh response invalid")
        try:
            ip = ipaddress.ip_address(data)
        except ValueError as exc:
            raise ProxyError(502, "doh response invalid") from exc
        if ip.version != 4:
            continue
        _reject_private(str(ip))  # Private/loopback/etc. answer -> fail closed.
        ip_text = str(ip)
        if ip_text in seen:
            continue
        seen.add(ip_text)
        out.append((socket.AF_INET, (ip_text, port)))
    if not out:
        raise ProxyError(403, "doh returned no public A addresses")
    return out


def resolve_destination(host: str, port: int) -> list[tuple[int, tuple]]:
    """Resolve once, keep only globally routable addresses, preserve order.

    DNS names whose system resolution has no globally routable result get an
    AliDNS DoH A-record lookup, with Cloudflare only after a transport failure.
    Successful public results are cached for <=60s.  IP literals are checked
    directly and are never resolved through DoH or served from the cache.
    """
    host = host.strip()
    if not host or len(host) > 253:
        raise ProxyError(400, "bad host")
    if any(c in host for c in "\r\n\t /\\"):
        raise ProxyError(400, "bad host")

    # IPv6 CONNECT targets are bracketed: [2001:db8::1]:443
    literal = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        ip = ipaddress.ip_address(literal)
        _reject_private(str(ip))
        family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
        sockaddr = (str(ip), port, 0, 0) if family == socket.AF_INET6 else (str(ip), port)
        return [(family, sockaddr)]
    except ValueError:
        pass

    cached = _cache_lookup(host, port)
    if cached is not None:
        return cached

    try:
        infos = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror:
        # The local resolver failed; DoH is still a safe fallback for a name.
        infos = []

    out: list[tuple[int, tuple]] = []
    seen = set()
    for family, _socktype, _proto, _canon, sockaddr in infos:
        ip_text = sockaddr[0]
        try:
            _reject_private(ip_text)
        except ProxyError:
            continue
        key = (family, sockaddr)
        if key in seen:
            continue
        seen.add(key)
        out.append((family, sockaddr))
    if out:
        _cache_store(host, port, out)
        return out

    # macOS VPN/fake-IP DNS often returns only synthetic non-public addresses.
    # Re-resolve through AliDNS (primary for the China host).  Cloudflare is
    # tried only when AliDNS is unreachable; semantic failures stay fail-closed.
    LOG.info("no public system DNS result for %s; trying primary DoH", host)
    try:
        addresses = _doh_lookup(host, port, endpoint=DOH_PRIMARY_ENDPOINT)
    except DohTransportError as exc:
        LOG.warning(
            "primary DoH transport failed for %s: %s; trying fallback",
            host,
            exc.reason,
        )
        addresses = _doh_lookup(host, port, endpoint=DOH_FALLBACK_ENDPOINT)
    _cache_store(host, port, addresses)
    return addresses


def recv_headers(conn: socket.socket) -> tuple[str, bytes]:
    conn.settimeout(CLIENT_HEADER_TIMEOUT)
    data = bytearray()
    while b"\r\n\r\n" not in data:
        if len(data) > MAX_HEADER_BYTES:
            raise ProxyError(400, "request headers too large")
        chunk = conn.recv(4096)
        if not chunk:
            raise ProxyError(400, "client closed before headers")
        data.extend(chunk)
    head, _, rest = bytes(data).partition(b"\r\n\r\n")
    return head.decode("latin-1"), rest


def send_all(sock: socket.socket, data: bytes) -> None:
    """Send all bytes on a non-blocking socket, waiting for writability."""
    view = memoryview(data)
    while view:
        try:
            sent = sock.send(view)
        except BlockingIOError:
            try:
                select.select([], [sock], [], 1.0)
            except (OSError, ValueError) as exc:
                raise OSError("socket closed while writing") from exc
            continue
        if sent == 0:
            raise OSError("socket closed while writing")
        view = view[sent:]


def relay(client: socket.socket, upstream: socket.socket, idle_timeout: float) -> tuple[int, int]:
    """Copy both directions until both EOF or idle timeout. Returns byte counts."""
    client.setblocking(False)
    upstream.setblocking(False)
    c2u = 0
    u2c = 0
    client_open = True
    upstream_open = True
    last = time.monotonic()
    while client_open or upstream_open:
        if time.monotonic() - last > idle_timeout:
            break
        readers = []
        if client_open:
            readers.append(client)
        if upstream_open:
            readers.append(upstream)
        try:
            readable, _, _ = select.select(readers, [], [], 1.0)
        except (OSError, ValueError):
            break
        if not readable:
            continue
        for sock in readable:
            try:
                chunk = sock.recv(65536)
            except BlockingIOError:
                continue
            except OSError:
                chunk = b""
            if not chunk:
                last = time.monotonic()
                if sock is client:
                    client_open = False
                    try:
                        upstream.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                else:
                    upstream_open = False
                    try:
                        client.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                continue
            last = time.monotonic()
            try:
                if sock is client:
                    send_all(upstream, chunk)
                    c2u += len(chunk)
                else:
                    send_all(client, chunk)
                    u2c += len(chunk)
            except OSError:
                return c2u, u2c
    return c2u, u2c


def send_status(conn: socket.socket, status: int, reason: str) -> None:
    body = (reason + "\n").encode("utf-8", "replace")
    try:
        conn.sendall(
            f"HTTP/1.1 {status} {reason}\r\n"
            f"Content-Type: text/plain; charset=utf-8\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n\r\n".encode("ascii")
            + body
        )
    except OSError:
        pass


def handle_connection(
    conn: socket.socket,
    peer: tuple,
    allowed_ports: set[int],
    idle_timeout: float,
    conn_id: int,
) -> None:
    started = time.monotonic()
    target = "-"
    status = 0
    c2u = u2c = 0
    upstream = None
    try:
        head, rest = recv_headers(conn)
        lines = head.split("\r\n")
        if not lines or not lines[0]:
            raise ProxyError(400, "empty request")
        parts = lines[0].split(" ")
        if len(parts) != 3:
            raise ProxyError(400, "malformed request line")
        method, request_target, version = parts
        if method.upper() != "CONNECT":
            raise ProxyError(405, "only CONNECT is supported")
        if not version.startswith("HTTP/"):
            raise ProxyError(400, "bad HTTP version")
        if request_target.startswith("["):
            host, sep, port_text = request_target.rpartition("]:")
            host = host[1:]
            if not sep:
                raise ProxyError(400, "bad CONNECT target")
        else:
            host, sep, port_text = request_target.rpartition(":")
            if not sep:
                raise ProxyError(400, "CONNECT target needs host:port")
        if not port_text.isdigit():
            raise ProxyError(400, "bad CONNECT port")
        port = int(port_text)
        if port < 1 or port > 65535:
            raise ProxyError(400, "bad CONNECT port")
        target = f"{host}:{port}"
        if port not in allowed_ports:
            raise ProxyError(403, f"port {port} is not allowed")
        addresses = resolve_destination(host, port)

        chosen = None
        last_error: Exception | None = None
        for family, sockaddr in addresses:
            candidate = socket.socket(family, socket.SOCK_STREAM)
            candidate.settimeout(UPSTREAM_CONNECT_TIMEOUT)
            try:
                candidate.connect(sockaddr)
                chosen = (candidate, sockaddr[0])
                break
            except OSError as exc:
                last_error = exc
                candidate.close()
        if chosen is None:
            raise ProxyError(502, f"connect failed: {last_error}")
        upstream, ip = chosen
        upstream.settimeout(None)
        try:
            upstream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        if rest:
            upstream.sendall(rest)
            c2u += len(rest)
        c2u_delta, u2c = relay(conn, upstream, idle_timeout)
        c2u += c2u_delta
        status = 200
        LOG.info(
            "ok id=%d %s -> %s bytes_out=%d bytes_in=%d ms=%d",
            conn_id, target, ip, c2u, u2c, int((time.monotonic() - started) * 1000),
        )
    except ProxyError as exc:
        status = exc.status
        send_status(conn, exc.status, exc.reason)
        LOG.warning(
            "deny id=%d %s status=%d reason=%s", conn_id, target, exc.status, exc.reason
        )
    except (socket.timeout, TimeoutError):
        send_status(conn, 504, "upstream or client timeout")
        LOG.warning("timeout id=%d %s", conn_id, target)
    except Exception as exc:  # noqa: BLE001 - proxy must not die on one client
        send_status(conn, 502, "proxy error")
        LOG.warning("error id=%d %s type=%s", conn_id, target, type(exc).__name__)
    finally:
        for sock in (conn, upstream):
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Loopback-only HTTP CONNECT egress proxy")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--allow-port",
        type=int,
        action="append",
        dest="allowed_ports",
        help="destination port to allow (repeatable; default: 443)",
    )
    parser.add_argument("--idle-timeout", type=float, default=DEFAULT_IDLE_TIMEOUT)
    parser.add_argument("--max-connections", type=int, default=DEFAULT_MAX_CONNECTIONS)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    if args.port < 1 or args.port > 65535:
        parser.error("--port must be 1..65535")
    allowed_ports = set(args.allowed_ports or [443])
    if any(p < 1 or p > 65535 for p in allowed_ports):
        parser.error("--allow-port must be 1..65535")
    if args.max_connections < 1:
        parser.error("--max-connections must be positive")

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind((LISTEN_HOST, args.port))
        listener.listen(64)
    except OSError as exc:
        LOG.error("cannot bind %s:%d: %s", LISTEN_HOST, args.port, exc)
        return 2

    stop = threading.Event()
    semaphore = threading.BoundedSemaphore(args.max_connections)

    def _stop(_signum, _frame):
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    LOG.info(
        "listening on %s:%d allowed_ports=%s max_connections=%d python=%s",
        LISTEN_HOST, args.port, sorted(allowed_ports), args.max_connections,
        ".".join(str(x) for x in sys.version_info[:3]),
    )

    conn_id = 0
    listener.settimeout(1.0)
    try:
        while not stop.is_set():
            try:
                conn, peer = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                if stop.is_set():
                    break
                continue
            conn_id += 1
            if not semaphore.acquire(blocking=False):
                send_status(conn, 503, "proxy connection limit reached")
                LOG.warning("busy id=%d peer=%s", conn_id, peer[0])
                try:
                    conn.close()
                except OSError:
                    pass
                continue
            try:
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            thread = threading.Thread(
                target=_serve,
                args=(conn, peer, allowed_ports, args.idle_timeout, conn_id, semaphore),
                daemon=True,
            )
            thread.start()
    finally:
        listener.close()
        LOG.info("stopped")
    return 0


def _serve(conn, peer, allowed_ports, idle_timeout, conn_id, semaphore) -> None:
    try:
        handle_connection(conn, peer, allowed_ports, idle_timeout, conn_id)
    finally:
        semaphore.release()


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(0)
