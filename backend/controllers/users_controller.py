"""
users_controller.py
-------------------
[Controller] متحكم المستخدمين والرسائل الثنائية الخاصة.
"""

from typing import List
from fastapi import APIRouter, Depends

from models.schemas import UserOut, MessageOut
import models.database as db
from .deps import get_current_user

router = APIRouter(prefix="/api", tags=["Users & Messages"])


@router.get("/users", response_model=List[UserOut])
async def get_users(current_user: dict = Depends(get_current_user)):
    return await db.list_users(exclude_id=current_user["id"])


@router.get("/me", response_model=UserOut)
async def me(current_user: dict = Depends(get_current_user)):
    return current_user


@router.get("/messages/{peer_id}", response_model=List[MessageOut])
async def get_messages(peer_id: int, current_user: dict = Depends(get_current_user)):
    return await db.get_message_history(current_user["id"], peer_id)
