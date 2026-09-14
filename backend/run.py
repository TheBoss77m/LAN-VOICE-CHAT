import os
import sys

import uvicorn

from services.certs_service import ensure_certificate, OpenSSLNotFoundError
from services.discovery_service import get_local_ip

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(BASE_DIR, "certs")
PORT = int(os.environ.get("PORT", 8443))


def main() -> None:
    try:
        cert_path, key_path = ensure_certificate(CERT_DIR)
    except OpenSSLNotFoundError as e:
        print("=" * 60)
        print("  تعذّر تشغيل HTTPS:")
        print(f"  {e}")
        print("=" * 60)
        sys.exit(1)

    local_ip = get_local_ip()
    print("=" * 60, flush=True)
    print("  LAN Voice + Video Chat — HTTPS", flush=True)
    print(f"  من نفس الجهاز:      https://127.0.0.1:{PORT}", flush=True)
    print(f"  من أجهزة الشبكة:    https://{local_ip}:{PORT}", flush=True)
    print("  ملاحظة: المتصفح سيُظهر تحذير 'اتصال غير آمن' لأن الشهادة", flush=True)
    print("  ذاتية التوقيع — هذا متوقع، اضغط 'متابعة/Advanced' لتجاوزه", flush=True)
    print("  (مرة واحدة فقط لكل جهاز/متصفح).", flush=True)
    print("=" * 60, flush=True)

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=PORT,
        ssl_certfile=cert_path,
        ssl_keyfile=key_path,
    )


if __name__ == "__main__":
    main()
