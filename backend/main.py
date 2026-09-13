"""
main.py
-------
نقطة تشغيل التطبيق. يجمع: قاعدة البيانات + REST API + WebSocket + خدمة الملفات الثابتة (Frontend).

التشغيل الموصى به (HTTPS تلقائي — مطلوب لعمل الميكروفون من غير جهاز السيرفر):
    python run.py

تشغيل بديل بدون HTTPS (فقط للتجربة السريعة من نفس الجهاز عبر 127.0.0.1):
    uvicorn main:app --host 0.0.0.0 --port 8000
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from typing import Optional, List

import database as db
import auth
from models import (
    RegisterRequest, LoginRequest, AuthResponse, UserOut, MessageOut,
    CreateGroupRequest, GroupOut, GroupMemberOut, GroupMessageOut, CallOut,
)
from ws_routes import router as ws_router
from discovery import start_discovery_responder, get_local_ip

HTTP_PORT = int(os.environ.get("PORT", 8000))
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")

_discovery_transport = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- Startup ---
    await db.init_db()
    global _discovery_transport
    try:
        _discovery_transport = await start_discovery_responder(HTTP_PORT)
    except OSError:
        _discovery_transport = None

    local_ip = get_local_ip()
    print("=" * 50)
    print("  LAN Voice Chat يعمل الآن")
    print(f"  افتح من هذا الجهاز:  http://127.0.0.1:{HTTP_PORT}")
    print(f"  افتح من الشبكة:      http://{local_ip}:{HTTP_PORT}")
    print("  ⚠️  المكالمات الصوتية من أجهزة أخرى تحتاج HTTPS — استخدم")
    print("      'python run.py' بدل هذا الأمر للحصول عليه تلقائيًا.")
    print("=" * 50)

    yield

    # --- Shutdown ---
    if _discovery_transport is not None:
        _discovery_transport.close()
    await db.close_db()


app = FastAPI(title="LAN Voice Chat", lifespan=lifespan)

# CORS مفتوح لأن التطبيق يعمل داخل شبكة محلية موثوقة فقط
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# ضغط الردود (خصوصًا سجل الرسائل الطويل) — تحسين كفاءة بسيط وبدون أي تعقيد إضافي
app.add_middleware(GZipMiddleware, minimum_size=512)

app.include_router(ws_router)


# ---------------------------------------------------------------------------
# Dependency: التحقق من هوية المستخدم عبر Authorization: Bearer <token>
# ---------------------------------------------------------------------------

async def get_current_user(authorization: Optional[str] = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="مطلوب تسجيل الدخول")
    token = authorization.removeprefix("Bearer ").strip()
    user_id = auth.get_user_id_from_token(token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="جلسة غير صالحة، سجّل الدخول من جديد")
    user = await db.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="المستخدم غير موجود")
    return user


# ---------------------------------------------------------------------------
# REST API: المصادقة
# ---------------------------------------------------------------------------

@app.post("/api/register", response_model=AuthResponse)
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


@app.post("/api/login", response_model=AuthResponse)
async def login(payload: LoginRequest):
    user = await db.get_user_by_username(payload.username)
    if not user or not auth.verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="اسم المستخدم أو كلمة المرور غير صحيحة")

    token = auth.create_token(user["id"])
    return AuthResponse(token=token, user_id=user["id"], username=user["username"])


@app.post("/api/logout")
async def logout(authorization: Optional[str] = Header(default=None)):
    if authorization and authorization.startswith("Bearer "):
        auth.revoke_token(authorization.removeprefix("Bearer ").strip())
    return {"ok": True}


# ---------------------------------------------------------------------------
# REST API: المستخدمون والرسائل
# ---------------------------------------------------------------------------

@app.get("/api/users", response_model=List[UserOut])
async def get_users(current_user: dict = Depends(get_current_user)):
    users = await db.list_users(exclude_id=current_user["id"])
    return users


@app.get("/api/messages/{peer_id}", response_model=List[MessageOut])
async def get_messages(peer_id: int, current_user: dict = Depends(get_current_user)):
    history = await db.get_message_history(current_user["id"], peer_id)
    return history


@app.get("/api/me", response_model=UserOut)
async def me(current_user: dict = Depends(get_current_user)):
    return current_user


@app.get("/api/calls", response_model=List[CallOut])
async def get_calls(current_user: dict = Depends(get_current_user)):
    return await db.get_recent_calls(current_user["id"])


# ---------------------------------------------------------------------------
# REST API: المجموعات
# ---------------------------------------------------------------------------

async def get_group_or_404_and_verify_member(group_id: int, current_user: dict) -> dict:
    group = await db.get_group(group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="المجموعة غير موجودة")
    if not await db.is_group_member(group_id, current_user["id"]):
        raise HTTPException(status_code=403, detail="لست عضوًا في هذه المجموعة")
    return group


@app.post("/api/groups", response_model=GroupOut)
async def create_group(payload: CreateGroupRequest, current_user: dict = Depends(get_current_user)):
    if not payload.name.strip():
        raise HTTPException(status_code=422, detail="اسم المجموعة مطلوب")

    group_id = await db.create_group(payload.name.strip(), current_user["id"], payload.member_ids)
    groups = await db.list_user_groups(current_user["id"])
    created = next((g for g in groups if g["id"] == group_id), None)
    return created


@app.get("/api/groups", response_model=List[GroupOut])
async def get_my_groups(current_user: dict = Depends(get_current_user)):
    return await db.list_user_groups(current_user["id"])


@app.get("/api/groups/{group_id}/members", response_model=List[GroupMemberOut])
async def get_group_members(group_id: int, current_user: dict = Depends(get_current_user)):
    await get_group_or_404_and_verify_member(group_id, current_user)
    return await db.list_group_members(group_id)


@app.get("/api/groups/{group_id}/messages", response_model=List[GroupMessageOut])
async def get_group_messages(group_id: int, current_user: dict = Depends(get_current_user)):
    await get_group_or_404_and_verify_member(group_id, current_user)
    return await db.get_group_message_history(group_id)


# ---------------------------------------------------------------------------
# خدمة الواجهة الأمامية (Frontend) كملفات ثابتة
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
