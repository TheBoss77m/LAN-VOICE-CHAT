"""
group_call_manager.py
----------------------
[Service] يتتبع من هو "داخل" مكالمة جماعية معينة الآن (Roster حيّ).
"""

from typing import Dict, Optional, List, Tuple


class GroupCallManager:
    def __init__(self) -> None:
        self.rosters: Dict[int, Dict[int, str]] = {}
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
        roster = self.rosters.get(group_id)
        if roster:
            roster.pop(user_id, None)
        is_empty = not roster
        if is_empty:
            self.rosters.pop(group_id, None)
            self.active_call_id.pop(group_id, None)
        return is_empty

    def leave_all_groups_for_user(self, user_id: int) -> List[Tuple[int, Optional[int], bool]]:
        results = []
        for group_id in list(self.rosters.keys()):
            if user_id in self.rosters.get(group_id, {}):
                call_id = self.active_call_id.get(group_id)
                is_empty = self.leave(group_id, user_id)
                results.append((group_id, call_id, is_empty))
        return results


group_call_manager = GroupCallManager()
