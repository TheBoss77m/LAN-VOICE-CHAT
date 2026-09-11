"""
group_call_manager.py
----------------------
يتتبع من هو "داخل" مكالمة جماعية معينة الآن (Roster حيّ)، بشكل منفصل عن
قاعدة البيانات — لأن هذا نوع من الحالة اللحظية (Ephemeral State) لا يحتاج
تخزين دائم، تمامًا مثل ConnectionManager.

قاعدة البيانات (جدولا group_calls و group_call_participants) تحتفظ فقط
بسجل تاريخي: متى بدأت المكالمة، من شارك، ومتى انتهت.
"""

from typing import Dict, Optional


class GroupCallManager:
    def __init__(self) -> None:
        # group_id -> {user_id: username}
        self.rosters: Dict[int, Dict[int, str]] = {}
        # group_id -> رقم المكالمة الحالي في قاعدة البيانات
        self.active_call_id: Dict[int, int] = {}

    def is_active(self, group_id: int) -> bool:
        return bool(self.rosters.get(group_id))

    def get_call_id(self, group_id: int) -> Optional[int]:
        return self.active_call_id.get(group_id)

    def get_participants(self, group_id: int) -> Dict[int, str]:
        return dict(self.rosters.get(group_id, {}))

    def start(self, group_id: int, call_id: int) -> None:
        self.rosters.setdefault(group_id, {})
        self.active_call_id[group_id] = call_id

    def join(self, group_id: int, user_id: int, username: str) -> None:
        self.rosters.setdefault(group_id, {})[user_id] = username

    def leave(self, group_id: int, user_id: int) -> bool:
        """يحذف المستخدم من القائمة. يرجع True لو أصبحت المكالمة فارغة تمامًا."""
        roster = self.rosters.get(group_id)
        if roster:
            roster.pop(user_id, None)
        is_empty = not roster
        if is_empty:
            self.rosters.pop(group_id, None)
            self.active_call_id.pop(group_id, None)
        return is_empty

    def leave_all_groups_for_user(self, user_id: int):
        """يُستدعى عند قطع اتصال WebSocket بالكامل (خروج/انقطاع مفاجئ).
        يرجع قائمة [(group_id, call_id, أصبحت_فارغة)] لكل مجموعة كان بها."""
        results = []
        for group_id in list(self.rosters.keys()):
            if user_id in self.rosters.get(group_id, {}):
                call_id = self.active_call_id.get(group_id)
                is_empty = self.leave(group_id, user_id)
                results.append((group_id, call_id, is_empty))
        return results


group_call_manager = GroupCallManager()
