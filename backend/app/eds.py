"""Вход по ЭЦП РК (NCALayer) — challenge и разбор подписи CMS.

Схема: после логина/пароля сервер выдаёт challenge (короткоживущий JWT).
Браузер подписывает его через NCALayer и присылает CMS-подпись. Здесь мы
разбираем подпись, проверяем что подписан именно наш challenge, и достаём
ИИН из сертификата, чтобы сверить его с ИИН аккаунта.
"""
import base64
import re
import secrets
from datetime import datetime, timedelta

from jose import JWTError, jwt

from .auth import SECRET_KEY, ALGORITHM

CHALLENGE_SUBJECT = "eds_challenge"
CHALLENGE_TTL_MINUTES = 5


class EdsError(Exception):
    """Любая ошибка выдачи/проверки challenge или разбора подписи."""


# ── Challenge ────────────────────────────────────────────────────────────────

def create_challenge(user_id: int) -> str:
    payload = {
        "sub": CHALLENGE_SUBJECT,
        "nonce": secrets.token_urlsafe(32),
        "uid": user_id,
        "exp": datetime.utcnow() + timedelta(minutes=CHALLENGE_TTL_MINUTES),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_challenge(challenge: str) -> dict:
    try:
        payload = jwt.decode(challenge, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise EdsError("Срок действия запроса на подпись истёк, войдите заново")
    if payload.get("sub") != CHALLENGE_SUBJECT or payload.get("uid") is None:
        raise EdsError("Некорректный запрос на подпись")
    return payload


# ── Разбор подписи CMS ───────────────────────────────────────────────────────

# ИИН в сертификате: serialNumber (OID 2.5.4.5), формат "IIN123456789012".
_IIN_RE = re.compile(r"(\d{12})")


def verify_eds_signature(challenge: str, signature_b64: str) -> dict:
    """Проверяет CMS-подпись, что подписан именно challenge, и возвращает
    {'iin': ..., 'full_name': ...} из сертификата подписавшего.

    Все проблемы бросаются как EdsError — эндпоинт превращает их в 401.
    """
    # Разбор CMS требует asn1crypto; импорт внутри — чтобы отсутствие пакета
    # не роняло весь модуль на старте.
    try:
        from asn1crypto import cms
    except ImportError:  # pragma: no cover
        raise EdsError("На сервере не установлен пакет asn1crypto для разбора ЭЦП")

    # 0. challenge должен быть валиден (подпись/срок) до разбора CMS.
    decode_challenge(challenge)

    if not signature_b64:
        raise EdsError("Пустая подпись")
    try:
        der = base64.b64decode(signature_b64)
    except Exception:
        raise EdsError("Подпись не в формате base64")

    try:
        content_info = cms.ContentInfo.load(der)
    except Exception:
        raise EdsError("Не удалось разобрать подпись (CMS)")

    if content_info["content_type"].native != "signed_data":
        raise EdsError("Ожидалась CMS SignedData")
    signed_data = content_info["content"]

    # 1. Сертификат подписавшего.
    certs = signed_data["certificates"]
    if certs is None or len(certs) == 0:
        raise EdsError("В подписи нет сертификата")
    cert = certs[0].chosen  # asn1crypto.x509.Certificate

    # 2. Подписанные данные должны присутствовать (attached=true) и совпадать
    #    с выданным challenge.
    content = signed_data["encap_content_info"]["content"]
    signed_bytes = content.native if content is not None else None
    if not signed_bytes:
        raise EdsError("Подпись без вложенных данных — подпишите с attached=true")
    try:
        signed_text = signed_bytes.decode("utf-8") if isinstance(signed_bytes, (bytes, bytearray)) else str(signed_bytes)
    except Exception:
        raise EdsError("Не удалось прочитать подписанные данные")
    if signed_text.strip() != challenge.strip():
        raise EdsError("Подписаны не те данные")

    subject = cert.subject

    # 3. ИИН: serialNumber (2.5.4.5).
    serial = _subject_value(subject, "2.5.4.5") or _subject_value(subject, "serial_number")
    iin = None
    if serial:
        m = _IIN_RE.search(str(serial))
        if m:
            iin = m.group(1)
    if not iin:
        raise EdsError("В сертификате не найден ИИН")

    # 4. ФИО: commonName (2.5.4.3) — полное «ФАМИЛИЯ ИМЯ ОТЧЕСТВО».
    full_name = _subject_value(subject, "2.5.4.3") or _subject_value(subject, "common_name")
    if not full_name:
        surname = _subject_value(subject, "2.5.4.4") or _subject_value(subject, "surname") or ""
        given = _subject_value(subject, "2.5.4.42") or _subject_value(subject, "given_name") or ""
        full_name = f"{surname} {given}".strip() or None

    return {"iin": iin, "full_name": full_name}


def _subject_value(subject, key):
    """Достаёт значение из x509 Name по OID-строке или человеко-читаемому имени.
    asn1crypto.x509.Name.native — dict {human_name: value}, но экзотические OID
    остаются как строка OID, поэтому пробуем оба варианта."""
    try:
        native = subject.native
    except Exception:
        return None
    if key in native:
        val = native[key]
        return val[0] if isinstance(val, list) else val
    return None
