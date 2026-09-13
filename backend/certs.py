"""
certs.py
--------
يولّد شهادة HTTPS ذاتية التوقيع (Self-Signed) عند كل تشغيل للسيرفر.

يدعم طريقتين تلقائيًا:
  1. مكتبة cryptography (الأسرع والأضمن، تعمل على كل الأنظمة مباشرة دون الحاجة لأي أدوات خارجية).
  2. أداة openssl عبر سطر الأوامر (كخيار بديل في حال عدم توفر مكتبة cryptography).
"""

import datetime
import ipaddress
import os
import shutil
import subprocess
import tempfile
from typing import Tuple, Optional

from discovery import get_local_ip


class OpenSSLNotFoundError(RuntimeError):
    pass


def _find_openssl_executable() -> Optional[str]:
    """يبحث عن أداة openssl في مسار PATH أو في المسارات الشائعة على Windows."""
    found = shutil.which("openssl")
    if found:
        return found

    # مسارات شائعة على Windows
    common_paths = [
        r"C:\Program Files\Git\usr\bin\openssl.exe",
        r"C:\Program Files (x86)\Git\usr\bin\openssl.exe",
        r"C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
        r"C:\Program Files\OpenSSL\bin\openssl.exe",
    ]
    for p in common_paths:
        if os.path.isfile(p):
            return p
    return None


def _generate_with_cryptography(cert_path: str, key_path: str, local_ip: str) -> None:
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization

    # توليد مفتاح RSA 2048-bit
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "LAN Voice + Video Chat"),
    ])

    san_list = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
    ]
    try:
        san_list.append(x509.IPAddress(ipaddress.IPv4Address(local_ip)))
    except ValueError:
        pass

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(
            x509.SubjectAlternativeName(san_list),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    with open(key_path, "wb") as f:
        f.write(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )

    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


def _build_san_config(local_ip: str) -> str:
    return f"""
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = LAN Voice + Video Chat

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = {local_ip}
"""


def _generate_with_openssl(openssl_bin: str, cert_path: str, key_path: str, local_ip: str) -> None:
    config_content = _build_san_config(local_ip)
    with tempfile.NamedTemporaryFile("w", suffix=".cnf", delete=False) as cfg:
        cfg.write(config_content)
        cfg_path = cfg.name

    try:
        subprocess.run(
            [
                openssl_bin, "req", "-x509", "-nodes",
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
        try:
            os.unlink(cfg_path)
        except OSError:
            pass


def ensure_certificate(cert_dir: str) -> Tuple[str, str]:
    """يولّد شهادة ومفتاح جديدين في cert_dir، ويرجع مساراتهما."""
    os.makedirs(cert_dir, exist_ok=True)
    cert_path = os.path.join(cert_dir, "cert.pem")
    key_path = os.path.join(cert_dir, "key.pem")
    local_ip = get_local_ip()

    # الطريقة الأولى: تجربة مكتبة cryptography
    try:
        _generate_with_cryptography(cert_path, key_path, local_ip)
        return cert_path, key_path
    except ImportError:
        pass

    # الطريقة الثانية: البحث عن أداة openssl
    openssl_bin = _find_openssl_executable()
    if openssl_bin:
        _generate_with_openssl(openssl_bin, cert_path, key_path, local_ip)
        return cert_path, key_path

    raise OpenSSLNotFoundError(
        "تعذر توليد شهادة HTTPS:\n"
        "  1. ثبّت مكتبة cryptography: pip install cryptography (الخيار الموصى به)\n"
        "  2. أو ثبّت أداة openssl وأضفها إلى مسار PATH."
    )
