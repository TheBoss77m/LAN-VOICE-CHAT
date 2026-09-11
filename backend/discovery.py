"""
discovery.py
------------
مسؤول عن جزء واحد فقط: مساعدة الأجهزة على إيجاد عنوان السيرفر تلقائيًا
عبر UDP Broadcast، بدل كتابة الـ IP يدويًا كل مرة.

⚠️ ملاحظة تقنية مهمة (تصحيح عن الخطة الأولية):
    متصفح الويب (JavaScript) لا يستطيع إرسال أو استقبال حزم UDP لأسباب أمنية،
    فلا يمكن لصفحة الويب نفسها أن "تكتشف" السيرفر عبر UDP مباشرة.
    لذلك هذا الموديول مفيد لو بنيتم لاحقًا أداة صغيرة (سطر أوامر أو تطبيق مساعد)
    تكتشف عنوان السيرفر ثم تفتح المتصفح على العنوان الصحيح تلقائيًا.
    أما من داخل المتصفح مباشرة، فالحل العملي هو إدخال عنوان السيرفر مرة واحدة
    (ويُحفظ بعدها في localStorage)، وهذا ما يعتمده الـ Frontend الحالي.

يشتغل هذا الموديول كخدمة خلفية (background task) مع FastAPI:
- يستمع على منفذ UDP محدد.
- عند استقبال رسالة الاكتشاف الصحيحة، يرد بعنوان IP والمنفذ الذي يعمل عليه HTTP.
"""

import asyncio
import json
import socket

MAGIC_REQUEST = b"LAN_VOICE_CHAT_DISCOVER"
DEFAULT_UDP_PORT = 37020


def get_local_ip() -> str:
    """يحصل على عنوان IP المحلي للجهاز بطريقة موثوقة (بدون إرسال بيانات فعليًا)."""
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
    """يشغّل مستمع UDP في الخلفية. يرجع الـ transport عشان تقدر تقفله عند إيقاف السيرفر."""
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
