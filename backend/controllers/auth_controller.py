"""
auth_controller.py
-------------------
[Controller] متحكم المصادقة وتسجيل الدخول والخروج.
"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Header

from models.schemas import RegisterRequest, LoginRequest, AuthResponse
import models.database as db
import services.auth_service as auth

router = APIRouter(prefix="/api", tags=["Auth"])


@router.post("/register", response_model=AuthResponse)
async def register(payload: RegisterRequest):
    existing = await db.get_user_by_username(payload.username)
    if existing:
        raise HTTPException(status_code=409, detail="اسم المستخدم مستخدم بالفعل")

    password_hash = auth.hash_password(payload.password)
    user_id = await db.create_user(payload.username, password_hash)
    if user_id is None:
        raise HTTPException(status_code=409, detail="اسم المستخدم مستخدم بالفعل")

    token = auth.create_token(user_id)
    return AuthResponse(token=token, user_id=user_id, username=payload.username)


@router.post("/login", response_model=AuthResponse)
async def login(payload: LoginRequest):
    user = await db.get_user_by_username(payload.username)
    if not user or not auth.verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="اسم المستخدم أو كلمة المرور غير صحيحة")

    token = auth.create_token(user["id"])
    return AuthResponse(token=token, user_id=user["id"], username=user["username"])


@router.post("/logout")
async def logout(authorization: Optional[str] = Header(default=None)):
    if authorization and authorization.startswith("Bearer "):
        auth.revoke_token(authorization.removeprefix("Bearer ").strip())
    return {"ok": True}
