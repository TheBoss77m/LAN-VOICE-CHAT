"""
main.py
-------
نقطة تجميع التطبيق (FastAPI Application Assembler) وفق معمارية MVC.
يربط بين:
  - Models: قاعدة البيانات والتهيئة (models/)
  - Controllers: مسارات REST ومتحكم WebSocket (controllers/)
  - Views: خدمة واجهة المستخدم SPA الثابتة (views/)
  - Services: مستجيب الاكتشاف UDP وإدارة الاتصالات (services/)
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

import models.database as db
from services.discovery_service import start_discovery_responder, get_local_ip
from controllers import all_routers

HTTP_PORT = int(os.environ.get("PORT", 8000))
VIEWS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "views")

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
    print("=" * 50, flush=True)
    print("  LAN Voice + Video Chat يعمل الآن", flush=True)
    print(f"  افتح من هذا الجهاز:  http://127.0.0.1:{HTTP_PORT}", flush=True)
    print(f"  افتح من الشبكة:      http://{local_ip}:{HTTP_PORT}", flush=True)
    print("  ⚠️  المكالمات الصوتية والمرئية من أجهزة أخرى تحتاج HTTPS — استخدم", flush=True)
    print("      'python run.py' للحصول على HTTPS تلقائيًا.", flush=True)
    print("=" * 50, flush=True)

    yield

    # --- Shutdown ---
    if _discovery_transport is not None:
        _discovery_transport.close()
    await db.close_db()


app = FastAPI(title="LAN Voice + Video Chat", lifespan=lifespan)

# CORS مفتوح لأن التطبيق يعمل داخل شبكة محلية موثوقة فقط
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=512)

# [Controllers] تسجيل جميع المتحكمات
for router in all_routers:
    app.include_router(router)

# [Views] خدمة الواجهة الأمامية كـ Single Page Application (SPA View)
app.mount("/static", StaticFiles(directory=VIEWS_DIR), name="static")


@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(VIEWS_DIR, "index.html"))
