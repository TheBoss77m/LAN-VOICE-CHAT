"""
controllers/__init__.py
-----------------------
حزمة المتحكمات وتوجيه المسارات [C - Controllers].
"""

from .auth_controller import router as auth_router
from .users_controller import router as users_router
from .groups_controller import router as groups_router
from .calls_controller import router as calls_router
from .ws_controller import router as ws_router

all_routers = [
    auth_router,
    users_router,
    groups_router,
    calls_router,
    ws_router,
]

__all__ = [
    "auth_router",
    "users_router",
    "groups_router",
    "calls_router",
    "ws_router",
    "all_routers",
]
