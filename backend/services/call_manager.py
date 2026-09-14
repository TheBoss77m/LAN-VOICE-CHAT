"""
call_manager.py
---------------
[Service] إدارة الحالة اللحظية (In-Memory State) للمكالمات الثنائية (1:1 Voice & Video Calls).
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
        self._user_calls: Dict[int, Dict[str, Any]] = {}

    def is_in_call(self, user_id: int) -> bool:
        return user_id in self._user_calls

    def get_call(self, user_id: int) -> Optional[Dict[str, Any]]:
        return self._user_calls.get(user_id)

    def register_call(
        self, caller_id: int, receiver_id: int, call_id: int, call_type: str = "voice"
    ) -> None:
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
        return self.end_call(user_id)


call_manager = CallManager()
