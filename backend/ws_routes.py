"""
ws_routes.py
------------
نقطة اتصال WebSocket الوحيدة (/ws?token=...). تتعامل مع أربعة أنواع من التفاعل:

  1. حالة الاتصال (Online/Offline).
  2. رسائل نصية ثنائية (chat_message).
  3. رسائل نصية جماعية (group_message).
  4. إشارات WebRTC (Signaling فقط):
       - مكالمة ثنائية: call_offer / call_answer / ice_candidate / call_reject / call_end
       - مكالمة جماعية (Mesh): group_call_join / group_call_leave / group_call_invite
         بالإضافة لإعادة استخدام نفس رسائل call_offer/call_answer/ice_candidate
         (لأن كل اتصال داخل المكالمة الجماعية هو، تقنيًا، اتصال WebRTC ثنائي
         منفصل بين كل شخصين — هذا ما يُعرف بترتيب Mesh).

ملاحظة عن حدود Mesh: كل مشارك يفتح اتصالًا مباشرًا مع كل مشارك آخر، فحمل
المعالجة والشبكة يزداد مع (عدد المشاركين). هذا ممتاز على شبكة محلية بعدد
صغير (حتى 6-8 أشخاص تقريبًا)، لكن لأعداد أكبر يحتاج المشروع لاحقًا خادم
وسيط لتوزيع الوسائط (SFU) — خارج نطاق هذا المشروع الدراسي.
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from typing import Optional

import auth
import database as db
from connection_manager import manager
from group_call_manager import group_call_manager

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: Optional[str] = Query(default=None)):
    user_id = auth.get_user_id_from_token(token) if token else None
    if user_id is None:
        await websocket.close(code=4401)
        return

    user = await db.get_user_by_id(user_id)
    if user is None:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    await manager.connect(user_id, websocket)
    await db.set_user_status(user_id, "online")

    await manager.broadcast(
        {"type": "user_status", "user_id": user_id, "username": user["username"], "status": "online"},
        exclude=user_id,
    )

    try:
        while True:
            data = await websocket.receive_json()
            await _handle_incoming(user_id, user["username"], data)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        # معالجة قطع الاتصال المفاجئ: تحديث الحالة + الخروج من أي مكالمة جماعية نشطة
        manager.disconnect(user_id)
        await db.set_user_status(user_id, "offline")
        await manager.broadcast(
            {"type": "user_status", "user_id": user_id, "username": user["username"], "status": "offline"},
        )
        await _cleanup_group_calls_on_disconnect(user_id)


async def _cleanup_group_calls_on_disconnect(user_id: int) -> None:
    for group_id, call_id, is_empty in group_call_manager.leave_all_groups_for_user(user_id):
        if call_id:
            await db.mark_group_call_participant_left(call_id, user_id)
            if is_empty:
                await db.end_group_call(call_id)
        await _broadcast_to_group_members(
            group_id,
            {"type": "group_call_participant_left", "group_id": group_id, "user_id": user_id},
            exclude=user_id,
        )


async def _broadcast_to_group_members(group_id: int, payload: dict, exclude: Optional[int] = None) -> None:
    member_ids = await db.list_group_member_ids(group_id)
    for uid in member_ids:
        if uid == exclude:
            continue
        await manager.send_to(uid, payload)


async def _handle_incoming(sender_id: int, sender_username: str, data: dict) -> None:
    msg_type = data.get("type")

    # ---------------------------------------------------------------
    # 1) رسالة نصية ثنائية
    # ---------------------------------------------------------------
    if msg_type == "chat_message":
        receiver_id = data.get("to")
        text = (data.get("message") or "").strip()
        if not receiver_id or not text:
            return

        saved = await db.save_message(sender_id, receiver_id, text)
        payload = {
            "type": "chat_message",
            "from": sender_id,
            "from_username": sender_username,
            "to": receiver_id,
            "message": text,
            "timestamp": saved["timestamp"],
            "id": saved["id"],
        }
        await manager.send_to(receiver_id, payload)
        await manager.send_to(sender_id, {**payload, "self_echo": True})

    # ---------------------------------------------------------------
    # 2) رسالة نصية جماعية
    # ---------------------------------------------------------------
    elif msg_type == "group_message":
        group_id = data.get("group_id")
        text = (data.get("message") or "").strip()
        if not group_id or not text:
            return
        if not await db.is_group_member(group_id, sender_id):
            return  # تجاهل صامت: مستخدم يحاول الكتابة بمجموعة ليس عضوًا فيها

        saved = await db.save_group_message(group_id, sender_id, text)
        payload = {
            "type": "group_message",
            "group_id": group_id,
            "from": sender_id,
            "from_username": sender_username,
            "message": text,
            "timestamp": saved["timestamp"],
            "id": saved["id"],
        }
        await _broadcast_to_group_members(group_id, payload)  # يشمل المرسل نفسه لتأكيد الاستلام

    # ---------------------------------------------------------------
    # 3) إشارات WebRTC — مكالمة ثنائية أو طرف داخل مكالمة جماعية (Mesh)
    #    (نفس الرسائل تُستخدم للحالتين؛ حقل group_id اختياري يُمرَّر كما هو)
    # ---------------------------------------------------------------
    elif msg_type == "call_offer":
        receiver_id = data.get("to")
        sdp = data.get("sdp")
        group_id = data.get("group_id")  # موجود فقط إذا كان العرض جزءًا من مكالمة جماعية
        if not receiver_id or sdp is None:
            return

        delivered = await manager.send_to(
            receiver_id,
            {
                "type": "call_offer",
                "from": sender_id,
                "from_username": sender_username,
                "sdp": sdp,
                "group_id": group_id,
            },
        )
        if delivered:
            if not group_id:
                # مكالمة ثنائية عادية: نسجلها كسجل call
                call_id = await db.create_call(sender_id, receiver_id)
                await manager.send_to(sender_id, {"type": "call_id", "call_id": call_id, "peer": receiver_id})
        else:
            await manager.send_to(
                sender_id, {"type": "call_error", "reason": "user_offline", "peer": receiver_id}
            )

    elif msg_type == "call_answer":
        receiver_id = data.get("to")
        sdp = data.get("sdp")
        if not receiver_id or sdp is None:
            return
        await manager.send_to(receiver_id, {"type": "call_answer", "from": sender_id, "sdp": sdp})

    elif msg_type == "ice_candidate":
        receiver_id = data.get("to")
        candidate = data.get("candidate")
        if not receiver_id or candidate is None:
            return
        await manager.send_to(receiver_id, {"type": "ice_candidate", "from": sender_id, "candidate": candidate})

    elif msg_type == "call_reject":
        receiver_id = data.get("to")
        if receiver_id:
            await manager.send_to(receiver_id, {"type": "call_reject", "from": sender_id})

    elif msg_type == "call_end":
        receiver_id = data.get("to")
        call_id = data.get("call_id")
        if call_id:
            await db.update_call_status(call_id, "ended", ended=True)
        if receiver_id:
            await manager.send_to(receiver_id, {"type": "call_end", "from": sender_id})

    # ---------------------------------------------------------------
    # 4) المكالمات الجماعية — دعوة / انضمام / مغادرة
    # ---------------------------------------------------------------
    elif msg_type == "group_call_invite":
        group_id = data.get("group_id")
        if not group_id or not await db.is_group_member(group_id, sender_id):
            return
        await _broadcast_to_group_members(
            group_id,
            {
                "type": "group_call_incoming",
                "group_id": group_id,
                "from": sender_id,
                "from_username": sender_username,
            },
            exclude=sender_id,
        )

    elif msg_type == "group_call_join":
        group_id = data.get("group_id")
        if not group_id or not await db.is_group_member(group_id, sender_id):
            return

        # المشاركون الموجودون قبل انضمام هذا المستخدم — هو من سيبدأ الاتصال بهم
        existing_participants = group_call_manager.get_participants(group_id)

        if not group_call_manager.is_active(group_id):
            call_id = await db.create_group_call(group_id, sender_id)
            group_call_manager.start(group_id, call_id)
        else:
            call_id = group_call_manager.get_call_id(group_id)

        group_call_manager.join(group_id, sender_id, sender_username)
        await db.add_group_call_participant(call_id, sender_id)

        # نرسل للمنضم الجديد قائمة من يجب أن يتصل بهم مباشرة
        await manager.send_to(
            sender_id,
            {
                "type": "group_call_roster",
                "group_id": group_id,
                "call_id": call_id,
                "participants": [
                    {"id": uid, "username": uname} for uid, uname in existing_participants.items()
                ],
            },
        )
        # نعلم البقية بوجود عضو جديد (لتحديث الواجهة فقط؛ الاتصال يبدأه المنضم الجديد)
        await _broadcast_to_group_members(
            group_id,
            {
                "type": "group_call_participant_joined",
                "group_id": group_id,
                "user_id": sender_id,
                "username": sender_username,
            },
            exclude=sender_id,
        )

    elif msg_type == "group_call_leave":
        group_id = data.get("group_id")
        if not group_id:
            return
        call_id = group_call_manager.get_call_id(group_id)
        is_empty = group_call_manager.leave(group_id, sender_id)

        if call_id:
            await db.mark_group_call_participant_left(call_id, sender_id)
            if is_empty:
                await db.end_group_call(call_id)

        await _broadcast_to_group_members(
            group_id,
            {"type": "group_call_participant_left", "group_id": group_id, "user_id": sender_id},
            exclude=sender_id,
        )
