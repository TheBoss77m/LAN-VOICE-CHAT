"""
calls_controller.py
-------------------
[Controller] متحكم سجل المكالمات الصوتية والمرئية.
"""

from typing import List
from fastapi import APIRouter, Depends

from models.schemas import CallOut
import models.database as db
from .deps import get_current_user

router = APIRouter(prefix="/api/calls", tags=["Calls"])


@router.get("", response_model=List[CallOut])
async def get_calls(current_user: dict = Depends(get_current_user)):
    return await db.get_recent_calls(current_user["id"])
