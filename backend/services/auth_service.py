"""
auth_service.py
---------------
[Service] تشفير كلمات المرور وإدارة توكنات الجلسات للمستخدمين.
"""

import hashlib
import os
import secrets
from typing import Dict, Optional

_ITERATIONS = 100_000

# token -> user_id
_TOKENS: Dict[str, int] = {}
# user_id -> token
_USER_TOKENS: Dict[int, str] = {}


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return f"{salt.hex()}${derived.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt_hex, hash_hex = stored_hash.split("$")
    except ValueError:
        return False
    salt = bytes.fromhex(salt_hex)
    expected = bytes.fromhex(hash_hex)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return secrets.compare_digest(derived, expected)


def create_token(user_id: int) -> str:
    old_token = _USER_TOKENS.get(user_id)
    if old_token:
        _TOKENS.pop(old_token, None)

    token = secrets.token_hex(24)
    _TOKENS[token] = user_id
    _USER_TOKENS[user_id] = token
    return token


def get_user_id_from_token(token: str) -> Optional[int]:
    return _TOKENS.get(token)


def revoke_token(token: str) -> None:
    user_id = _TOKENS.pop(token, None)
    if user_id is not None:
        _USER_TOKENS.pop(user_id, None)
