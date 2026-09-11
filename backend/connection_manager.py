"""
connection_manager.py
----------------------
يحتفظ بخريطة user_id -> WebSocket للمستخدمين المتصلين حاليًا،
ويوفر دوال إرسال مباشرة (unicast) وبث عام (broadcast).
"""

from typing import Dict, Optional, Any
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: Dict[int, WebSocket] = {}

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        self.active_connections[user_id] = websocket

    def disconnect(self, user_id: int) -> None:
        self.active_connections.pop(user_id, None)

    def is_online(self, user_id: int) -> bool:
        return user_id in self.active_connections

    async def send_to(self, user_id: int, data: Dict[str, Any]) -> bool:
        """يرسل رسالة لمستخدم معيّن. يرجع False لو غير متصل حاليًا."""
        ws = self.active_connections.get(user_id)
        if ws is None:
            return False
        try:
            await ws.send_json(data)
            return True
        except Exception:
            # الاتصال قد يكون تعطّل للتو
            self.disconnect(user_id)
            return False

    async def broadcast(self, data: Dict[str, Any], exclude: Optional[int] = None) -> None:
        for user_id, ws in list(self.active_connections.items()):
            if user_id == exclude:
                continue
            try:
                await ws.send_json(data)
            except Exception:
                self.disconnect(user_id)


# نسخة واحدة مشتركة تُستخدم في كل التطبيق
manager = ConnectionManager()
