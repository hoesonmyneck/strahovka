from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

# Получаем настройки из переменных окружения или используем дефолтные
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@db:5432/strahovka"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# ── Демонстрационный режим ───────────────────────────────────────────────────
# У аккаунта с ролью «demo» своя «песочница»: копии таблиц статусов, журнала и
# уведомлений лежат в отдельной схеме PostgreSQL (demo.*). Запросы демо-аккаунта
# идут через ОТДЕЛЬНЫЙ пул соединений, у которых search_path = demo, public:
# имя таблицы bin_status для них — это demo.bin_status, а реестр предприятий,
# пользователи и всё остальное читаются из public как обычно.
# Обычные пользователи работают через основной пул (search_path = public) и
# демо-таблиц не видят вовсе. Пулы разные, поэтому «утечка» настройки между
# запросами невозможна: демо-аккаунт физически не может изменить реальные статусы.
DEMO_SCHEMA = "demo"
DEMO_TABLES = ("bin_status", "bin_status_history", "notifications", "overdue_seen")
demo_engine = create_engine(
    DATABASE_URL, pool_pre_ping=True, pool_size=3, max_overflow=5,
    connect_args={"options": f"-csearch_path={DEMO_SCHEMA},public"},
)
DemoSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=demo_engine)

Base = declarative_base()


def _token_role(request: Request):
    """Роль из JWT в заголовке Authorization (без обращения к базе)."""
    header = request.headers.get("authorization") or ""
    if not header.lower().startswith("bearer "):
        return None
    try:
        from jose import jwt
        from . import auth   # импорт здесь: auth сам импортирует этот модуль
        return jwt.decode(header[7:], auth.SECRET_KEY, algorithms=[auth.ALGORITHM]).get("role")
    except Exception:
        return None


def get_db(request: Request):
    """Сессия базы на запрос. Для демо-аккаунта — из демо-пула («песочница»).
    Соответствие роли в токене и роли аккаунта проверяет auth.get_current_user."""
    demo = _token_role(request) == "demo"
    db = (DemoSessionLocal if demo else SessionLocal)()
    db.info["demo"] = demo
    try:
        yield db
    finally:
        db.close()
