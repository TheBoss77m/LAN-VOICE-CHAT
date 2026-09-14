"""
controllers/deps.py
-------------------
تبعيات التحقق من هوية المستخدم (Authentication Dependencies).
"""

from typing import Optional
from fastapi import Header, HTTPException

from services.auth_service import get_user_id_from_token
from models.database import get_user_by_id


async def get_current_user(authorization: Optional[str] = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="مطلوب تسجيل الدخول")
    token = authorization.removeprefix("Bearer ").strip()
    user_id = get_user_id_from_token(token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="جلسة غير صالحة، سجّل الدخول من جديد")
    user = await get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="المستخدم غير موجود")
    return user
