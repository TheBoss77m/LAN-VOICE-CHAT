"""
certs.py
--------
يولّد شهادة HTTPS ذاتية التوقيع (Self-Signed) عند كل تشغيل للسيرفر.

لماذا HTTPS أصلًا؟
    المتصفحات (خصوصًا على الجوال) تمنع الوصول للميكروفون (getUserMedia)
    من أي صفحة ليست HTTPS أو localhost بالضبط. بما أن التطبيق يُفتح من
    أجهزة أخرى عبر IP الشبكة المحلية (وليس localhost)، فالمكالمات الصوتية
    لن تعمل من الجوال أو أي جهاز آخر بدون HTTPS.

لماذا نُنشئ الشهادة من جديد في كل تشغيل بدل حفظها؟
    عنوان IP الخاص بجهاز السيرفر قد يتغيّر بين شبكة وأخرى (مثلًا لو نقلت
    الراوتر أو غيّرت الشبكة). الشهادة يجب أن تتضمن هذا الـ IP ضمن
    Subject Alternative Name (SAN) وإلا سيرفضها المتصفح تمامًا. لتفادي
    شهادة قديمة بعنوان IP خاطئ، نولّدها من جديد كل مرة — العملية سريعة
    جدًا (أقل من ثانية) ولا تؤثر على وقت الإقلاع.

لماذا openssl عبر subprocess بدل مكتبة Python (مثل cryptography)؟
    على أجهزة مثل الجوال عبر Termux (أندرويد)، تثبيت مكتبات Python التي
    تحتاج بناء/تصريف (compile) قد يفشل بدون أدوات بناء كاملة أو اتصال
    إنترنت لتنزيل عجلات (wheels) جاهزة لمعمارية ARM. أداة openssl نفسها
    غالبًا مثبّتة مسبقًا على Linux وmacOS، وسهلة التثبيت على Termux
    (pkg install openssl-tool) بدون أي تصريف.
"""

import os
import shutil
import subprocess
import tempfile
from typing import Tuple

from discovery import get_local_ip


class OpenSSLNotFoundError(RuntimeError):
    pass


def _build_san_config(local_ip: str) -> str:
    """يبني ملف إعدادات openssl مؤقت يتضمن SAN — إلزامي، وإلا يرفض
    المتصفح الشهادة حتى لو صحيحة شكليًا (خطأ ERR_CERT_COMMON_NAME_INVALID)."""
    return f"""
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = LAN Voice Chat

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = {local_ip}
"""


def ensure_certificate(cert_dir: str) -> Tuple[str, str]:
    """يولّد شهادة ومفتاح جديدين في cert_dir، ويرجع مساراتهما."""
    if shutil.which("openssl") is None:
        raise OpenSSLNotFoundError(
            "أداة openssl غير موجودة على هذا الجهاز.\n"
            "  - Linux/Termux: pkg install openssl-tool  أو  apt install openssl\n"
            "  - macOS: عادة مثبّتة مسبقًا (تأكد عبر: which openssl)\n"
            "  - Windows: ثبّت Git for Windows (يتضمن openssl) أو استخدم WSL"
        )

    os.makedirs(cert_dir, exist_ok=True)
    cert_path = os.path.join(cert_dir, "cert.pem")
    key_path = os.path.join(cert_dir, "key.pem")

    local_ip = get_local_ip()
    config_content = _build_san_config(local_ip)

    with tempfile.NamedTemporaryFile("w", suffix=".cnf", delete=False) as cfg:
        cfg.write(config_content)
        cfg_path = cfg.name

    try:
        subprocess.run(
            [
                "openssl", "req", "-x509", "-nodes",
                "-newkey", "rsa:2048",
                "-keyout", key_path,
                "-out", cert_path,
                "-days", "825",
                "-config", cfg_path,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"فشل توليد الشهادة عبر openssl:\n{e.stderr}") from e
    finally:
        os.unlink(cfg_path)

    return cert_path, key_path
