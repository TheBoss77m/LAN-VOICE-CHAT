"""
discovery_service.py
--------------------
[Service] مستجيب UDP Broadcast لمساعدة الأجهزة على اكتشاف عنوان السيرفر في الشبكة المحلية تلقائيًا.
"""

import asyncio
import json
import socket

MAGIC_REQUEST = b"LAN_VOICE_CHAT_DISCOVER"
DEFAULT_UDP_PORT = 37020


def get_local_ip() -> str:
    """يحصل على عنوان IP المحلي للجهاز بطريقة موثوقة."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


class _DiscoveryProtocol(asyncio.DatagramProtocol):
    def __init__(self, http_port: int) -> None:
        self.http_port = http_port
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport: asyncio.DatagramTransport) -> None:
        self.transport = transport

    def datagram_received(self, data: bytes, addr) -> None:
        if data.strip() == MAGIC_REQUEST:
            response = json.dumps(
                {
                    "service": "LAN_VOICE_CHAT",
                    "ip": get_local_ip(),
                    "port": self.http_port,
                    "url": f"http://{get_local_ip()}:{self.http_port}",
                }
            ).encode("utf-8")
            self.transport.sendto(response, addr)


async def start_discovery_responder(http_port: int, udp_port: int = DEFAULT_UDP_PORT):
    loop = asyncio.get_running_loop()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    except (AttributeError, OSError):
        pass
    sock.bind(("0.0.0.0", udp_port))
    sock.setblocking(False)

    transport, _ = await loop.create_datagram_endpoint(
        lambda: _DiscoveryProtocol(http_port), sock=sock
    )
    return transport
