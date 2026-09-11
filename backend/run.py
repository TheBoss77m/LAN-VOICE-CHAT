import os
import sys

import uvicorn

from certs import ensure_certificate, OpenSSLNotFoundError
from discovery import get_local_ip

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
    print("=" * 60)
    print("  LAN Voice Chat — HTTPS")
    print(f"  من نفس الجهاز:      https://127.0.0.1:{PORT}")
    print(f"  من أجهزة الشبكة:    https://{local_ip}:{PORT}")
    print("  ملاحظة: المتصفح سيُظهر تحذير 'اتصال غير آمن' لأن الشهادة")
    print("  ذاتية التوقيع — هذا متوقع، اضغط 'متابعة/Advanced' لتجاوزه")
    print("  (مرة واحدة فقط لكل جهاز/متصفح).")
    print("=" * 60)

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=PORT,
        ssl_certfile=cert_path,
        ssl_keyfile=key_path,
    )


if __name__ == "__main__":
    main()
