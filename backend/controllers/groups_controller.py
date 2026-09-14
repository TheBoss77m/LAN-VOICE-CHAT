"""
groups_controller.py
--------------------
[Controller] متحكم المجموعات والرسائل الجماعية.
"""

from typing import List
from fastapi import APIRouter, HTTPException, Depends

from models.schemas import CreateGroupRequest, GroupOut, GroupMemberOut, GroupMessageOut
import models.database as db
from .deps import get_current_user

router = APIRouter(prefix="/api/groups", tags=["Groups"])


async def get_group_or_404_and_verify_member(group_id: int, current_user: dict) -> dict:
    group = await db.get_group(group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="المجموعة غير موجودة")
    if not await db.is_group_member(group_id, current_user["id"]):
        raise HTTPException(status_code=403, detail="لست عضوًا في هذه المجموعة")
    return group


@router.post("", response_model=GroupOut)
async def create_group(payload: CreateGroupRequest, current_user: dict = Depends(get_current_user)):
    if not payload.name.strip():
        raise HTTPException(status_code=422, detail="اسم المجموعة مطلوب")

    group_id = await db.create_group(payload.name.strip(), current_user["id"], payload.member_ids)
    groups = await db.list_user_groups(current_user["id"])
    created = next((g for g in groups if g["id"] == group_id), None)
    return created


@router.get("", response_model=List[GroupOut])
async def get_my_groups(current_user: dict = Depends(get_current_user)):
    return await db.list_user_groups(current_user["id"])


@router.get("/{group_id}/members", response_model=List[GroupMemberOut])
async def get_group_members(group_id: int, current_user: dict = Depends(get_current_user)):
    await get_group_or_404_and_verify_member(group_id, current_user)
    return await db.list_group_members(group_id)


@router.get("/{group_id}/messages", response_model=List[GroupMessageOut])
async def get_group_messages(group_id: int, current_user: dict = Depends(get_current_user)):
    await get_group_or_404_and_verify_member(group_id, current_user)
    return await db.get_group_message_history(group_id)
