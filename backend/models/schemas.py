"""
schemas.py
----------
[Model] نماذج البيانات والتحقق (Pydantic Models) الخاصة بطلبات وردود REST API.
"""

from typing import Optional, List
from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    username: str = Field(min_length=2, max_length=30)
    password: str = Field(min_length=4, max_length=100)


class LoginRequest(BaseModel):
    username: str
    password: str


class AuthResponse(BaseModel):
    token: str
    user_id: int
    username: str


class UserOut(BaseModel):
    id: int
    username: str
    status: str
    last_seen: Optional[str] = None


class MessageOut(BaseModel):
    id: int
    sender_id: int
    receiver_id: int
    message: str
    timestamp: str


class CreateGroupRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    member_ids: List[int] = Field(default_factory=list)


class GroupOut(BaseModel):
    id: int
    name: str
    created_by: int
    member_count: int


class GroupMemberOut(BaseModel):
    id: int
    username: str
    status: str
    last_seen: Optional[str] = None


class GroupMessageOut(BaseModel):
    id: int
    group_id: int
    sender_id: int
    message: str
    timestamp: str


class CallOut(BaseModel):
    id: int
    caller_id: int
    receiver_id: int
    caller_name: Optional[str] = None
    receiver_name: Optional[str] = None
    call_type: str = "voice"
    start_time: str
    end_time: Optional[str] = None
    status: str
