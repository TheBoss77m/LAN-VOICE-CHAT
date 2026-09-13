"""
call_manager.py
---------------
إدارة الحالة اللحظية (In-Memory State) للمكالمات الثنائية (1:1 Voice & Video Calls).
يتتبع المستخدمين المنخرطين في مكالمات نشطة لمنع التضارب وحالات انشغال الخط (Busy)
وتنظيف المكالمات تلقائيًا عند انقطاع الاتصال المفاجئ.
"""

from typing import Dict, Optional, Any


class CallState:
    IDLE = "idle"
    CALLING = "calling"
    RINGING = "ringing"
    CONNECTED = "connected"
    ENDED = "ended"


class CallManager:
    def __init__(self) -> None:
        # user_id -> call session info dict
        self._user_calls: Dict[int, Dict[str, Any]] = {}

    def is_in_call(self, user_id: int) -> bool:
        """يتحقق مما إذا كان المستخدم في مكالمة حاليًا (رنين أو اتصال نشط)."""
        return user_id in self._user_calls

    def get_call(self, user_id: int) -> Optional[Dict[str, Any]]:
        return self._user_calls.get(user_id)

    def register_call(
        self, caller_id: int, receiver_id: int, call_id: int, call_type: str = "voice"
    ) -> None:
        """تسجيل بدء محاولة اتصال بين طرفين."""
        session = {
            "call_id": call_id,
            "caller_id": caller_id,
            "receiver_id": receiver_id,
            "call_type": call_type,
            "state": CallState.CALLING,
        }
        self._user_calls[caller_id] = session
        self._user_calls[receiver_id] = {**session, "state": CallState.RINGING}

    def set_connected(self, user_id: int) -> None:
        """تحديث حالة المكالمة إلى متصل للطرفين."""
        session = self._user_calls.get(user_id)
        if not session:
            return
        caller_id = session["caller_id"]
        receiver_id = session["receiver_id"]

        if caller_id in self._user_calls:
            self._user_calls[caller_id]["state"] = CallState.CONNECTED
        if receiver_id in self._user_calls:
            self._user_calls[receiver_id]["state"] = CallState.CONNECTED

    def end_call(self, user_id: int) -> Optional[Dict[str, Any]]:
        """إنهاء المكالمة وإزالة الطرفين من التتبع، ويرجع معلومات المكالمة المنتهية."""
        session = self._user_calls.pop(user_id, None)
        if not session:
            return None

        peer_id = (
            session["receiver_id"]
            if user_id == session["caller_id"]
            else session["caller_id"]
        )
        self._user_calls.pop(peer_id, None)
        return {
            "call_id": session.get("call_id"),
            "peer_id": peer_id,
            "call_type": session.get("call_type", "voice"),
        }

    def handle_disconnect(self, user_id: int) -> Optional[Dict[str, Any]]:
        """معالجة انقطاع اتصال أحد الطرفين أثناء مكالمة جارية."""
        return self.end_call(user_id)


call_manager = CallManager()
