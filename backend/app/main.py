from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from starlette.background import BackgroundTask
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session, aliased
from sqlalchemy import func, and_, or_, not_, String, case, distinct, text, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from typing import Optional, List
from datetime import date, datetime, timedelta
import pandas as pd
import io
import os
import re
import tempfile
import shutil
import uuid
import threading
import time
import openpyxl
import xlsxwriter

from . import models, schemas, database, auth, eds
from .database import SessionLocal, engine

models.Base.metadata.create_all(bind=engine)

# Автомиграции
with engine.connect() as _conn:
    for _sql in [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS region VARCHAR(200)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS appvr_access INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_access INTEGER DEFAULT 0",
        # ЭЦП-вход: ИИН аккаунта + флаг отключения ЭЦП
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS iin VARCHAR(32)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS eds_disabled INTEGER DEFAULT 0",
        # ФИО из ЭЦП (заполняется автоматически при входе)
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(300)",
        "ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS full_name VARCHAR(300)",
        # ИИН уникален, но NULL допускаем у нескольких (частичный уникальный индекс)
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_users_iin ON users (iin) WHERE iin IS NOT NULL",
        # Ручные статусы по БИН (хранятся отдельно, переживают перезаливку данных)
        """CREATE TABLE IF NOT EXISTS bin_status (
               bin        BIGINT PRIMARY KEY,
               status     VARCHAR(200),
               updated_by VARCHAR(50),
               updated_at TIMESTAMP DEFAULT NOW()
           )""",
        # Доп. столбцы статусов: КГИТ и встречи
        "ALTER TABLE bin_status ADD COLUMN IF NOT EXISTS kgit_status VARCHAR(200)",
        "ALTER TABLE bin_status ADD COLUMN IF NOT EXISTS meeting_status VARCHAR(200)",
        # Журнал изменений статусов (кто/когда/было → стало) — для разбора «статус пропал»
        """CREATE TABLE IF NOT EXISTS bin_status_history (
               id         SERIAL PRIMARY KEY,
               bin        BIGINT,
               field      VARCHAR(30),
               old_value  VARCHAR(200),
               new_value  VARCHAR(200),
               changed_by VARCHAR(50),
               changed_at TIMESTAMP DEFAULT NOW()
           )""",
        "CREATE INDEX IF NOT EXISTS idx_bsh_bin_field_at ON bin_status_history (bin, field, changed_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_bsh_changed_at ON bin_status_history (changed_at)",
        # Схема статусов v2: доп. данные к статусам (только ADD — данные не трогаем)
        "ALTER TABLE bin_status ADD COLUMN IF NOT EXISTS status_date DATE",
        "ALTER TABLE bin_status ADD COLUMN IF NOT EXISTS kgit_date DATE",
        "ALTER TABLE bin_status ADD COLUMN IF NOT EXISTS kgit_time VARCHAR(10)",
        "ALTER TABLE bin_status ADD COLUMN IF NOT EXISTS kgit_place VARCHAR(300)",
        "ALTER TABLE bin_status ADD COLUMN IF NOT EXISTS kgit_reason VARCHAR(500)",
        "ALTER TABLE bin_status ADD COLUMN IF NOT EXISTS meeting_date DATE",
        "ALTER TABLE bin_status ADD COLUMN IF NOT EXISTS meeting_reason VARCHAR(500)",
        # Перенос старых значений «Статус встречи» в новую схему. Идемпотентно
        # (срабатывает только по СТАРЫМ названиям) и атомарно: UPDATE и запись
        # в журнал — один оператор (CTE), без риска дублей при сбое.
        # 1) старое «Встреча проведена - …» означает, что встреча прошла →
        #    «Статус КГИТ» таких строк = «Встреча проведена»
        """WITH old AS (
               SELECT bin, kgit_status FROM bin_status
               WHERE meeting_status IN ('Встреча проведена - планирует заключить с ГАК',
                                        'Встреча проведена - не будет заключать договор с ГАК')
                 AND kgit_status IS DISTINCT FROM 'Встреча проведена'
           ), upd AS (
               UPDATE bin_status b SET kgit_status = 'Встреча проведена'
               FROM old WHERE b.bin = old.bin RETURNING b.bin
           )
           INSERT INTO bin_status_history (bin, field, old_value, new_value, changed_by, changed_at)
           SELECT old.bin, 'kgit_status', old.kgit_status, 'Встреча проведена', 'system-migration', NOW()
           FROM old JOIN upd ON upd.bin = old.bin""",
        # 2) переименование самих значений итога
        """WITH old AS (
               SELECT bin, meeting_status FROM bin_status
               WHERE meeting_status IN ('Встреча проведена - планирует заключить с ГАК',
                                        'Встреча проведена - не будет заключать договор с ГАК')
           ), upd AS (
               UPDATE bin_status b SET meeting_status = CASE old.meeting_status
                   WHEN 'Встреча проведена - планирует заключить с ГАК' THEN 'Планирует заключить с ГАК'
                   ELSE 'Не будет заключать' END
               FROM old WHERE b.bin = old.bin RETURNING b.bin, b.meeting_status
           )
           INSERT INTO bin_status_history (bin, field, old_value, new_value, changed_by, changed_at)
           SELECT old.bin, 'meeting_status', old.meeting_status, upd.meeting_status, 'system-migration', NOW()
           FROM old JOIN upd ON upd.bin = old.bin""",
        # «Статус» (ГАК): старые длинные названия → короткие со схемы статусов.
        # Идемпотентно (только по старым названиям), атомарно (CTE), в журнал.
        # («Контактный номер некорректный/отключен/отсутствует» — ОТДЕЛЬНЫЙ
        #  статус, не «Нет номера»: в переименование не входит.)
        """WITH map(old_v, new_v) AS (VALUES
               ('Заключил/планирует заключить договор ОСНС в другом КСЖ', 'В другом КСЖ'),
               ('Отказ от заключения договора ОСНС', 'Отказ'),
               ('Отсутствие наемных работников', 'Нет работников'),
               ('Ликвидация/закрытие предприятия', 'Ликвидация'),
               ('Филиал/ГУ/КГУ/РГУ', 'Филиал/ГУ'),
               ('Заключил ОСНС с ГАК', 'Заключил с ГАК')
           ), old AS (
               SELECT b.bin, b.status AS old_v, map.new_v
               FROM bin_status b JOIN map ON b.status = map.old_v
           ), upd AS (
               UPDATE bin_status b SET status = old.new_v
               FROM old WHERE b.bin = old.bin RETURNING b.bin
           )
           INSERT INTO bin_status_history (bin, field, old_value, new_value, changed_by, changed_at)
           SELECT old.bin, 'status', old.old_v, old.new_v, 'system-migration', NOW()
           FROM old JOIN upd ON upd.bin = old.bin""",
        # Откат ошибочного переименования «Контактный номер…» → «Нет номера».
        # Возвращаем ТОЛЬКО строки, где последнее изменение «Статус» — это та
        # самая миграция (пользователь после неё ничего не менял). Если человек
        # сам поставил «Нет номера» — не трогаем. Идемпотентно: после отката
        # последняя запись журнала — уже откат, условие больше не выполняется.
        """WITH last AS (
               SELECT DISTINCT ON (bin) bin, changed_by, old_value, new_value
               FROM bin_status_history WHERE field = 'status'
               ORDER BY bin, changed_at DESC, id DESC
           ), old AS (
               SELECT b.bin FROM bin_status b JOIN last l ON l.bin = b.bin
               WHERE b.status = 'Нет номера'
                 AND l.changed_by = 'system-migration'
                 AND l.old_value = 'Контактный номер некорректный/отключен/отсутствует'
                 AND l.new_value = 'Нет номера'
           ), upd AS (
               UPDATE bin_status b SET status = 'Контактный номер некорректный/отключен/отсутствует'
               FROM old WHERE b.bin = old.bin RETURNING b.bin
           )
           INSERT INTO bin_status_history (bin, field, old_value, new_value, changed_by, changed_at)
           SELECT upd.bin, 'status', 'Нет номера',
                  'Контактный номер некорректный/отключен/отсутствует', 'system-migration', NOW()
           FROM upd""",
        # Объединение: «Нет номера» больше не отдельный статус — всё уходит в
        # «Контактный номер некорректный/отключен/отсутствует». Идемпотентно
        # (после перевода «Нет номера» не остаётся), атомарно, в журнал.
        # Дата статуса сохраняется.
        """WITH old AS (
               SELECT bin FROM bin_status WHERE status = 'Нет номера'
           ), upd AS (
               UPDATE bin_status b SET status = 'Контактный номер некорректный/отключен/отсутствует'
               FROM old WHERE b.bin = old.bin RETURNING b.bin
           )
           INSERT INTO bin_status_history (bin, field, old_value, new_value, changed_by, changed_at)
           SELECT upd.bin, 'status', 'Нет номера',
                  'Контактный номер некорректный/отключен/отсутствует', 'system-migration', NOW()
           FROM upd""",
        # «Статус встречи»: «Договор заключён» → «Договор заключен с ГАК»,
        # «Не будет заключать» → «Отказ в заключении с ГАК». Идемпотентно,
        # атомарно (CTE), в журнал. Дата/причина итога сохраняются как были.
        """WITH map(old_v, new_v) AS (VALUES
               ('Договор заключён', 'Договор заключен с ГАК'),
               ('Договор заключен', 'Договор заключен с ГАК'),
               ('Не будет заключать', 'Отказ в заключении с ГАК')
           ), old AS (
               SELECT b.bin, b.meeting_status AS old_v, map.new_v
               FROM bin_status b JOIN map ON b.meeting_status = map.old_v
           ), upd AS (
               UPDATE bin_status b SET meeting_status = old.new_v
               FROM old WHERE b.bin = old.bin RETURNING b.bin
           )
           INSERT INTO bin_status_history (bin, field, old_value, new_value, changed_by, changed_at)
           SELECT old.bin, 'meeting_status', old.old_v, old.new_v, 'system-migration', NOW()
           FROM old JOIN upd ON upd.bin = old.bin""",
        # «Статус КГИТ»: убраны «Встреча проведена» (→ «Встреча назначена») и
        # «Встреча не состоялась» (→ «Встреча перенесена»). Идемпотентно,
        # атомарно (CTE), в журнал; дата/время/причина сохраняются.
        """WITH map(old_v, new_v) AS (VALUES
               ('Встреча проведена', 'Встреча назначена'),
               ('Встреча не состоялась', 'Встреча перенесена')
           ), old AS (
               SELECT b.bin, b.kgit_status AS old_v, map.new_v
               FROM bin_status b JOIN map ON b.kgit_status = map.old_v
           ), upd AS (
               UPDATE bin_status b SET kgit_status = old.new_v
               FROM old WHERE b.bin = old.bin RETURNING b.bin
           )
           INSERT INTO bin_status_history (bin, field, old_value, new_value, changed_by, changed_at)
           SELECT old.bin, 'kgit_status', old.old_v, old.new_v, 'system-migration', NOW()
           FROM old JOIN upd ON upd.bin = old.bin""",
        # Уведомления (колокольчик)
        """CREATE TABLE IF NOT EXISTS notifications (
               id         SERIAL PRIMARY KEY,
               user_id    INTEGER,
               bin        BIGINT,
               kind       VARCHAR(40),
               message    VARCHAR(500),
               created_by VARCHAR(50),
               created_at TIMESTAMP DEFAULT NOW(),
               read_at    TIMESTAMP
           )""",
        "CREATE INDEX IF NOT EXISTS idx_notif_user_read ON notifications (user_id, read_at, created_at DESC)",
        "ALTER TABLE insurance_records ADD COLUMN IF NOT EXISTS is_passport INTEGER",
        "CREATE INDEX IF NOT EXISTS idx_insurance_is_passport ON insurance_records (is_passport)",
        # Размер предприятия (ORG_SIZE): Малое/Среднее/Крупное
        "ALTER TABLE insurance_records ADD COLUMN IF NOT EXISTS org_size VARCHAR(20)",
        "ALTER TABLE company_summary ADD COLUMN IF NOT EXISTS org_size VARCHAR(20)",
        "CREATE INDEX IF NOT EXISTS idx_cs_org_size ON company_summary (org_size)",
        """CREATE TABLE IF NOT EXISTS app_settings (
               key   VARCHAR(100) PRIMARY KEY,
               value VARCHAR(500)
           )""",
        "INSERT INTO app_settings (key, value) VALUES ('last_update', NULL) ON CONFLICT DO NOTHING",
        "INSERT INTO app_settings (key, value) VALUES ('data_version', '1') ON CONFLICT DO NOTHING",
        """CREATE TABLE IF NOT EXISTS login_logs (
               id         SERIAL PRIMARY KEY,
               username   VARCHAR(50),
               role       VARCHAR(20),
               region     VARCHAR(200),
               ip_address VARCHAR(64),
               user_agent VARCHAR(500),
               logged_at  TIMESTAMP DEFAULT NOW()
           )""",
        "CREATE INDEX IF NOT EXISTS idx_login_logs_logged_at ON login_logs (logged_at)",
        """CREATE TABLE IF NOT EXISTS stored_files (
               id            SERIAL PRIMARY KEY,
               original_name VARCHAR(300),
               stored_name   VARCHAR(300),
               size_bytes    BIGINT,
               content_type  VARCHAR(200),
               uploaded_by   VARCHAR(50),
               uploaded_at   TIMESTAMP DEFAULT NOW()
           )""",
        # -- ОПВР: индексы под реальные запросы -------------------------------
        # Фильтры идут подстрокой (ILIKE '%...%'), btree такое не обслуживает —
        # без триграммных индексов каждый запрос сканировал все 270к строк.
        # Новая колонка «Наименование организации» (появилась в OPPV_SVOD_4)
        "ALTER TABLE oppv_records ADD COLUMN IF NOT EXISTS bin_name VARCHAR(500)",
        "CREATE EXTENSION IF NOT EXISTS pg_trgm",
        "CREATE INDEX IF NOT EXISTS idx_oppv_bin_name_trgm "
        "    ON oppv_records USING gin (bin_name gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_oppv_oked_name_trgm "
        "    ON oppv_records USING gin (oked_name gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_oppv_oked_name_low_trgm "
        "    ON oppv_records USING gin (oked_name_low gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_oppv_region_trgm "
        "    ON oppv_records USING gin (region gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_oppv_bin_trgm "
        "    ON oppv_records USING gin (bin gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_oppv_oked_code_low_trgm "
        "    ON oppv_records USING gin (oked_code_low gin_trgm_ops)",
        # Сортировка по деньгам без полной сортировки таблицы
        "CREATE INDEX IF NOT EXISTS idx_oppv_fot ON oppv_records (fot)",
        "CREATE INDEX IF NOT EXISTS idx_oppv_smz ON oppv_records (smz)",
        # Дубли: эти колонки уже проиндексированы через index=True (ix_oppv_records_*)
        "DROP INDEX IF EXISTS idx_oppv_bin",
        "DROP INDEX IF EXISTS idx_oppv_region",
        # Справочник значений для автоподсказок и списка регионов
        """CREATE TABLE IF NOT EXISTS oppv_dict (
               field VARCHAR(40)  NOT NULL,
               value VARCHAR(300) NOT NULL,
               cnt   INTEGER,
               PRIMARY KEY (field, value)
           )""",
    ]:
        try:
            _conn.execute(__import__('sqlalchemy').text(_sql))
            _conn.commit()
        except Exception:
            _conn.rollback()

app = FastAPI(title="Strahovka Insurance API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup_event():
    db = SessionLocal()
    try:
        auth.init_default_users(db)
        _ensure_oppv_dict(db)      # справочник ОПВР для автоподсказок
    finally:
        db.close()


def obligated_row_expr(M):
    """Строка «обязанного» работодателя:
        esutd_akt_td >= 2
        AND (opf IS NULL OR opf != 13)   -- 13 = государственное учреждение
        AND is_passport = 1
    Компания (БИН) обязана страховать, если хотя бы одна её строка это выполняет.
    """
    return and_(
        M.esutd_akt_td >= 2,
        or_(M.opf == None, M.opf != 13),
        M.is_passport == 1,
    )


def active_contract_expr(M):
    """Действующий договор страхования:
        contract_number IS NOT NULL
        AND (rescinding_date IS NULL OR rescinding_date > сегодня)  -- не расторгнут
        AND date_end > сегодня                                      -- в будущем
    """
    return and_(
        M.contract_number != None,
        or_(M.rescinding_date == None, M.rescinding_date > date.today()),
        M.date_end != None,
        M.date_end > date.today(),
    )


def old_insured_expr(M):
    """Старое правило «застрахован» (до актуального изменения):
        contract_number IS NOT NULL AND flag_head = 1
        AND rescinding_date IS NULL AND date_end > сегодня.
    Компания застрахована, если хотя бы одна её строка это выполняет.
    Считается ОТДЕЛЬНО от «не застрахована» (это разные правила)."""
    return and_(
        M.contract_number != None,
        M.flag_head == 1,
        M.rescinding_date == None,
        M.date_end != None,
        M.date_end > date.today(),
    )


def company_status(obl: int, act: int, ins_old: int) -> int:
    """Статус компании по агрегированным по БИН флагам. Правила независимы:
        0 — не застрахована: обязана (obl) И нет действующего договора (act=0);
        1 — застрахована: по старому правилу (ins_old=1);
        2 — прочее (ни то, ни другое) → в таблице «—».
    Группы (0) и (1) не пересекаются: наличие flag_head-договора делает act=1."""
    if obl == 1 and act == 0:
        return 0
    if ins_old == 1:
        return 1
    return 2


# Фильтр по ESUTD акт. ТД: оператор (>, >=, <, <=, =) + число.
def _apply_esutd_filter(query, col, params: dict):
    op = params.get("esutd_op")
    val = params.get("esutd_val")
    if not op or val is None:
        return query
    conds = {
        "gt": col > val, "gte": col >= val,
        "lt": col < val, "lte": col <= val, "eq": col == val,
    }
    cond = conds.get(op)
    if cond is not None:
        query = query.filter(cond)
    return query


# Фильтр по проставленному вручную статусу (bin_status). bin_col — колонка БИН
# таблицы (company_summary.bin или insurance_records.bin). Спецзначение
# "__empty__" — предприятия без статуса.
def _apply_status_col_filter(query, bin_col, params: dict, param_key: str, col):
    """Фильтр по одному из столбцов bin_status (status/kgit_status/meeting_status).
    Спецзначение "__empty__" — предприятия без значения в этом столбце."""
    val = params.get(param_key)
    if not val:
        return query
    if val == "__empty__":
        sub = select(models.BinStatus.bin).where(col.isnot(None), col != "")
        return query.filter(bin_col.notin_(sub))
    sub = select(models.BinStatus.bin).where(col == val)
    return query.filter(bin_col.in_(sub))


def _apply_manual_status_filter(query, bin_col, params: dict):
    B = models.BinStatus
    query = _apply_status_col_filter(query, bin_col, params, "manual_status", B.status)
    query = _apply_status_col_filter(query, bin_col, params, "manual_kgit", B.kgit_status)
    query = _apply_status_col_filter(query, bin_col, params, "manual_meeting", B.meeting_status)
    return query


# Принудительное ограничение по списку статусов (для роли ДКГИТ: показываем
# только её строки). Накладывается поверх прочих фильтров.
def _apply_status_in_filter(query, bin_col, params: dict):
    statuses = params.get("_status_in")
    if not statuses:
        return query
    B = models.BinStatus
    sub = select(B.bin).where(B.status.in_(statuses))
    return query.filter(bin_col.in_(sub))


def apply_filters(query, model, params: dict, force_region: str = None):
    """Применяет все фильтры к запросу. force_region — обязательный регион для региональных пользователей."""
    M = model

    # Региональный пользователь — жёстко фиксируем регион, obl_name из params игнорируем
    if force_region:
        query = query.filter(M.obl_name == force_region)
        params = {k: v for k, v in params.items() if k != 'obl_name'}

    bin_ = params.get("bin")
    if bin_:
        bin_ = str(bin_).strip()
        if len(bin_) == 12 and bin_.isdigit():
            # Полный БИН — точное совпадение (иначе «000000050265» → «50265»
            # находил бы все БИН, где встречаются эти цифры)
            query = query.filter(M.bin == int(bin_))
        else:
            # Часть БИН — поиск подстрокой (ведущие нули убираем)
            bin_stripped = bin_.lstrip('0') or bin_
            query = query.filter(M.bin.cast(String).like(f"%{bin_stripped}%"))

    if params.get("bin_name"):
        query = query.filter(M.bin_name.ilike(f"%{params['bin_name']}%"))

    if params.get("system_delimiter_bin"):
        sdb = params['system_delimiter_bin'].lstrip('0') or params['system_delimiter_bin']
        query = query.filter(M.system_delimiter_bin.cast(String).like(f"%{sdb}%"))

    if params.get("system_delimiter_bin_name"):
        query = query.filter(M.system_delimiter_bin_name.ilike(f"%{params['system_delimiter_bin_name']}%"))

    if params.get("contract_number"):
        query = query.filter(M.contract_number.ilike(f"%{params['contract_number']}%"))

    if params.get("contract_date_from"):
        query = query.filter(M.contract_date >= params["contract_date_from"])
    if params.get("contract_date_to"):
        query = query.filter(M.contract_date <= params["contract_date_to"])

    if params.get("date_beg_from"):
        query = query.filter(M.date_beg >= params["date_beg_from"])
    if params.get("date_beg_to"):
        query = query.filter(M.date_beg <= params["date_beg_to"])

    if params.get("date_end_from") or params.get("date_end_to"):
        effective_end = case(
            (and_(M.rescinding_date != None, M.rescinding_date < M.date_end), M.rescinding_date),
            else_=M.date_end
        )
        if params.get("date_end_from"):
            query = query.filter(effective_end >= params["date_end_from"])
        if params.get("date_end_to"):
            query = query.filter(effective_end <= params["date_end_to"])

    if params.get("obl_name"):
        query = query.filter(M.obl_name.ilike(f"%{params['obl_name']}%"))
    if params.get("rai_name"):
        query = query.filter(M.rai_name.ilike(f"%{params['rai_name']}%"))
    if params.get("address"):
        query = query.filter(M.address.ilike(f"%{params['address']}%"))
    if params.get("phone"):
        query = query.filter(M.phone.ilike(f"%{params['phone']}%"))
    if params.get("leader_surname"):
        query = query.filter(M.leader_surname.ilike(f"%{params['leader_surname']}%"))
    if params.get("opf_name"):
        query = query.filter(M.opf_name.ilike(f"%{params['opf_name']}%"))
    if params.get("id_oked"):
        query = query.filter(M.id_oked.ilike(f"%{params['id_oked']}%"))
    if params.get("name_oked"):
        query = query.filter(M.name_oked.ilike(f"%{params['name_oked']}%"))

    # Форма предприятия: ip=0 → ЮЛ, ip=1 → ИП (0 «falsy», поэтому проверяем на None)
    if params.get("ip") is not None:
        query = query.filter(M.ip == params["ip"])

    if params.get("org_size"):
        query = query.filter(M.org_size == params["org_size"])

    query = _apply_esutd_filter(query, M.esutd_akt_td, params)
    query = _apply_manual_status_filter(query, M.bin, params)
    query = _apply_status_in_filter(query, M.bin, params)

    # is_insured сознательно НЕ фильтруется здесь: статус застрахованности —
    # свойство компании (БИН), поэтому он применяется в дедуп-пути
    # (deduped_records_query) на уровне представителя, а не построчно.

    if params.get("expires_in_months"):
        target_date = date.today() + timedelta(days=30 * params["expires_in_months"])
        query = query.filter(
            and_(
                M.date_end >= date.today(),
                M.date_end <= target_date
            )
        )

    return query


def bin_flags_subquery(db, params: dict, force_region: str = None):
    """Подзапрос с агрегированными по БИН флагами:
        obl     — обязан (esutd/opf/is_passport),
        act     — есть действующий договор (новое правило, без flag_head),
        ins_old — застрахован по старому правилу (с flag_head).
    Признаки могут быть в разных строках одного БИН, поэтому берём max() по группе."""
    M = models.InsuranceRecord
    obl_flag = case((obligated_row_expr(M), 1), else_=0)
    act_flag = case((active_contract_expr(M), 1), else_=0)
    ins_old_flag = case((old_insured_expr(M), 1), else_=0)
    return (
        apply_filters(
            db.query(
                M.bin.label("bin"),
                func.max(obl_flag).label("obl"),
                func.max(act_flag).label("act"),
                func.max(ins_old_flag).label("ins_old"),
            ),
            M, params, force_region=force_region,
        )
        .group_by(M.bin)
        .subquery()
    )


def deduped_records_query(db, params: dict, force_region: str = None):
    """Одна строка на БИН (реестр организаций) с учётом фильтров.

    Представитель БИН: строка с действующим договором, если она есть у компании,
    иначе самая свежая по date_end. Флаги obl/act агрегируются по БИН и
    присоединяются к представителю. Возвращает (query из кортежей (Rep, obl, act),
    alias-класс Rep). Фильтр is_insured применяется на уровне компании.
    """
    M = models.InsuranceRecord
    base = apply_filters(db.query(M), M, params, force_region=force_region)
    rep_subq = (
        base.order_by(M.bin, active_contract_expr(M).desc(), M.date_end.desc().nullslast())
            .distinct(M.bin)
            .subquery()
    )
    Rep = aliased(M, rep_subq)

    flags = bin_flags_subquery(db, params, force_region=force_region)
    q = (
        db.query(
            Rep,
            flags.c.obl.label("obl"),
            flags.c.act.label("act"),
            flags.c.ins_old.label("ins_old"),
        )
        .join(flags, flags.c.bin == Rep.bin)
    )

    # Фильтр «Статус»: 0 — не застрах. (новое правило), 1 — застрах. (старое правило)
    is_ins = params.get("is_insured")
    if is_ins == 0:
        q = q.filter(and_(flags.c.obl == 1, flags.c.act == 0))
    elif is_ins == 1:
        q = q.filter(flags.c.ins_old == 1)

    return q, Rep


# ============ ПРЕДРАСЧЁТ (company_summary) ============

# Фильтры уровня строки/договора — их нет в предрасчёте, для них идём живым путём
COMPLEX_FILTER_KEYS = (
    "contract_number", "contract_date_from", "contract_date_to",
    "date_beg_from", "date_beg_to", "date_end_from", "date_end_to",
    "expires_in_months",
)


# Предрасчёт полностью собран и им можно пользоваться. Во время (пере)сборки —
# False, чтобы не читать частично наполненную таблицу (иначе числа «ползут с нуля»).
_summary_ready = False


def can_use_summary(db, params: dict) -> bool:
    """Быстрый путь применим, если нет сложных (строчных) фильтров и предрасчёт
    собран ПОЛНОСТЬЮ (флаг готовности, а не просто наличие строк)."""
    if any(params.get(k) not in (None, "") for k in COMPLEX_FILTER_KEYS):
        return False
    return _summary_ready


def _get_setting(db, key, default=None):
    row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
    return row.value if (row and row.value is not None) else default


def _set_setting(db, key, value):
    row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(models.AppSetting(key=key, value=value))
    db.commit()


def apply_summary_filters(query, params: dict, force_region: str = None):
    """Фильтры уровня компании поверх предрасчётной таблицы company_summary."""
    S = models.CompanySummary
    if force_region:
        query = query.filter(S.obl_name == force_region)
        params = {k: v for k, v in params.items() if k != 'obl_name'}

    bin_ = params.get("bin")
    if bin_:
        bin_ = str(bin_).strip()
        if len(bin_) == 12 and bin_.isdigit():
            query = query.filter(S.bin == int(bin_))   # полный БИН — точно
        else:
            b = bin_.lstrip('0') or bin_
            query = query.filter(S.bin.cast(String).like(f"%{b}%"))
    if params.get("bin_name"):
        query = query.filter(S.bin_name.ilike(f"%{params['bin_name']}%"))
    if params.get("system_delimiter_bin"):
        sdb = params['system_delimiter_bin'].lstrip('0') or params['system_delimiter_bin']
        query = query.filter(S.system_delimiter_bin.cast(String).like(f"%{sdb}%"))
    if params.get("system_delimiter_bin_name"):
        query = query.filter(S.system_delimiter_bin_name.ilike(f"%{params['system_delimiter_bin_name']}%"))
    if params.get("obl_name"):
        query = query.filter(S.obl_name.ilike(f"%{params['obl_name']}%"))
    if params.get("rai_name"):
        query = query.filter(S.rai_name.ilike(f"%{params['rai_name']}%"))
    if params.get("address"):
        query = query.filter(S.address.ilike(f"%{params['address']}%"))
    if params.get("phone"):
        query = query.filter(S.phone.ilike(f"%{params['phone']}%"))
    if params.get("leader_surname"):
        query = query.filter(S.leader_surname.ilike(f"%{params['leader_surname']}%"))
    if params.get("opf_name"):
        query = query.filter(S.opf_name.ilike(f"%{params['opf_name']}%"))
    if params.get("id_oked"):
        query = query.filter(S.id_oked.ilike(f"%{params['id_oked']}%"))
    if params.get("name_oked"):
        query = query.filter(S.name_oked.ilike(f"%{params['name_oked']}%"))
    if params.get("ip") is not None:
        query = query.filter(S.ip == params["ip"])
    if params.get("org_size"):
        query = query.filter(S.org_size == params["org_size"])
    query = _apply_esutd_filter(query, S.esutd_akt_td, params)
    query = _apply_manual_status_filter(query, S.bin, params)
    query = _apply_status_in_filter(query, S.bin, params)
    return query


def summary_records_query(db, params: dict, force_region: str = None):
    """Реестр из предрасчёта: (query из кортежей (S, obl, act, ins_old), класс S).
    Совпадает по форме с deduped_records_query, поэтому get_records/выгрузка
    работают одинаково для обоих путей."""
    S = models.CompanySummary
    q = apply_summary_filters(
        db.query(S, S.obl.label("obl"), S.act.label("act"), S.ins_old.label("ins_old")),
        params, force_region,
    )
    is_ins = params.get("is_insured")
    if is_ins == 0:
        q = q.filter(S.status == 0)
    elif is_ins == 1:
        q = q.filter(S.status == 1)
    return q, S


def registry_query(db, params: dict, force_region: str = None):
    """Диспетчер: быстрый предрасчёт для простых фильтров, иначе живой дедуп."""
    if can_use_summary(db, params):
        return summary_records_query(db, params, force_region)
    return deduped_records_query(db, params, force_region)


_summary_build_lock = threading.Lock()


def rebuild_company_summary(db):
    """Пересобирает company_summary из insurance_records живым дедуп-запросом.
    Тяжёлая агрегация делается здесь ОДИН раз (после загрузки/в 06:00),
    дальше карточки/таблица/выгрузка читают готовое → мгновенно."""
    global _summary_ready
    _summary_ready = False  # пока пересобираем — быстрый путь выключен
    db.query(models.CompanySummary).delete()
    db.commit()
    # Читаем поток на ОТДЕЛЬНОЙ сессии: yield_per держит серверный курсор, а
    # commit по вставкам на той же сессии его бы инвалидировал.
    read_db = SessionLocal()
    rows = []
    total = 0
    BATCH = 5000
    try:
        q, _ = deduped_records_query(read_db, {}, force_region=None)
        for rep, obl, act, ins_old in q.yield_per(2000):
            rows.append({
                'bin': rep.bin, 'bin_name': rep.bin_name,
                'system_delimiter_bin': rep.system_delimiter_bin,
                'system_delimiter_bin_name': rep.system_delimiter_bin_name,
                'contract_number': rep.contract_number, 'contract_date': rep.contract_date,
                'date_beg': rep.date_beg, 'date_end': rep.date_end, 'rescinding_date': rep.rescinding_date,
                'calculated_amount': rep.calculated_amount, 'count_employees': rep.count_employees,
                'total_employees_count': rep.total_employees_count, 'flag_head': rep.flag_head,
                'row_num': rep.row_num, 'id_reg': rep.id_reg,
                'obl_name': rep.obl_name, 'rai_name': rep.rai_name, 'address': rep.address, 'phone': rep.phone,
                'leader_surname': rep.leader_surname, 'leader_name': rep.leader_name,
                'leader_middlename': rep.leader_middlename,
                'opf_name': rep.opf_name, 'id_oked': rep.id_oked, 'name_oked': rep.name_oked,
                'kol_12mes': rep.kol_12mes, 'fot_12mes': rep.fot_12mes, 'esutd_akt_td': rep.esutd_akt_td,
                'ip': rep.ip, 'tip': rep.tip, 'org_size': rep.org_size,
                'obl': obl, 'act': act, 'ins_old': ins_old,
                'status': company_status(obl, act, ins_old),
            })
            if len(rows) >= BATCH:
                db.bulk_insert_mappings(models.CompanySummary, rows)
                db.commit()
                total += len(rows)
                rows = []
        if rows:
            db.bulk_insert_mappings(models.CompanySummary, rows)
            db.commit()
            total += len(rows)
    finally:
        read_db.close()
    # Помечаем, под какую версию данных собран предрасчёт (для авто-проверки свежести)
    _set_setting(db, "summary_version", _get_setting(db, "data_version", "1"))
    _summary_ready = True  # собрано полностью — можно пользоваться быстрым путём
    print(f"Rebuilt company_summary: {total} rows", flush=True)
    return total


def rebuild_company_summary_safe():
    """Пересборка предрасчёта в отдельной сессии (для фонового вызова)."""
    if not _summary_build_lock.acquire(blocking=False):
        return
    try:
        db = SessionLocal()
        try:
            rebuild_company_summary(db)
        finally:
            db.close()
    finally:
        _summary_build_lock.release()


# ============ AUTH ============

# Системные учётки — не журналируем и не показываем в статистике входов
SYSTEM_ACCOUNTS = ("admin", "user")


def _log_login(request: Request, user: models.User, db: Session):
    """Журналирует вход. Ошибка логирования не должна блокировать вход."""
    if user.username in SYSTEM_ACCOUNTS:
        return
    try:
        fwd = request.headers.get("x-forwarded-for")
        ip = fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None)
        db.add(models.LoginLog(
            username=user.username,
            full_name=user.full_name,
            role=user.role,
            region=user.region,
            ip_address=ip,
            user_agent=(request.headers.get("user-agent") or "")[:500] or None,
            logged_at=datetime.now(),
        ))
        db.commit()
    except Exception as e:
        db.rollback()
        print(f"Failed to write login log: {e}")


def _issue_token(user: models.User) -> dict:
    access_token = auth.create_access_token(data={"sub": user.username, "role": user.role})
    return {"access_token": access_token, "token_type": "bearer"}


def _requires_eds(user: models.User) -> bool:
    """ЭЦП обязательна для не-админов, у которых привязан ИИН и не отключена ЭЦП.
    admin, аккаунты без ИИН и аккаунты с eds_disabled=1 входят по паролю."""
    return (
        user.role != "admin"
        and not user.eds_disabled
        and bool(user.iin)
    )


@app.post("/api/auth/login", response_model=schemas.LoginResponse)
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(database.get_db)):
    user = auth.authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Второй фактор — ЭЦП. Токен пока НЕ выдаём и вход не журналируем: это
    # произойдёт после успешной проверки подписи в /api/auth/login-2fa.
    if _requires_eds(user):
        return {"requires_2fa": True, "challenge": eds.create_challenge(user.id)}

    _log_login(request, user, db)
    return {"requires_2fa": False, **_issue_token(user)}


@app.post("/api/auth/login-2fa", response_model=schemas.Token)
def login_2fa(request: Request, data: schemas.Login2faRequest, db: Session = Depends(database.get_db)):
    # 1. challenge → uid
    try:
        payload = eds.decode_challenge(data.challenge)
    except eds.EdsError as e:
        raise HTTPException(status_code=401, detail=str(e))
    user = db.query(models.User).filter(models.User.id == payload["uid"]).first()
    if not user or not user.is_active or not user.iin:
        raise HTTPException(status_code=401, detail="Пользователь недоступен для входа по ЭЦП")

    # 2. Разбор подписи и сверка ИИН
    try:
        info = eds.verify_eds_signature(data.challenge, data.signature)
    except eds.EdsError as e:
        raise HTTPException(status_code=401, detail=str(e))

    if info["iin"] != user.iin:
        raise HTTPException(
            status_code=401,
            detail=f"ИИН в ЭЦП ({info['iin']}) не совпадает с аккаунтом",
        )

    # ФИО берём из сертификата и сохраняем в аккаунт (вручную не вводим)
    if info.get("full_name"):
        user.full_name = info["full_name"]
        db.commit()

    _log_login(request, user, db)
    return _issue_token(user)


@app.get("/api/auth/me", response_model=schemas.UserResponse)
def get_me(current_user: models.User = Depends(auth.get_current_active_user)):
    return current_user


# ============ METRICS ============

@app.get("/api/metrics", response_model=schemas.MetricsResponse)
def get_metrics(
    bin: Optional[str] = None,
    bin_name: Optional[str] = None,
    system_delimiter_bin: Optional[str] = None,
    system_delimiter_bin_name: Optional[str] = None,
    contract_number: Optional[str] = None,
    contract_date_from: Optional[date] = None,
    contract_date_to: Optional[date] = None,
    date_beg_from: Optional[date] = None,
    date_beg_to: Optional[date] = None,
    date_end_from: Optional[date] = None,
    date_end_to: Optional[date] = None,
    obl_name: Optional[str] = None,
    rai_name: Optional[str] = None,
    address: Optional[str] = None,
    phone: Optional[str] = None,
    leader_surname: Optional[str] = None,
    opf_name: Optional[str] = None,
    id_oked: Optional[str] = None,
    name_oked: Optional[str] = None,
    is_insured: Optional[int] = None,
    ip: Optional[int] = None,
    org_size: Optional[str] = None,
    manual_status: Optional[str] = None,
    manual_kgit: Optional[str] = None,
    manual_meeting: Optional[str] = None,
    expires_in_months: Optional[int] = None,
    esutd_op: Optional[str] = None,
    esutd_val: Optional[float] = None,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    params = locals()
    params.pop("current_user"); params.pop("db")

    # Роль ДКГИТ видит только свои строки (по статусу)
    if current_user.role == "dkgit":
        params["_status_in"] = DKGIT_VIEW_STATUSES

    # Карточки по уникальным БИН. Правила независимы (не дополняют друг друга):
    #   Всего        — все БИН;
    #   Застрахованы — старое правило (ins_old / status=1);
    #   Не застрах.  — обязан И нет действующего договора (status=0).

    # Быстрый путь: считаем поверх предрасчёта company_summary (мгновенно).
    if can_use_summary(db, params):
        S = models.CompanySummary
        row = apply_summary_filters(
            db.query(
                func.count().label("total_bins"),
                func.sum(case((S.status == 1, 1), else_=0)).label("insured_bins"),
                func.sum(case((S.status == 0, 1), else_=0)).label("not_insured_bins"),
            ),
            params, force_region=current_user.region,
        ).one()
        return schemas.MetricsResponse(
            total_bins=row.total_bins or 0,
            insured_bins=row.insured_bins or 0,
            not_insured_bins=row.not_insured_bins or 0,
        )

    # Живой путь (сложные фильтры или предрасчёт ещё не готов): агрегируем по БИН.
    flags = bin_flags_subquery(db, params, force_region=current_user.region)
    row = db.query(
        func.count().label("total_bins"),
        func.sum(case((flags.c.ins_old == 1, 1), else_=0)).label("insured_bins"),
        func.sum(
            case((and_(flags.c.obl == 1, flags.c.act == 0), 1), else_=0)
        ).label("not_insured_bins"),
    ).select_from(flags).one()

    return schemas.MetricsResponse(
        total_bins=row.total_bins or 0,
        insured_bins=row.insured_bins or 0,
        not_insured_bins=row.not_insured_bins or 0,
    )


# ============ DASHBOARD (KPI для руководства) ============

@app.get("/api/dashboard/kpis")
def dashboard_kpis(
    current_user: models.User = Depends(auth.require_dashboard),
    db: Session = Depends(database.get_db)
):
    """Сводные показатели по страхованию и ОППВ для HUD-дашборда.
    Для регионального пользователя — только его регион."""
    S = models.CompanySummary
    region = current_user.region

    def scope(q):
        return q.filter(S.obl_name == region) if region else q

    # «Предприятие» в разделе страхование считается только среди ОБЯЗАННЫХ
    # (status 0 — не застрахован, 1 — застрахован); status 2 (прочее) не в счёт.
    # Дашборд должен считать так же → везде ниже ограничиваемся status in (0,1).
    OBL = S.status.in_((0, 1))

    # ── Страхование (по предрасчёту company_summary) ──
    tot = scope(db.query(
        func.coalesce(func.sum(case((S.status == 1, 1), else_=0)), 0).label("insured"),
        func.coalesce(func.sum(case((S.status == 0, 1), else_=0)), 0).label("not_insured"),
        func.coalesce(func.sum(S.calculated_amount), 0).label("sum_amount"),
        func.coalesce(func.sum(S.count_employees), 0).label("ins_emp"),
        func.coalesce(func.sum(S.total_employees_count), 0).label("tot_emp"),
        func.coalesce(func.sum(case((and_(S.ip == 1, OBL), 1), else_=0)), 0).label("ip_cnt"),
        func.coalesce(func.sum(case((and_(S.ip == 0, OBL), 1), else_=0)), 0).label("ul_cnt"),
        func.coalesce(func.sum(case((and_(S.ip == 1, S.status == 1), 1), else_=0)), 0).label("ip_ins"),
        func.coalesce(func.sum(case((and_(S.ip == 0, S.status == 1), 1), else_=0)), 0).label("ul_ins"),
    )).one()

    insured = tot.insured or 0
    not_insured = tot.not_insured or 0
    total = insured + not_insured  # «Всего организаций» — как в разделе страхование
    coverage = round(insured * 100.0 / (insured + not_insured), 1) if (insured + not_insured) else 0.0

    # Полная разбивка по регионам (для таблицы и рейтингов).
    region_rows = scope(db.query(
        S.obl_name,
        func.coalesce(func.sum(case((S.status == 1, 1), else_=0)), 0).label("ins"),
        func.coalesce(func.sum(case((S.status == 0, 1), else_=0)), 0).label("nins"),
        func.coalesce(func.sum(case((and_(S.ip == 1, OBL), 1), else_=0)), 0).label("ip_tot"),
        func.coalesce(func.sum(case((and_(S.ip == 0, OBL), 1), else_=0)), 0).label("ul_tot"),
        func.coalesce(func.sum(case((and_(S.ip == 1, S.status == 0), 1), else_=0)), 0).label("ip_nins"),
        func.coalesce(func.sum(case((and_(S.ip == 0, S.status == 0), 1), else_=0)), 0).label("ul_nins"),
    )).group_by(S.obl_name).all()

    region_table = []
    for r in region_rows:
        if not r.obl_name:   # без региона — в списке не показываем
            continue
        ins_c = r.ins or 0
        nins_c = r.nins or 0
        tot_c = ins_c + nins_c
        region_table.append({
            "region": r.obl_name,
            "total": tot_c, "ip_total": r.ip_tot or 0, "ul_total": r.ul_tot or 0,
            "insured": ins_c,
            "coverage": round(ins_c * 100.0 / tot_c, 1) if tot_c else 0.0,
            "not_insured": nins_c, "ip_not_insured": r.ip_nins or 0, "ul_not_insured": r.ul_nins or 0,
        })
    region_table.sort(key=lambda x: x["total"], reverse=True)

    # Рейтинг регионов по застрахованным (топ-10) — из той же разбивки
    by_region = [
        {"label": x["region"], "insured": x["insured"], "not_insured": x["not_insured"], "total": x["total"]}
        for x in sorted(region_table, key=lambda x: x["insured"], reverse=True)[:10]
    ]

    # Рейтинг страховых компаний (КСЖ) по числу застрахованных предприятий.
    by_insurer = [
        {"label": r.ins_name, "value": int(r.cnt or 0)}
        for r in scope(db.query(
            S.system_delimiter_bin_name.label("ins_name"),
            func.count().label("cnt"),
        ).filter(S.status == 1,
                 S.system_delimiter_bin_name.isnot(None),
                 S.system_delimiter_bin_name != ""))
        .group_by(S.system_delimiter_bin_name)
        .order_by(func.count().desc()).limit(10).all()
    ]

    # Разбивка по размеру предприятия (Крупное → Среднее → Малое; «Не указан» не показываем)
    SIZE_ORDER = {"Крупное": 0, "Среднее": 1, "Малое": 2}
    by_size = [
        {"label": r.org_size, "insured": r.ins or 0,
         "not_insured": r.nins or 0, "total": (r.ins or 0) + (r.nins or 0)}
        for r in scope(db.query(
            S.org_size,
            func.coalesce(func.sum(case((S.status == 1, 1), else_=0)), 0).label("ins"),
            func.coalesce(func.sum(case((S.status == 0, 1), else_=0)), 0).label("nins"),
        ).filter(S.org_size.in_(list(SIZE_ORDER.keys())))).group_by(S.org_size).all()
    ]
    by_size.sort(key=lambda x: SIZE_ORDER.get(x["label"], 99))

    # Ручные статусы (глобально; привязка к региону — через join, для простоты опускаем)
    # Рейтинг по каждому из трёх столбцов: ГАК (status), КГИТ, итог встречи.
    def _status_rank(col):
        return [
            {"label": r[0], "value": r[1]}
            for r in db.query(col, func.count())
            .filter(col.isnot(None), col != "")
            .group_by(col).order_by(func.count().desc()).all()
        ]
    by_status = _status_rank(models.BinStatus.status)
    by_status_kgit = _status_rank(models.BinStatus.kgit_status)
    by_status_meeting = _status_rank(models.BinStatus.meeting_status)

    # Рейтинг заполненности статусов по регионам: из всех предприятий региона
    # (как в таблице страхования) сколько уже имеют проставленный статус.
    # Рейтинг — по проценту, но отдаём и числа (заполнено / всего).
    B = models.BinStatus
    need_rows = scope(db.query(S.obl_name, func.count().label("c"))).group_by(S.obl_name).all()
    need_map = {r.obl_name: int(r.c or 0) for r in need_rows}
    filled_rows = scope(db.query(S.obl_name, func.count().label("c"))
                        .join(B, B.bin == S.bin)
                        .filter(B.status.isnot(None), B.status != "")
                        ).group_by(S.obl_name).all()
    filled_map = {r.obl_name: int(r.c or 0) for r in filled_rows}
    status_fill = []
    for obl, total_need in need_map.items():
        if not obl:   # без региона — не показываем
            continue
        filled = filled_map.get(obl, 0)
        status_fill.append({
            "region": obl, "filled": filled, "total": total_need,
            "pct": round(filled * 100.0 / total_need, 1) if total_need else 0.0,
        })
    status_fill.sort(key=lambda x: (x["pct"], x["filled"]), reverse=True)

    insurance = {
        "total_bins": total,
        "insured_bins": insured,
        "not_insured_bins": not_insured,
        "coverage_pct": coverage,
        "sum_amount": float(tot.sum_amount or 0),
        "ins_emp": int(tot.ins_emp or 0),
        "tot_emp": int(tot.tot_emp or 0),
        "ip_cnt": tot.ip_cnt or 0,
        "ul_cnt": tot.ul_cnt or 0,
        "ip_ins": tot.ip_ins or 0,
        "ul_ins": tot.ul_ins or 0,
        "by_region": by_region,
        "by_insurer": by_insurer,
        "by_status": by_status,
        "by_status_kgit": by_status_kgit,
        "by_status_meeting": by_status_meeting,
        "by_size": by_size,
        "region_table": region_table,
        "status_fill": status_fill,
    }

    # ── ОППВ (по oppv_records) ──
    oppv = None
    try:
        if db.execute(text("SELECT 1 FROM oppv_records LIMIT 1")).first():
            O = models.OppvRecord
            def oscope(q):
                return q.filter(O.region == region) if region else q
            orow = oscope(db.query(
                func.count().label("rows"),
                func.coalesce(func.sum(O.fot), 0).label("sum_fot"),
                func.coalesce(func.avg(O.smz), 0).label("avg_smz"),
                func.coalesce(func.sum(O.count), 0).label("sum_cnt"),
                func.coalesce(func.sum(case((O.gender == "Мужской", O.count), else_=0)), 0).label("male"),
                func.coalesce(func.sum(case((O.gender == "Женский", O.count), else_=0)), 0).label("female"),
            )).one()

            o_by_region = [{"label": r[0] or "—", "value": int(r[1] or 0)}
                           for r in oscope(db.query(O.region, func.coalesce(func.sum(O.count), 0).label("c")))
                           .group_by(O.region).order_by(func.sum(O.count).desc()).limit(10).all()]

            o_by_oked = [{"label": r[0] or "—", "value": int(r[1] or 0)}
                         for r in oscope(db.query(O.oked_name_low, func.coalesce(func.sum(O.count), 0).label("c")))
                         .group_by(O.oked_name_low).order_by(func.sum(O.count).desc()).limit(8).all()]

            oppv = {
                "rows": orow.rows or 0,
                "sum_fot": float(orow.sum_fot or 0),
                "avg_smz": float(orow.avg_smz or 0),
                "sum_cnt": int(orow.sum_cnt or 0),
                "male": int(orow.male or 0),
                "female": int(orow.female or 0),
                "by_region": o_by_region,
                "by_oked": o_by_oked,
            }
    except Exception as e:
        print(f"dashboard oppv kpis failed: {e}", flush=True)
        oppv = None

    return {"insurance": insurance, "oppv": oppv}


def _expiry_end_expr(S):
    """Дата окончания страховки: расторжение обрывает договор раньше даты окончания."""
    return case(
        (and_(S.rescinding_date.isnot(None),
              or_(S.date_end.is_(None), S.rescinding_date < S.date_end)), S.rescinding_date),
        else_=S.date_end,
    )


@app.get("/api/dashboard/expiry-heatmap")
def expiry_heatmap(
    year: int,
    current_user: models.User = Depends(auth.require_dashboard),
    db: Session = Depends(database.get_db),
):
    """Сколько застрахованных предприятий у которых заканчивается страховка в
    каждом месяце выбранного года, в разбивке по регионам (все регионы РК)."""
    S = models.CompanySummary
    region = current_user.region

    def scope(q):
        return q.filter(S.obl_name == region) if region else q

    eff = _expiry_end_expr(S)
    rows = scope(
        db.query(S.obl_name, func.extract('month', eff).label('m'), func.count().label('c'))
        .filter(S.status == 1, func.extract('year', eff) == year)
    ).group_by(S.obl_name, func.extract('month', eff)).all()

    agg = {}
    for obl, m, c in rows:
        agg.setdefault(obl or "—", {})[int(m)] = int(c)

    # Полный список регионов (чтобы показать все, даже с нулями)
    all_regions = [r[0] for r in scope(db.query(S.obl_name).distinct()).all() if r[0]]
    all_regions.sort()

    regions = []
    for obl in all_regions:
        months = agg.get(obl, {})
        regions.append({
            'region': obl,
            'months': [months.get(mo, 0) for mo in range(1, 13)],
            'total': sum(months.values()),
        })
    return {'year': year, 'regions': regions}


@app.get("/api/dashboard/expiry-list", response_model=schemas.InsuranceRecordList)
def expiry_list(
    year: int,
    month: int = Query(..., ge=1, le=12),
    region: str = Query(...),
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=1000),
    current_user: models.User = Depends(auth.require_dashboard),
    db: Session = Depends(database.get_db),
):
    """Список застрахованных предприятий конкретного региона, у которых страховка
    заканчивается в указанном месяце года (клик по ячейке карты окончаний)."""
    S = models.CompanySummary
    # Региональный пользователь видит только свой регион
    if current_user.region:
        region = current_user.region

    eff = _expiry_end_expr(S)
    q = (db.query(S, S.obl.label("obl"), S.act.label("act"), S.ins_old.label("ins_old"))
         .filter(S.status == 1, S.obl_name == region,
                 func.extract('year', eff) == year,
                 func.extract('month', eff) == month))
    total = q.count()
    records = q.order_by(eff.asc(), S.bin.asc()).offset((page - 1) * page_size).limit(page_size).all()

    items = []
    for rep, obl, act, ins_old in records:
        item = schemas.InsuranceRecordResponse.model_validate(rep)
        item.is_insured = company_status(obl, act, ins_old)
        items.append(item)

    bins = [it.bin for it in items if it.bin is not None]
    if bins:
        B = models.BinStatus
        st = {r.bin: r for r in db.query(B).filter(B.bin.in_(bins)).all()}
        meta = _status_meta_for_bins(db, bins)  # кто/когда менял каждый столбец
        for it in items:
            r = st.get(it.bin)
            if r:
                it.manual_status = r.status
                it.kgit_status = r.kgit_status
                it.meeting_status = r.meeting_status
                it.status_date = r.status_date
                it.kgit_date = r.kgit_date
                it.kgit_time = r.kgit_time
                it.kgit_place = r.kgit_place
                it.kgit_reason = r.kgit_reason
                it.meeting_date = r.meeting_date
                it.meeting_reason = r.meeting_reason
            it.status_meta = meta.get(it.bin)

    return schemas.InsuranceRecordList(items=items, total=total, page=page, page_size=page_size)


def _history_base_mapper(field):
    """Функция «значение из журнала → название статуса». В журнале значение с
    деталями («Встреча назначена (12.11.2026 14:00)»); старые названия итога
    сводятся к новым (MEETING_RENAMES / KGIT_RENAMES)."""
    base_list = KGIT_STATUSES if field == "kgit_status" else MEETING_STATUSES
    aliases = KGIT_RENAMES if field == "kgit_status" else MEETING_RENAMES
    known = sorted(list(base_list) + list(aliases), key=len, reverse=True)

    def base_of(v):
        for s in known:
            if v == s or v.startswith(s + " ("):
                return aliases.get(s, s)
        b = v.split(" (")[0]
        return aliases.get(b, b)
    return base_of


@app.get("/api/dashboard/status-activity")
def status_activity(
    year: int,
    month: int = Query(..., ge=1, le=12),
    region: Optional[str] = None,
    field: str = "status",
    current_user: models.User = Depends(auth.require_dashboard),
    db: Session = Depends(database.get_db),
):
    """Активность проставления статусов: по каждому статусу — сколько проставлено
    в каждый день выбранного месяца. Фильтр по региону (через company_summary).
    field: status (ГАК, как раньше — по текущим статусам и дате обновления),
    kgit_status / meeting_status — по журналу изменений (дата смены именно этого
    столбца; updated_at строки общий на три столбца и для них не годится)."""
    import calendar
    B = models.BinStatus
    S = models.CompanySummary
    H = models.BinStatusHistory
    if field not in ("status", "kgit_status", "meeting_status"):
        raise HTTPException(400, "Неизвестный столбец статуса")
    # Региональный пользователь — только свой регион
    if current_user.region:
        region = current_user.region

    days_in_month = calendar.monthrange(year, month)[1]
    agg = {}

    if field == "status":
        day_expr = func.extract('day', B.updated_at)
        q = (db.query(B.status, day_expr.label('d'), func.count().label('c'))
             .filter(B.status.isnot(None), B.status != "",
                     func.extract('year', B.updated_at) == year,
                     func.extract('month', B.updated_at) == month))
        if region:
            q = q.join(S, S.bin == B.bin).filter(S.obl_name == region)
        for status, d, c in q.group_by(B.status, day_expr).all():
            agg.setdefault(status, {})[int(d)] = int(c)
        base_list = INSURANCE_STATUSES
    else:
        base_list = KGIT_STATUSES if field == "kgit_status" else MEETING_STATUSES
        base_of = _history_base_mapper(field)
        q = (db.query(H.new_value, H.changed_at)
             .filter(H.field == field, H.new_value.isnot(None),
                     H.changed_by != "system-migration",
                     func.extract('year', H.changed_at) == year,
                     func.extract('month', H.changed_at) == month))
        if region:
            q = q.join(S, S.bin == H.bin).filter(S.obl_name == region)
        for val, at in q.all():
            s = base_of(val)
            day = at.day
            agg.setdefault(s, {})
            agg[s][day] = agg[s].get(day, 0) + 1

    # Ось Y: все статусы из справочника + любые нестандартные, что встретились
    status_order = list(base_list)
    for s in agg:
        if s not in status_order:
            status_order.append(s)

    statuses = []
    for s in status_order:
        days = agg.get(s, {})
        statuses.append({
            'status': s,
            'days': [days.get(d, 0) for d in range(1, days_in_month + 1)],
            'total': sum(days.values()),
        })

    # Список регионов для фильтра (для регионального пользователя — только его)
    if current_user.region:
        regions = [current_user.region]
    else:
        regions = sorted(r[0] for r in db.query(S.obl_name).distinct().all() if r[0])

    return {'year': year, 'month': month, 'days_in_month': days_in_month,
            'statuses': statuses, 'regions': regions}


# Порядок регионов в выгрузке — как в отчётной форме (остальные — в конце по алфавиту)
REPORT_REGION_ORDER = [
    "Жамбылская область", "Жетісу", "Туркестанская область", "г.Алматы", "Улытау",
    "Кызылординская область", "Алматинская область", "г.Шымкент", "г.Астана",
    "Павлодарская область", "Карагандинская область", "Западно-Казахстанская область",
    "Восточно-Казахстанская область", "Мангистауская область", "Костанайская область",
    "Северо-Казахстанская область", "Актюбинская область", "Акмолинская область",
    "Абай", "Атырауская область",
]
MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль",
             "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]


def _status_region_counts(db, field, year, month, region=None):
    """{(регион, статус): кол-во} за месяц — та же логика, что у таблицы
    «Активность статусов»: ГАК — по текущим статусам и дате обновления,
    КГИТ/встречи — по журналу (дата смены этого столбца)."""
    B, S, H = models.BinStatus, models.CompanySummary, models.BinStatusHistory
    counts = {}
    if field == "status":
        q = (db.query(S.obl_name, B.status, func.count())
             .select_from(B).outerjoin(S, S.bin == B.bin)
             .filter(B.status.isnot(None), B.status != "",
                     func.extract('year', B.updated_at) == year,
                     func.extract('month', B.updated_at) == month))
        if region:
            q = q.filter(S.obl_name == region)
        for reg, st, c in q.group_by(S.obl_name, B.status).all():
            counts[(reg or "Без региона", st)] = counts.get((reg or "Без региона", st), 0) + int(c)
    else:
        base_of = _history_base_mapper(field)
        q = (db.query(S.obl_name, H.new_value)
             .select_from(H).outerjoin(S, S.bin == H.bin)
             .filter(H.field == field, H.new_value.isnot(None),
                     H.changed_by != "system-migration",
                     func.extract('year', H.changed_at) == year,
                     func.extract('month', H.changed_at) == month))
        if region:
            q = q.filter(S.obl_name == region)
        for reg, val in q.all():
            k = (reg or "Без региона", base_of(val))
            counts[k] = counts.get(k, 0) + 1
    return counts


@app.get("/api/dashboard/status-activity/export")
def status_activity_export(
    year: int,
    month: int = Query(..., ge=1, le=12),
    current_user: models.User = Depends(auth.require_dashboard),
    db: Session = Depends(database.get_db),
):
    """Excel «Активность статусов»: 3 листа — Статус ГАК, Статус КГИТ, Статус
    встречи. На каждом — регионы × статусы за месяц + «ИТОГО» по строкам и
    столбцам. Региональный пользователь — только свой регион."""
    region = current_user.region or None
    S = models.CompanySummary
    if region:
        regions = [region]
    else:
        present = {r[0] for r in db.query(S.obl_name).distinct().all() if r[0]}
        regions = ([r for r in REPORT_REGION_ORDER if r in present]
                   + sorted(present - set(REPORT_REGION_ORDER)))

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx')
    tmp.close()
    wb = xlsxwriter.Workbook(tmp.name)
    f_title = wb.add_format({'bold': True, 'font_size': 13})
    f_head = wb.add_format({'bold': True, 'border': 1, 'align': 'center', 'valign': 'vcenter',
                            'text_wrap': True, 'bg_color': '#E8EDF7'})
    f_reg = wb.add_format({'bold': True, 'border': 1})
    f_num = wb.add_format({'border': 1, 'align': 'center'})
    f_tot = wb.add_format({'bold': True, 'border': 1, 'align': 'center', 'bg_color': '#F2F4F8'})
    f_tot_l = wb.add_format({'bold': True, 'border': 1, 'bg_color': '#F2F4F8'})

    sheets = [("status", "Статус ГАК", INSURANCE_STATUSES),
              ("kgit_status", "Статус КГИТ", KGIT_STATUSES),
              ("meeting_status", "Статус встречи", MEETING_STATUSES)]
    period = f"{MONTHS_RU[month - 1]} {year}"
    for field, title, base_list in sheets:
        counts = _status_region_counts(db, field, year, month, region)
        statuses = list(base_list) + sorted({s for (_, s) in counts} - set(base_list))
        rows = list(regions)
        if any(r == "Без региона" for (r, _) in counts) and not region:
            rows.append("Без региона")

        ws = wb.add_worksheet(title)
        ws.write(0, 0, f"Активность статусов — {title}, {period}", f_title)
        ws.write(2, 0, "Регионы/Статусы", f_head)
        for j, st in enumerate(statuses, start=1):
            ws.write(2, j, st, f_head)
        ws.write(2, len(statuses) + 1, "ИТОГО", f_head)
        ws.set_row(2, 48)
        ws.set_column(0, 0, 34)
        ws.set_column(1, len(statuses), 16)
        ws.set_column(len(statuses) + 1, len(statuses) + 1, 12)

        col_tot = [0] * len(statuses)
        for i, reg in enumerate(rows, start=3):
            ws.write(i, 0, reg, f_reg)
            row_tot = 0
            for j, st in enumerate(statuses):
                v = counts.get((reg, st), 0)
                ws.write_number(i, j + 1, v, f_num)
                row_tot += v
                col_tot[j] += v
            ws.write_number(i, len(statuses) + 1, row_tot, f_tot)
        last = 3 + len(rows)
        ws.write(last, 0, "ИТОГО", f_tot_l)
        for j, v in enumerate(col_tot):
            ws.write_number(last, j + 1, v, f_tot)
        ws.write_number(last, len(statuses) + 1, sum(col_tot), f_tot)
        ws.freeze_panes(3, 1)
    wb.close()

    return FileResponse(
        tmp.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=f"activity_statuses_{year}_{month:02d}.xlsx",
        background=BackgroundTask(os.unlink, tmp.name),
    )


def _bin12(v):
    return str(int(v)).zfill(12) if v is not None else None


def _fd_iso(d):
    return d.isoformat() if d else None


# ── Список предприятий по клику в «Активности статусов» ──────────────────────
@app.get("/api/dashboard/status-activity/list")
def status_activity_list(
    year: int,
    month: int = Query(..., ge=1, le=12),
    field: str = "status",
    day: Optional[int] = Query(None, ge=1, le=31),
    status: Optional[str] = None,
    region: Optional[str] = None,
    current_user: models.User = Depends(auth.require_dashboard),
    db: Session = Depends(database.get_db),
):
    """Какие предприятия стоят за ячейкой «Активности статусов»: статус (или все)
    × день (или весь месяц). Та же логика, что у таблицы: ГАК — по текущим
    статусам и дате обновления, КГИТ/встречи — по журналу."""
    if field not in ("status", "kgit_status", "meeting_status"):
        raise HTTPException(400, "Неизвестный столбец статуса")
    if current_user.region:
        region = current_user.region
    B, S, H = models.BinStatus, models.CompanySummary, models.BinStatusHistory
    LIMIT = 1000
    items = []
    if field == "status":
        q = (db.query(B.bin, B.status, B.status_date, B.updated_by, B.updated_at,
                      S.bin_name, S.obl_name)
             .outerjoin(S, S.bin == B.bin)
             .filter(B.status.isnot(None), B.status != "",
                     func.extract('year', B.updated_at) == year,
                     func.extract('month', B.updated_at) == month))
        if day:
            q = q.filter(func.extract('day', B.updated_at) == day)
        if status:
            q = q.filter(B.status == status)
        if region:
            q = q.filter(S.obl_name == region)
        for r in q.order_by(B.updated_at.desc()).limit(LIMIT).all():
            items.append({"bin": _bin12(r.bin), "bin_name": r.bin_name, "region": r.obl_name,
                          "status": r.status,
                          "detail": r.status + (f" ({r.status_date.strftime('%d.%m.%Y')})" if r.status_date else ""),
                          "by": r.updated_by, "at": r.updated_at.isoformat() if r.updated_at else None})
    else:
        base_of = _history_base_mapper(field)
        q = (db.query(H.bin, H.new_value, H.changed_by, H.changed_at, S.bin_name, S.obl_name)
             .outerjoin(S, S.bin == H.bin)
             .filter(H.field == field, H.new_value.isnot(None),
                     H.changed_by != "system-migration",
                     func.extract('year', H.changed_at) == year,
                     func.extract('month', H.changed_at) == month))
        if day:
            q = q.filter(func.extract('day', H.changed_at) == day)
        if region:
            q = q.filter(S.obl_name == region)
        for r in q.order_by(H.changed_at.desc()).all():
            st_ = base_of(r.new_value)
            if status and st_ != status:
                continue
            items.append({"bin": _bin12(r.bin), "bin_name": r.bin_name, "region": r.obl_name,
                          "status": st_, "detail": r.new_value,
                          "by": r.changed_by, "at": r.changed_at.isoformat() if r.changed_at else None})
            if len(items) >= LIMIT:
                break
    return {"items": items, "total": len(items), "limited": len(items) >= LIMIT}


# ── Календарь «итог не обновлён, хотя дата встречи прошла» ───────────────────
def _overdue_meetings_query(db, region=None):
    """Встречи КГИТ (назначена/перенесена/проведена) с прошедшей датой, у которых
    итог не обновлялся после встречи: итога нет или он поставлен раньше даты
    встречи (например, «Повторная встреча» до новой встречи)."""
    B, S = models.BinStatus, models.CompanySummary
    q = (db.query(B, S.bin_name, S.obl_name)
         .outerjoin(S, S.bin == B.bin)
         .filter(B.kgit_status.in_(MEETING_DATE_KGIT),
                 B.kgit_date.isnot(None),
                 B.kgit_date < kz_today(),
                 or_(B.meeting_status.is_(None), B.meeting_status == "",
                     B.meeting_date.is_(None), B.meeting_date < B.kgit_date)))
    if region:
        q = q.filter(S.obl_name == region)
    return q


@app.get("/api/dashboard/overdue-meetings")
def overdue_meetings(
    year: int,
    month: int = Query(..., ge=1, le=12),
    region: Optional[str] = None,
    current_user: models.User = Depends(auth.require_dashboard),
    db: Session = Depends(database.get_db),
):
    """Счётчики для календаря: по дням месяца (дата встречи) — сколько встреч
    прошло без обновлённого итога; + всего за всё время."""
    import calendar
    if current_user.region:
        region = current_user.region
    B, S = models.BinStatus, models.CompanySummary
    base = _overdue_meetings_query(db, region)
    total_all = base.count()
    rows = (base.filter(func.extract('year', B.kgit_date) == year,
                        func.extract('month', B.kgit_date) == month)
            .with_entities(func.extract('day', B.kgit_date), func.count())
            .group_by(func.extract('day', B.kgit_date)).all())
    days = {int(d): int(c) for d, c in rows}
    if current_user.region:
        regions = [current_user.region]
    else:
        regions = sorted(r[0] for r in db.query(S.obl_name).distinct().all() if r[0])
    return {"year": year, "month": month,
            "days_in_month": calendar.monthrange(year, month)[1],
            "first_weekday": calendar.monthrange(year, month)[0],   # 0 = понедельник
            "today": kz_today().isoformat(),
            "days": days, "total_month": sum(days.values()), "total_all": total_all,
            "regions": regions}


@app.get("/api/dashboard/overdue-meetings/list")
def overdue_meetings_list(
    year: Optional[int] = None,
    month: Optional[int] = Query(None, ge=1, le=12),
    day: Optional[int] = Query(None, ge=1, le=31),
    region: Optional[str] = None,
    current_user: models.User = Depends(auth.require_dashboard),
    db: Session = Depends(database.get_db),
):
    """Предприятия с просроченным итогом: за день / месяц / всё время."""
    if current_user.region:
        region = current_user.region
    B = models.BinStatus
    q = _overdue_meetings_query(db, region)
    if year:
        q = q.filter(func.extract('year', B.kgit_date) == year)
    if month:
        q = q.filter(func.extract('month', B.kgit_date) == month)
    if day:
        q = q.filter(func.extract('day', B.kgit_date) == day)
    today = kz_today()
    items = []
    for b, name, reg in q.order_by(B.kgit_date.asc(), B.bin.asc()).limit(1000).all():
        items.append({
            "bin": _bin12(b.bin), "bin_name": name, "region": reg,
            "kgit_status": b.kgit_status, "kgit_date": _fd_iso(b.kgit_date), "kgit_time": b.kgit_time,
            "meeting_status": b.meeting_status, "meeting_date": _fd_iso(b.meeting_date),
            "days_overdue": (today - b.kgit_date).days if b.kgit_date else None,
        })
    return {"items": items, "total": len(items)}


# ============ RECORDS ============

# Три независимых столбца статусов по БИН:
#   status         — «Статус» (обзвон). Ставят обычные пользователи.
#   kgit_status    — «Статус КГИТ». Ставит только роль ДКГИТ.
#   meeting_status — «Статус встречи». Ставят обычные, когда заполнен kgit_status.
# Названия — как на схеме статусов (итоговые статусы ГАК). Старые длинные
# названия переводятся автомиграцией (список миграций в начале файла).
INSURANCE_STATUSES = [
    "В работе",
    "Заключил с ГАК",
    "В другом КСЖ",
    "Отказ",
    "Нет работников",
    "Ликвидация",
    "Филиал/ГУ",
    "Контактный номер некорректный/отключен/отсутствует",
    "Иное",
    "Для работы ДКГИТ",
]
KGIT_STATUSES = [
    "В работе",
    "Встреча назначена",
    "Встреча перенесена",
    "Отказано во встрече",
]
# Убранные статусы КГИТ → во что переведены (для журнала/активности).
# Уже проставленные значения переводит автомиграция.
KGIT_RENAMES = {
    "Встреча проведена": "Встреча назначена",
    "Встреча не состоялась": "Встреча перенесена",
}
MEETING_STATUSES = [
    "Планирует заключить с ГАК",
    "Клиент принимает решение",
    "Договор заключен с ГАК",
    "Договор заключен с другим КСЖ",
    "Отказ в заключении с ГАК",
    "Повторная встреча",
]
# Переименованные значения итога (для журнала/активности: старое → новое).
# Уже проставленные значения переводит автомиграция.
MEETING_RENAMES = {
    "Договор заключён": "Договор заключен с ГАК",
    "Не будет заключать": "Отказ в заключении с ГАК",
}

# Какие строки (по основному статусу) видит роль ДКГИТ в таблице страхования.
DKGIT_VIEW_STATUSES = ["Для работы ДКГИТ"]
# «Итог» (Статус встречи) ГАК может ставить, когда в КГИТ одно из этих значений
MEETING_ALLOWED_KGIT = ["Встреча назначена", "Встреча перенесена"]
# КГИТ-статусы с датой встречи — для календаря «итог не обновлён после встречи»
MEETING_DATE_KGIT = MEETING_ALLOWED_KGIT

# Описание столбцов статусов: справочник, поле модели, кто ставит.
STATUS_FIELDS = {
    "status":         {"options": INSURANCE_STATUSES, "dkgit_only": False},
    "kgit_status":    {"options": KGIT_STATUSES,      "dkgit_only": True},
    "meeting_status": {"options": MEETING_STATUSES,   "dkgit_only": False},
}

# Доп. данные статусов по схеме: какие колонки у столбца и что обязательно
# для конкретного значения. extra-ключи: date, time, reason.
# «Место» убрано (все встречи онлайн): колонку kgit_place больше не пишем и не
# показываем, но уже сохранённые значения в базе не трогаем.
STATUS_EXTRA_COLS = {
    "status":         {"date": "status_date"},
    "kgit_status":    {"date": "kgit_date", "time": "kgit_time", "reason": "kgit_reason"},
    "meeting_status": {"date": "meeting_date", "reason": "meeting_reason"},
}
STATUS_EXTRAS = {
    # «Статус» (ГАК): дату НЕ спрашиваем — сервер ставит сегодняшнюю сам
    # (STATUS_AUTO_DATE); «В работе» — без даты
    "status": {s: {"required": [], "optional": []} for s in INSURANCE_STATUSES},
    "kgit_status": {
        "В работе":              {"required": [], "optional": []},
        "Встреча назначена":     {"required": ["date", "time"], "optional": []},
        "Встреча перенесена":    {"required": ["date"], "optional": ["time"]},
        "Отказано во встрече":   {"required": ["date", "reason"], "optional": []},
    },
    "meeting_status": {
        "Планирует заключить с ГАК":     {"required": ["date"], "optional": []},
        "Клиент принимает решение":      {"required": ["date"], "optional": []},
        "Договор заключен с ГАК":        {"required": ["date"], "optional": []},
        "Договор заключен с другим КСЖ": {"required": ["date"], "optional": []},
        "Отказ в заключении с ГАК":      {"required": ["date", "reason"], "optional": []},
        "Повторная встреча":             {"required": ["date"], "optional": []},
    },
}
EXTRA_LABELS = {"date": "дата", "time": "время", "place": "место", "reason": "причина"}
# «Статус» (ГАК): дата ставится автоматически (сегодня), кроме этих значений
STATUS_NO_DATE = {"В работе"}

# Казахстан — единый UTC+5. «Сегодня» для запрета дат задним числом считаем по
# нему, а не по часам сервера (в контейнере UTC — ночью дата отставала бы).
KZ_UTC_OFFSET = timedelta(hours=5)


def kz_today():
    return (datetime.utcnow() + KZ_UTC_OFFSET).date()

# Уведомления: какое событие кому уходит.
#   to_dkgit — новый БИН / повторная встреча → ДКГИТ;
#   to_gak   — ДКГИТ: встреча назначена/перенесена, отказано во встрече.
NOTIFY_RULES = {
    ("status", "Для работы ДКГИТ"):          ("to_dkgit", "Новый БИН для работы ДКГИТ"),
    ("meeting_status", "Повторная встреча"):  ("to_dkgit", "Повторная встреча — назначьте встречу"),
    ("kgit_status", "Встреча назначена"):     ("to_gak", "ДКГИТ: встреча назначена — после встречи проставьте итог"),
    ("kgit_status", "Встреча перенесена"):    ("to_gak", "ДКГИТ: встреча перенесена"),
    ("kgit_status", "Отказано во встрече"):   ("to_gak", "ДКГИТ: отказано во встрече"),
}


@app.get("/api/insurance/statuses")
def get_insurance_statuses(current_user: models.User = Depends(auth.get_current_active_user)):
    """Справочники всех трёх столбцов статусов + требования к доп. данным."""
    return {"status": INSURANCE_STATUSES, "kgit_status": KGIT_STATUSES,
            "meeting_status": MEETING_STATUSES, "extras": STATUS_EXTRAS}


def _fmt_status_details(field, status_val, ex: dict) -> str:
    """Текст для журнала: «Встреча назначена (12.11.2026 14:00, Офис)»."""
    if not status_val:
        return None
    parts = []
    if ex.get("date"):
        parts.append(ex["date"].strftime("%d.%m.%Y") + (f" {ex['time']}" if ex.get("time") else ""))
    elif ex.get("time"):
        parts.append(ex["time"])
    if ex.get("place"):
        parts.append(ex["place"])
    if ex.get("reason"):
        parts.append(ex["reason"])
    return f"{status_val} ({', '.join(parts)})" if parts else status_val


def _notify(db, *, bin_, target, message, actor, now):
    """Создать уведомления получателям по региону БИН (кроме автора)."""
    S, U = models.CompanySummary, models.User
    info = db.query(S.obl_name, S.bin_name).filter(S.bin == bin_).first()
    region = info.obl_name if info else None
    name = (info.bin_name if info else None) or str(bin_).zfill(12)
    roles = ["dkgit"] if target == "to_dkgit" else ["user", "manager"]
    q = db.query(U.id).filter(U.role.in_(roles), U.is_active == 1, U.username != actor)
    if region:
        q = q.filter(or_(U.region == region, U.region.is_(None)))
    text_ = f"{message}: {name}"[:500]
    for (uid,) in q.all():
        db.add(models.Notification(user_id=uid, bin=bin_, kind=target, message=text_,
                                   created_by=actor, created_at=now))


STATUS_FIELD_TITLES = {"status": "Статус ГАК", "kgit_status": "Статус КГИТ",
                       "meeting_status": "Статус встречи"}


def _notify_admins(db, *, bin_, field, old_val, new_val, actor, now):
    """Всем активным админам — о любой смене статуса (в т.ч. своей)."""
    S, U = models.CompanySummary, models.User
    name = db.query(S.bin_name).filter(S.bin == bin_).scalar() or str(bin_).zfill(12)
    msg = f"{STATUS_FIELD_TITLES.get(field, field)}: {old_val or '—'} → {new_val or '—'}: {name}"[:500]
    for (uid,) in db.query(U.id).filter(U.role == "admin", U.is_active == 1).all():
        db.add(models.Notification(user_id=uid, bin=bin_, kind="to_admin", message=msg,
                                   created_by=actor, created_at=now))


@app.patch("/api/insurance/status")
def set_bin_status(
    data: schemas.BinStatusUpdate,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    """Установить/снять статус по БИН в одном из трёх столбцов (data.field).
    Пустая строка — снять. Роль ДКГИТ ставит только kgit_status; обычные — status
    и meeting_status (последний только после «Встреча проведена»). К статусу
    прикладываются доп. данные (дата/время/место/причина) по схеме STATUS_EXTRAS."""
    field = (data.field or "status")
    if field not in STATUS_FIELDS:
        raise HTTPException(400, "Неизвестный столбец статуса")
    spec = STATUS_FIELDS[field]
    is_dkgit = current_user.role == "dkgit"
    is_admin = current_user.role == "admin"
    # Ролевой доступ к столбцу (админ может редактировать все три)
    if not is_admin:
        if spec["dkgit_only"] and not is_dkgit:
            raise HTTPException(403, "Этот столбец заполняет только ДКГИТ")
        if not spec["dkgit_only"] and is_dkgit:
            raise HTTPException(403, "Роль ДКГИТ заполняет только «Статус КГИТ»")

    status_val = (data.status or "").strip()
    if status_val and status_val not in spec["options"]:
        raise HTTPException(400, "Неизвестный статус для этого столбца")

    # Доп. данные: берём только разрешённые для этого значения, проверяем обязательные
    cols = STATUS_EXTRA_COLS[field]
    ex = {}
    if status_val:
        rule = STATUS_EXTRAS[field].get(status_val, {"required": [], "optional": []})
        allowed = set(rule["required"]) | set(rule["optional"])
        raw = {"date": data.date, "time": (data.time or "").strip() or None,
               "place": (data.place or "").strip() or None,
               "reason": (data.reason or "").strip() or None}
        ex = {k: v for k, v in raw.items() if k in allowed and v}
        missing = [EXTRA_LABELS[k] for k in rule["required"] if not ex.get(k)]
        if missing:
            raise HTTPException(400, f"Для статуса «{status_val}» укажите: {', '.join(missing)}")
        if ex.get("time") and not re.fullmatch(r"\d{1,2}:\d{2}", ex["time"]):
            raise HTTPException(400, "Время в формате ЧЧ:ММ")
        # Задним числом нельзя: только сегодня или будущее
        if ex.get("date") and ex["date"] < kz_today():
            raise HTTPException(400, "Нельзя ставить дату задним числом: только сегодня или позже")
        # «Статус» (ГАК): дату не спрашиваем — ставим сегодняшнюю автоматически
        if field == "status" and status_val not in STATUS_NO_DATE:
            ex["date"] = kz_today()
    # Значения всех доп. колонок столбца: неприменимые к статусу — обнуляем,
    # чтобы не висели «чужие» дата/место от прошлого статуса.
    extra_vals = {col: ex.get(k) for k, col in cols.items()}

    B = models.BinStatus
    now = datetime.now()

    # Текущее состояние строки: старое значение (для журнала) и kgit (для проверки)
    cur = db.query(B).filter(B.bin == data.bin).first()
    old_val = getattr(cur, field) if cur else None
    old_ex = ({k: getattr(cur, col) for k, col in cols.items()} if cur else {})

    # «Итог» доступен, когда встреча назначена/перенесена/проведена (админ — всегда)
    if field == "meeting_status" and status_val and not is_admin:
        if not (cur and cur.kgit_status in MEETING_ALLOWED_KGIT):
            raise HTTPException(400, "«Статус встречи» доступен, когда в «Статус КГИТ»: "
                                     + ", ".join(f"«{s}»" for s in MEETING_ALLOWED_KGIT))

    new_detail = _fmt_status_details(field, status_val, ex)
    old_detail = _fmt_status_details(field, old_val, old_ex) if old_val else None

    if not status_val:  # снять значение в этом столбце (вместе с его доп. данными)
        db.query(B).filter(B.bin == data.bin).update(
            {field: None, **extra_vals, "updated_by": current_user.username, "updated_at": now},
            synchronize_session=False)
        # если все три столбца пусты — удаляем строку
        db.query(B).filter(B.bin == data.bin, B.status.is_(None),
                           B.kgit_status.is_(None), B.meeting_status.is_(None)).delete(
            synchronize_session=False)
    else:
        # Атомарный upsert ПО ПОЛЯМ ЭТОГО СТОЛБЦА: не перетирает другие столбцы
        # и не падает на гонке (дубликат PK при одновременном первом вводе).
        vals = {field: status_val, **extra_vals,
                "updated_by": current_user.username, "updated_at": now}
        stmt = pg_insert(B.__table__).values(bin=data.bin, **vals)
        stmt = stmt.on_conflict_do_update(index_elements=["bin"], set_=vals)
        db.execute(stmt)

    # Журнал — только реальное изменение (значение или его данные)
    if (old_detail or None) != (new_detail or None):
        db.add(models.BinStatusHistory(
            bin=data.bin, field=field, old_value=old_detail, new_value=new_detail,
            changed_by=current_user.username, changed_at=now))

    # Уведомления — только при смене самого значения на «сигнальное»
    if status_val and status_val != old_val:
        rule = NOTIFY_RULES.get((field, status_val))
        if rule:
            _notify(db, bin_=data.bin, target=rule[0], message=rule[1],
                    actor=current_user.username, now=now)
    # Админам — о ЛЮБОЙ смене значения любого столбца, включая свою
    # (для демонстраций: поменял статус — сразу видно уведомление)
    if (status_val or None) != (old_val or None):
        _notify_admins(db, bin_=data.bin, field=field, old_val=old_val,
                       new_val=status_val or None, actor=current_user.username, now=now)

    db.commit()
    row = db.query(B).filter(B.bin == data.bin).first()
    return {"bin": data.bin, "field": field, "status": status_val,
            "row": _bin_status_row_dict(row)}


def _bin_status_row_dict(r):
    """Все поля статусов строки bin_status для фронта (или пусто, если строки нет)."""
    if not r:
        return {"manual_status": None, "kgit_status": None, "meeting_status": None,
                "status_date": None, "kgit_date": None, "kgit_time": None,
                "kgit_place": None, "kgit_reason": None,
                "meeting_date": None, "meeting_reason": None}
    iso = lambda d: d.isoformat() if d else None
    return {"manual_status": r.status, "kgit_status": r.kgit_status,
            "meeting_status": r.meeting_status,
            "status_date": iso(r.status_date), "kgit_date": iso(r.kgit_date),
            "kgit_time": r.kgit_time, "kgit_place": r.kgit_place, "kgit_reason": r.kgit_reason,
            "meeting_date": iso(r.meeting_date), "meeting_reason": r.meeting_reason}


# Последнее изменение по каждому (БИН, столбец) — для подсказки «кто/когда» в ячейке.
def _status_meta_for_bins(db, bins):
    """{bin: {field: {'by': user, 'at': iso}}} по журналу (DISTINCT ON bin, field)."""
    if not bins:
        return {}
    H = models.BinStatusHistory
    rows = (db.query(H.bin, H.field, H.changed_by, H.changed_at)
            .filter(H.bin.in_(bins))
            .distinct(H.bin, H.field)
            .order_by(H.bin, H.field, H.changed_at.desc())
            .all())
    meta = {}
    for b, f, by, at in rows:
        meta.setdefault(b, {})[f] = {"by": by, "at": at.isoformat() if at else None}
    return meta


@app.get("/api/insurance/status/history")
def get_bin_status_history(
    bin: int,
    field: Optional[str] = None,
    limit: int = Query(100, ge=1, le=1000),
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db),
):
    """История изменений статусов по БИН (новые сверху). field — только один
    столбец (кнопка «часы» в ячейке); без field — все три."""
    H = models.BinStatusHistory
    q = db.query(H).filter(H.bin == bin)
    if field:
        if field not in STATUS_FIELDS:
            raise HTTPException(400, "Неизвестный столбец статуса")
        q = q.filter(H.field == field)
    rows = q.order_by(H.changed_at.desc(), H.id.desc()).limit(limit).all()
    return [{
        "field": r.field, "old_value": r.old_value, "new_value": r.new_value,
        "changed_by": r.changed_by, "changed_at": r.changed_at.isoformat() if r.changed_at else None,
    } for r in rows]


# ============ УВЕДОМЛЕНИЯ (колокольчик) ============

def _unread_count(db, user_id) -> int:
    N = models.Notification
    return db.query(func.count(N.id)).filter(N.user_id == user_id, N.read_at.is_(None)).scalar() or 0


@app.get("/api/notifications/unread-count")
def notifications_unread_count(
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db),
):
    """Число непрочитанных — для красного счётчика (лёгкий запрос для опроса)."""
    return {"unread": _unread_count(db, current_user.id)}


@app.get("/api/notifications")
def list_notifications(
    limit: int = Query(30, ge=1, le=200),
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db),
):
    """Последние уведомления пользователя (непрочитанные сверху, затем по дате)."""
    N = models.Notification
    rows = (db.query(N).filter(N.user_id == current_user.id)
            .order_by(N.read_at.isnot(None), N.created_at.desc(), N.id.desc())
            .limit(limit).all())
    return {
        "unread": _unread_count(db, current_user.id),
        "items": [{
            "id": r.id, "bin": r.bin, "kind": r.kind, "message": r.message,
            "created_by": r.created_by,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "read": r.read_at is not None,
        } for r in rows],
    }


@app.post("/api/notifications/{notif_id}/read")
def mark_notification_read(
    notif_id: int,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db),
):
    N = models.Notification
    db.query(N).filter(N.id == notif_id, N.user_id == current_user.id, N.read_at.is_(None)) \
        .update({"read_at": datetime.now()}, synchronize_session=False)
    db.commit()
    return {"unread": _unread_count(db, current_user.id)}


@app.get("/api/company/{bin_}/passport")
def company_passport(
    bin_: int,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db),
):
    """Паспорт предприятия: реестр, текущий договор, все договоры, статусы, ОПВР.
    Права — как в таблице: регион. пользователь — только свой регион, ДКГИТ —
    только свои строки, ОПВР — только при доступе к ОПВР."""
    S, B, M = models.CompanySummary, models.BinStatus, models.InsuranceRecord
    s = db.query(S).filter(S.bin == bin_).first()
    if not s:
        raise HTTPException(404, "Предприятие не найдено")
    if current_user.region and s.obl_name != current_user.region:
        raise HTTPException(403, "Нет доступа к предприятию другого региона")
    st = db.query(B).filter(B.bin == bin_).first()
    if current_user.role == "dkgit" and not (st and st.status in DKGIT_VIEW_STATUSES):
        raise HTTPException(403, "Нет доступа")

    def fd(d):
        return d.strftime("%d.%m.%Y") if d else None

    def fn(v, dec=0):
        if v is None:
            return None
        try:
            x = float(v)
        except Exception:
            return str(v)
        s_ = f"{x:,.{dec}f}".replace(",", " ")
        return s_.replace(".", ",") if dec else s_

    def bin12(v):
        return str(int(v)).zfill(12) if v is not None else None

    def rows(pairs):
        # КАЖДЫЙ столбец таблицы показываем всегда (пустое — «—»), чтобы в
        # паспорте было всё, что в таблице. Подписи — как в заголовках таблицы.
        # Служебные строки «изменил» — только если есть данные.
        out = []
        for k, v in pairs:
            if v in (None, ""):
                if k.startswith("  "):
                    continue
                v = "—"
            out.append([k, v])
        return out

    leader = " ".join(x for x in (s.leader_surname, s.leader_name, s.leader_middlename) if x) or None
    # «Застрахован» — как в столбце таблицы: Да / Нет / —
    insured = {1: "Да", 0: "Нет"}.get(s.status)
    sections = [
        {"title": "Основные сведения", "rows": rows([
            ("БИН", bin12(s.bin)),
            ("Название компании", s.bin_name),
            ("Форма предприятия", {1: "ИП", 0: "ЮЛ"}.get(s.ip)),
            ("Размер предприятия", s.org_size),
            ("ОПФ", s.opf_name),
            ("Код ОКЭД", s.id_oked),
            ("Вид деятельности (ОКЭД)", s.name_oked),
            ("Область", s.obl_name),
            ("Район", s.rai_name),
            ("Адрес", s.address),
            ("Телефон", s.phone),
            ("Руководитель", leader),
        ])},
        {"title": "Страхование", "rows": rows([
            ("Застрахован", insured),
            ("БИН страховой компании", bin12(s.system_delimiter_bin)),
            ("Страховая компания", s.system_delimiter_bin_name),
            ("№ Договора", s.contract_number),
            ("Дата договора", fd(s.contract_date)),
            ("Дата начала", fd(s.date_beg)),
            ("Дата окончания", fd(s.date_end)),
            ("Дата расторжения", fd(s.rescinding_date)),
            ("Сумма", fn(s.calculated_amount, 2)),
        ])},
        {"title": "Сотрудники и ФОТ", "rows": rows([
            ("Застрахованных", fn(s.count_employees)),
            ("Всего сотр.", fn(s.total_employees_count)),
            ("Кол-во 12 мес.", fn(s.kol_12mes)),
            ("ФОТ 12 мес.", fn(s.fot_12mes)),
            ("Активные трудовые договора", fn(s.esutd_akt_td)),
        ])},
    ]

    # Статусы (с датами/временем/причинами) — секция есть всегда
    def stat(v, d=None, t=None, r=None):
        if not v:
            return None
        extra = ", ".join(x for x in ((fd(d) or "") + (f" {t}" if t else ""), r or "") if x.strip())
        return f"{v} ({extra})" if extra else v
    meta = _status_meta_for_bins(db, [bin_]).get(bin_, {}) if st else {}
    def who(f):
        m_ = meta.get(f)
        if not m_:
            return None
        at = m_.get("at")
        return f"{m_.get('by') or '—'} · {datetime.fromisoformat(at).strftime('%d.%m.%Y %H:%M') if at else ''}"
    sections.append({"title": "Статусы", "rows": rows([
        ("Статус", stat(st.status, st.status_date) if st else None),
        ("  изменил", who("status")),
        ("Статус КГИТ", stat(st.kgit_status, st.kgit_date, st.kgit_time, st.kgit_reason) if st else None),
        ("  изменил", who("kgit_status")),
        ("Статус встречи", stat(st.meeting_status, st.meeting_date, None, st.meeting_reason) if st else None),
        ("  изменил", who("meeting_status")),
    ])})
    # Скрытые в таблице столбцы (есть в данных и в выгрузке)
    sections.append({"title": "Служебные", "rows": rows([
        ("ТИП", fn(s.tip)),
        ("Флаг", fn(s.flag_head)),
    ])})

    # Все договоры по БИН из исходной выгрузки (новые сверху)
    contracts = [{
        "insurer": r.system_delimiter_bin_name,
        "number": r.contract_number,
        "date": fd(r.contract_date),
        "beg": fd(r.date_beg),
        "end": fd(r.date_end),
        "rescinded": fd(r.rescinding_date),
        "amount": fn(r.calculated_amount, 2),
        "employees": fn(r.count_employees),
    } for r in db.query(M).filter(M.bin == bin_)
        .order_by(M.date_beg.desc().nullslast(), M.id.desc()).limit(50).all()]

    # ОПВР — только при доступе к разделу
    oppv = None
    if current_user.role == "admin" or current_user.appvr_access:
        O = models.OppvRecord
        b12 = bin12(bin_)
        orow = db.query(
            func.count(O.id), func.coalesce(func.sum(O.count), 0),
            func.coalesce(func.sum(O.fot), 0), func.avg(O.smz),
            func.coalesce(func.sum(case((O.gender == "Мужской", O.count), else_=0)), 0),
            func.coalesce(func.sum(case((O.gender == "Женский", O.count), else_=0)), 0),
        ).filter(O.bin == b12).one()
        if orow[0]:
            oppv = rows([
                ("Записей ОПВР", fn(orow[0])),
                ("Сотрудников (по ОПВР)", fn(orow[1])),
                ("Мужчин / женщин", f"{fn(orow[4])} / {fn(orow[5])}"),
                ("ФОТ", fn(orow[2], 0)),
                ("Средняя СМЗ", fn(orow[3], 0)),
            ])

    return {"bin": bin12(bin_), "name": s.bin_name, "sections": sections,
            "contracts": contracts, "oppv": oppv}


@app.post("/api/notifications/read-all")
def mark_all_notifications_read(
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db),
):
    N = models.Notification
    db.query(N).filter(N.user_id == current_user.id, N.read_at.is_(None)) \
        .update({"read_at": datetime.now()}, synchronize_session=False)
    db.commit()
    return {"unread": 0}


@app.get("/api/insurance/status/export")
def export_bin_status(
    only_set: bool = False,
    current_user: models.User = Depends(auth.require_admin),
    db: Session = Depends(database.get_db)
):
    """Выгрузка статусов (только админ): БИН + три столбца статусов
    (Статус, Статус КГИТ, Статус встречи). По умолчанию — весь реестр
    организаций (по одной строке на БИН), пусто у неотмеченных. only_set=1 —
    только БИНы, где заполнен хотя бы один из статусов.
    Пишем потоково (xlsxwriter constant_memory + yield_per), память не грузим."""
    def bin12(v):
        return str(int(v)).zfill(12) if v is not None else ''

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx')
    tmp.close()
    wb = xlsxwriter.Workbook(tmp.name, {'constant_memory': True})
    ws = wb.add_worksheet('Статусы')
    header_fmt = wb.add_format({'bold': True})
    headers = ['БИН', 'Статус', 'Дата статуса',
               'Статус КГИТ', 'Дата КГИТ', 'Время', 'Причина (КГИТ)',
               'Статус встречи', 'Дата итога', 'Причина (итог)']
    widths = [16, 50, 13, 24, 12, 8, 36, 30, 12, 36]
    for c, (h, w) in enumerate(zip(headers, widths)):
        ws.set_column(c, c, w)
        ws.write_string(0, c, h, header_fmt)
    ws.freeze_panes(1, 0)

    S, B = models.CompanySummary, models.BinStatus
    cols = (B.status, B.status_date, B.kgit_status, B.kgit_date, B.kgit_time,
            B.kgit_reason, B.meeting_status, B.meeting_date, B.meeting_reason)
    if only_set:
        q = db.query(B.bin, *cols).order_by(B.bin)
    else:
        # Весь реестр: одна строка на БИН + левый джойн статусов (пусто у неотмеченных)
        q = (db.query(S.bin, *cols)
             .outerjoin(B, B.bin == S.bin)
             .order_by(S.bin))

    def cell(v):
        if v is None:
            return ''
        if hasattr(v, 'strftime'):
            return v.strftime('%d.%m.%Y')
        return str(v)

    row = 0
    for rec in q.yield_per(5000):
        row += 1
        ws.write_string(row, 0, bin12(rec[0]))
        for c, v in enumerate(rec[1:], start=1):
            ws.write_string(row, c, cell(v))
    wb.close()

    return FileResponse(
        tmp.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="bin_status.xlsx",
        background=BackgroundTask(os.unlink, tmp.name),
    )


@app.get("/api/records", response_model=schemas.InsuranceRecordList)
def get_records(
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=1000),
    sort_by: Optional[str] = "id",
    sort_order: Optional[str] = "asc",
    bin: Optional[str] = None,
    bin_name: Optional[str] = None,
    system_delimiter_bin: Optional[str] = None,
    system_delimiter_bin_name: Optional[str] = None,
    contract_number: Optional[str] = None,
    contract_date_from: Optional[date] = None,
    contract_date_to: Optional[date] = None,
    date_beg_from: Optional[date] = None,
    date_beg_to: Optional[date] = None,
    date_end_from: Optional[date] = None,
    date_end_to: Optional[date] = None,
    obl_name: Optional[str] = None,
    rai_name: Optional[str] = None,
    address: Optional[str] = None,
    phone: Optional[str] = None,
    leader_surname: Optional[str] = None,
    opf_name: Optional[str] = None,
    id_oked: Optional[str] = None,
    name_oked: Optional[str] = None,
    is_insured: Optional[int] = None,
    ip: Optional[int] = None,
    org_size: Optional[str] = None,
    manual_status: Optional[str] = None,
    manual_kgit: Optional[str] = None,
    manual_meeting: Optional[str] = None,
    expires_in_months: Optional[int] = None,
    esutd_op: Optional[str] = None,
    esutd_val: Optional[float] = None,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    params = {k: v for k, v in locals().items() if k not in ("page", "page_size", "sort_by", "sort_order", "current_user", "db")}

    # Роль ДКГИТ видит только свои строки (по статусу)
    if current_user.role == "dkgit":
        params["_status_in"] = DKGIT_VIEW_STATUSES

    # Одна строка на БИН (реестр организаций): предрасчёт или живой дедуп
    query, Model = registry_query(db, params, force_region=current_user.region)

    total = query.count()

    # Приоритет размера предприятия: Крупное → Среднее → Малое → не указано.
    size_rank = case(
        (Model.org_size == "Крупное", 0),
        (Model.org_size == "Среднее", 1),
        (Model.org_size == "Малое", 2),
        else_=3,
    )
    if sort_by == "org_size":
        query = query.order_by(size_rank.desc() if sort_order == "desc" else size_rank.asc(),
                               Model.bin.asc())
    elif sort_by and sort_by != "id" and hasattr(Model, sort_by):
        order_col = getattr(Model, sort_by)
        query = query.order_by(order_col.desc() if sort_order == "desc" else order_col.asc())
    else:
        # По умолчанию: сначала крупные предприятия, затем мельче, потом без размера
        query = query.order_by(size_rank.asc(), Model.bin.asc())

    records = query.offset((page - 1) * page_size).limit(page_size).all()

    items = []
    for rep, obl, act, ins_old in records:
        item = schemas.InsuranceRecordResponse.model_validate(rep)
        item.is_insured = company_status(obl, act, ins_old)
        items.append(item)

    # Подтягиваем ручные статусы по БИН одним запросом для текущей страницы
    bins = [it.bin for it in items if it.bin is not None]
    if bins:
        B = models.BinStatus
        st = {r.bin: r for r in db.query(B).filter(B.bin.in_(bins)).all()}
        meta = _status_meta_for_bins(db, bins)  # кто/когда менял каждый столбец
        for it in items:
            r = st.get(it.bin)
            if r:
                it.manual_status = r.status
                it.kgit_status = r.kgit_status
                it.meeting_status = r.meeting_status
                it.status_date = r.status_date
                it.kgit_date = r.kgit_date
                it.kgit_time = r.kgit_time
                it.kgit_place = r.kgit_place
                it.kgit_reason = r.kgit_reason
                it.meeting_date = r.meeting_date
                it.meeting_reason = r.meeting_reason
            it.status_meta = meta.get(it.bin)

    return schemas.InsuranceRecordList(items=items, total=total, page=page, page_size=page_size)


# ============ EXPORT (xlsx) ============

# Реестр организаций (одна строка на БИН), со всеми колонками включая договорные
EXPORT_HEADERS = [
    'БИН', 'Название компании', 'БИН страховой компании', 'Страховая компания',
    'Номер договора', 'Дата договора', 'Дата начала', 'Дата окончания',
    'Дата расторжения', 'Сумма', 'Застрахованных сотр.', 'Всего сотрудников',
    'Кол-во 12 мес.', 'ФОТ 12 мес.', 'Активные трудовые договора', 'Область', 'Район',
    'Телефон', 'Руководитель', 'ОПФ', 'Код ОКЭД',
    'Вид деятельности (ОКЭД)', 'Форма предприятия', 'Застрахован',
]
EXPORT_COL_WIDTHS = [15, 40, 18, 40, 18, 13, 13, 13, 15, 14, 12, 12, 13, 14, 12,
                     22, 22, 16, 30, 22, 10, 30, 18, 12]

EXPORT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads", "exports")
os.makedirs(EXPORT_DIR, exist_ok=True)

# Суточные готовые файлы по значению is_insured: None — все, 1 — застрахованы, 0 — нет.
CACHED_EXPORTS = {
    None: "insurance_records.xlsx",
    1: "insurance_records_insured.xlsx",
    0: "insurance_records_not_insured.xlsx",
}

_export_build_lock = threading.Lock()


def records_export_query(db, params: dict, force_region: str = None):
    """Запрос выгрузки: реестр организаций (одна строка на БИН) с фильтрами.
    Идёт через диспетчер — для простых фильтров читает предрасчёт (быстро)."""
    q, _ = registry_query(db, params, force_region=force_region)
    return q


def write_records_xlsx(query, path: str):
    """Пишет выгрузку в xlsx потоково (xlsxwriter constant_memory) в файл path."""
    def bin12(v):
        return str(int(v)).zfill(12) if v is not None else ''

    wb = xlsxwriter.Workbook(path, {
        'constant_memory': True,
        'default_date_format': 'dd.mm.yyyy',
    })
    ws = wb.add_worksheet('Insurance Records')
    header_fmt = wb.add_format({'bold': True})

    for col, w in enumerate(EXPORT_COL_WIDTHS):
        ws.set_column(col, col, w)
    for col, name in enumerate(EXPORT_HEADERS):
        ws.write_string(0, col, name, header_fmt)
    ws.freeze_panes(1, 0)

    status_label = {1: 'Да', 0: 'Нет', 2: '—'}
    row_idx = 0
    for r, obl, act, ins_old in query.yield_per(2000):
        row_idx += 1
        status = company_status(obl, act, ins_old)  # 0/1/2 (по флагам БИН)
        ws.write_string(row_idx, 0, bin12(r.bin))
        ws.write_string(row_idx, 1, r.bin_name or '')
        ws.write_string(row_idx, 2, bin12(r.system_delimiter_bin))
        ws.write_row(row_idx, 3, [
            r.system_delimiter_bin_name,
            r.contract_number,
            r.contract_date,
            r.date_beg,
            r.date_end,
            r.rescinding_date,
            r.calculated_amount,
            r.count_employees,
            r.total_employees_count,
            r.kol_12mes,
            r.fot_12mes,
            r.esutd_akt_td,
            r.obl_name,
            r.rai_name,
            r.phone,
            f"{r.leader_surname or ''} {r.leader_name or ''} {r.leader_middlename or ''}".strip(),
            r.opf_name,
            r.id_oked,
            r.name_oked,
            ('ИП' if r.ip == 1 else 'ЮЛ' if r.ip == 0 else ''),
            status_label.get(status, '—'),
        ])

    if row_idx:
        ws.autofilter(0, 0, row_idx, len(EXPORT_HEADERS) - 1)
    wb.close()


def cached_export_path(params: dict, region: str):
    """Путь к готовому суточному файлу, если запрос под него подходит, иначе None.

    Подходит: пользователь без региона и без фильтров, кроме is_insured in {None,0,1}.
    """
    if region:
        return None
    if any(params.get(k) not in (None, "") for k in params if k != "is_insured"):
        return None
    iv = params.get("is_insured")
    if iv not in CACHED_EXPORTS:
        return None
    return os.path.join(EXPORT_DIR, CACHED_EXPORTS[iv])


def rebuild_cached_exports(wait: bool = False, only_missing: bool = False):
    """Пересобирает суточные файлы. Атомарно (temp -> os.replace).

    wait=False — пропустить, если сборка уже идёт (для планировщика).
    wait=True  — дождаться и собрать (после загрузки нового Excel).
    only_missing=True — собрать только отсутствующие файлы (resumable: обрыв
    не заставляет пересобирать уже готовые all/insured заново).
    """
    if not _export_build_lock.acquire(blocking=wait):
        return
    try:
        db = SessionLocal()
        try:
            for iv, fname in CACHED_EXPORTS.items():
                dest = os.path.join(EXPORT_DIR, fname)
                if only_missing and os.path.exists(dest):
                    continue
                q = records_export_query(db, {"is_insured": iv}, force_region=None)
                tmp = dest + ".tmp"
                write_records_xlsx(q, tmp)
                os.replace(tmp, dest)
                print(f"Rebuilt cached export: {fname}", flush=True)
        finally:
            db.close()
    finally:
        _export_build_lock.release()


def _summary_stale() -> bool:
    """Нужна пересборка предрасчёта: он пуст, недособран (частичный остаток от
    прерванной сборки) или число строк не совпадает с числом БИН в данных."""
    db = SessionLocal()
    try:
        sc = db.query(func.count(models.CompanySummary.id)).scalar() or 0
        if sc == 0:
            return True
        bc = db.query(func.count(distinct(models.InsuranceRecord.bin))).scalar() or 0
        if sc != bc:
            return True
        # Данные могли смениться без изменения числа БИН (напр. дозалили is_passport)
        return _get_setting(db, "summary_version") != _get_setting(db, "data_version", "1")
    finally:
        db.close()


def _export_scheduler():
    """Фоновый поток: при старте собрать предрасчёт (если пуст) и недостающие
    файлы; дальше раз в сутки в 06:00 пересобирать предрасчёт и все файлы."""
    # 1) Предрасчёт — основа быстрых карточек/таблицы/выгрузки.
    #    Если он уже собран (не устарел) — просто включаем быстрый путь;
    #    иначе пересобираем (rebuild сам поднимет флаг готовности в конце).
    global _summary_ready
    try:
        if _summary_stale():
            rebuild_company_summary_safe()
        else:
            _summary_ready = True
    except Exception as e:
        print(f"Initial summary build failed: {e}")
    # 2) Готовые Excel — только недостающие (resumable), читают предрасчёт.
    if any(not os.path.exists(os.path.join(EXPORT_DIR, f)) for f in CACHED_EXPORTS.values()):
        try:
            rebuild_cached_exports(only_missing=True)
        except Exception as e:
            print(f"Initial export build failed: {e}")
    try:
        rebuild_oppv_export(only_missing=True)      # готовый файл ОПВР
    except Exception as e:
        print(f"Initial OPPV export build failed: {e}")
    # 3) Ежесуточно 06:00 — пересобрать предрасчёт (даты могли сдвинуться) и файлы.
    while True:
        now = datetime.now()
        nxt = now.replace(hour=6, minute=0, second=0, microsecond=0)
        if nxt <= now:
            nxt += timedelta(days=1)
        time.sleep(max(1, (nxt - now).total_seconds()))
        try:
            rebuild_company_summary_safe()
            rebuild_cached_exports()
            rebuild_oppv_export()
        except Exception as e:
            print(f"Scheduled rebuild failed: {e}")


@app.on_event("startup")
def _start_export_scheduler():
    threading.Thread(target=_export_scheduler, daemon=True, name="export-scheduler").start()


@app.get("/api/records/download")
def download_records(
    bin: Optional[str] = None,
    bin_name: Optional[str] = None,
    system_delimiter_bin: Optional[str] = None,
    system_delimiter_bin_name: Optional[str] = None,
    contract_number: Optional[str] = None,
    contract_date_from: Optional[date] = None,
    contract_date_to: Optional[date] = None,
    date_beg_from: Optional[date] = None,
    date_beg_to: Optional[date] = None,
    date_end_from: Optional[date] = None,
    date_end_to: Optional[date] = None,
    obl_name: Optional[str] = None,
    rai_name: Optional[str] = None,
    address: Optional[str] = None,
    phone: Optional[str] = None,
    leader_surname: Optional[str] = None,
    opf_name: Optional[str] = None,
    id_oked: Optional[str] = None,
    name_oked: Optional[str] = None,
    is_insured: Optional[int] = None,
    ip: Optional[int] = None,
    expires_in_months: Optional[int] = None,
    esutd_op: Optional[str] = None,
    esutd_val: Optional[float] = None,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    params = {k: v for k, v in locals().items() if k not in ("current_user", "db")}

    # Готовые суточные файлы: без фильтров / застрахованы / не застрахованы —
    # только для пользователей без региона и без прочих фильтров.
    cached = cached_export_path(params, current_user.region)
    if cached and os.path.exists(cached):
        return FileResponse(
            cached,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename=os.path.basename(cached),
        )

    # Иначе генерируем на лету во временный файл и удаляем после отдачи.
    query = records_export_query(db, params, force_region=current_user.region)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx')
    tmp.close()
    write_records_xlsx(query, tmp.name)
    return FileResponse(
        tmp.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="insurance_records.xlsx",
        background=BackgroundTask(os.unlink, tmp.name),
    )


# ============ UPLOAD (ADMIN ONLY) ============

# Реестр фоновых задач загрузки: job_id -> прогресс. Парсинг больших файлов
# идёт в фоновом потоке, фронт опрашивает статус и показывает реальный %.
UPLOAD_JOBS: dict = {}
_jobs_lock = threading.Lock()


def _new_upload_job() -> str:
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        # Чистим завершённые задачи старше часа, чтобы словарь не рос
        now = time.time()
        for k in [k for k, v in UPLOAD_JOBS.items()
                  if v.get("finished_at") and now - v["finished_at"] > 3600]:
            UPLOAD_JOBS.pop(k, None)
        UPLOAD_JOBS[job_id] = {
            "status": "running", "processed": 0, "total": 0,
            "message": None, "error": None, "finished_at": None,
        }
    return job_id


def _set_job(job_id: str, **kw):
    with _jobs_lock:
        if job_id in UPLOAD_JOBS:
            UPLOAD_JOBS[job_id].update(kw)


def _sheet_total_rows(ws) -> int:
    """Число строк данных (без заголовка). 0 — если неизвестно (нет %)."""
    try:
        mr = ws.max_row
        return max(0, mr - 1) if mr else 0
    except Exception:
        return 0


def _run_insurance_upload(tmp_path: str, job_id: str):
    """Фоновый разбор Excel страхования с обновлением прогресса задачи."""
    db = SessionLocal()
    try:
        wb = openpyxl.load_workbook(tmp_path, read_only=True, data_only=True)
        ws = wb.active
        _set_job(job_id, total=_sheet_total_rows(ws))

        rows_iter = ws.iter_rows(values_only=True)
        headers = list(next(rows_iter))

        def safe_int(val):
            if val is None:
                return None
            try:
                return int(val)
            except Exception:
                return None

        def safe_float(val):
            if val is None:
                return None
            try:
                f = float(val)
                return None if f != f else f
            except Exception:
                return None

        def safe_str(val):
            return str(val) if val is not None else None

        def safe_date(val):
            if val is None:
                return None
            if isinstance(val, str):
                return None  # malformed string dates (e.g. '16.04.0212') → NULL
            return val

        db.query(models.InsuranceRecord).delete()
        db.commit()

        now = datetime.now()
        records = []
        processed = 0
        BATCH = 5000

        for idx, row_vals in enumerate(rows_iter):
            try:
                row = dict(zip(headers, row_vals))
                date_end_val = safe_date(row.get('DATE_END'))
                rescinding_val = safe_date(row.get('RESCINDING_DATE'))

                # Договор действует до даты окончания, но расторжение обрывает его раньше
                effective_end = date_end_val
                if rescinding_val and (not date_end_val or rescinding_val < date_end_val):
                    effective_end = rescinding_val

                records.append({
                    'row_num': safe_int(row.get('   ', idx + 1)),
                    'bin': safe_int(row.get('BIN')),
                    'system_delimiter_bin': safe_float(row.get('SYSTEM_DELIMITER_BIN')),
                    'system_delimiter_bin_name': safe_str(row.get('SYSTEM_DELIMITER_BIN_NAME')),
                    'contract_number': safe_str(row.get('CONTRACT_NUMBER')),
                    'contract_date': safe_date(row.get('CONTRACT_DATE')),
                    'date_beg': safe_date(row.get('DATE_BEG')),
                    'date_end': date_end_val,
                    'rescinding_date': rescinding_val,
                    'calculated_amount': safe_float(row.get('CALCULATED_AMOUNT')),
                    'count_employees': safe_float(row.get('COUNT_EMPLOYEES')),
                    'total_employees_count': safe_float(row.get('TOTAL_EMPLOYEES_COUNT')),
                    'id_system': safe_float(row.get('ID')),
                    'flag_head': safe_float(row.get('FLAG_HEAD')),
                    'sys_date': safe_date(row.get('SYS_DATE')),
                    'bin_name': safe_str(row.get('BIN_NAME')),
                    'id_reg': safe_int(row.get('ID_REG')),
                    'obl_name': safe_str(row.get('OBL_NAME')),
                    'idrai': safe_int(row.get('IDRAI')),
                    'rai_name': safe_str(row.get('RAI_NAME')),
                    'address': safe_str(row.get('ADDRESS')),
                    'phone': safe_str(row.get('PHONE_LEADER')) or safe_str(row.get('PHONE')),
                    'mail': safe_float(row.get('MAIL')),
                    'leader_surname': safe_str(row.get('LEADER_SURNAME')),
                    'leader_name': safe_str(row.get('LEADER_NAME')),
                    'leader_middlename': safe_str(row.get('LEADER_MIDDLENAME')),
                    'opf': safe_float(row.get('OPF')),
                    'opf_name': safe_str(row.get('OPF_NAME')),
                    'id_oked': safe_str(row.get('ID_OKED')),
                    'name_oked': safe_str(row.get('NAME_OKED')),
                    'kol_12mes': safe_int(row.get('KOL_12MES')),
                    'fot_12mes': safe_int(row.get('FOT_12MES')),
                    'esutd_akt_td': safe_int(row.get('ESUTD_AKT_TD')),
                    'ip': safe_int(row.get('IP')),
                    'tip': safe_int(row.get('TIP')),
                    'org_size': safe_str(row.get('ORG_SIZE')),
                    'is_passport': safe_int(row.get('IS_PASSPORT')),
                    'is_insured': 1 if (effective_end and effective_end > now) else 0,
                    'created_at': now,
                    'updated_at': now,
                })
                processed += 1

                if len(records) >= BATCH:
                    try:
                        db.bulk_insert_mappings(models.InsuranceRecord, records)
                        db.commit()
                    except Exception as batch_err:
                        db.rollback()
                        print(f"Batch insert failed: {batch_err}")
                    records = []
                    _set_job(job_id, processed=processed)

            except Exception as e:
                print(f"Error processing row {idx}: {e}")
                continue

        if records:
            try:
                db.bulk_insert_mappings(models.InsuranceRecord, records)
                db.commit()
            except Exception as batch_err:
                db.rollback()
                print(f"Final batch insert failed: {batch_err}")

        wb.close()

        count = db.query(models.InsuranceRecord).count()
        today = date.today().strftime("%d.%m.%Y")
        setting = db.query(models.AppSetting).filter(models.AppSetting.key == "last_update").first()
        if setting:
            setting.value = today
        else:
            db.add(models.AppSetting(key="last_update", value=today))
        db.commit()

        # Данные сменились — поднимаем версию данных и пересобираем предрасчёт
        # (одна тяжёлая агрегация), затем в фоне готовые Excel-файлы.
        _set_setting(db, "data_version", str(int(time.time())))
        _set_job(job_id, message="Пересчёт статусов по организациям…")
        rebuild_company_summary(db)
        threading.Thread(
            target=lambda: rebuild_cached_exports(wait=True), daemon=True
        ).start()

        _set_job(job_id, status="done", processed=processed,
                 message=f"Успешно загружено записей: {count}", finished_at=time.time())

    except Exception as e:
        db.rollback()
        _set_job(job_id, status="error", error=str(e), finished_at=time.time())
    finally:
        db.close()
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.post("/api/upload")
def upload_file(
    file: UploadFile = File(...),
    current_user: models.User = Depends(auth.require_admin),
):
    """Принимает файл, парсит в фоне. Возвращает job_id для опроса прогресса."""
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(400, "Only Excel files are allowed")

    with tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx') as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    job_id = _new_upload_job()
    threading.Thread(
        target=_run_insurance_upload, args=(tmp_path, job_id), daemon=True
    ).start()
    return {"job_id": job_id}


@app.get("/api/uploads/{job_id}")
def upload_status(
    job_id: str,
    current_user: models.User = Depends(auth.require_admin),
):
    with _jobs_lock:
        job = UPLOAD_JOBS.get(job_id)
        job = dict(job) if job else None
    if not job:
        raise HTTPException(404, "Задача не найдена")
    return job


# ============ ОПВР (Пенсионные взносы работников) ============

# Поля, по которым разрешена серверная сортировка/фильтрация ОПВР
OPPV_SORT_FIELDS = {
    'id', 'region', 'bin', 'bin_name', 'oked_code', 'oked_name', 'age', 'gender',
    'count', 'experience', 'fot', 'smz', 'oked_code_low', 'oked_name_low',
}
OPPV_TEXT_FILTERS = (
    'region', 'bin', 'bin_name', 'oked_code', 'oked_name', 'gender',
    'oked_code_low', 'oked_name_low',
)


def apply_oppv_filters(query, params: dict):
    O = models.OppvRecord
    for f in OPPV_TEXT_FILTERS:
        val = params.get(f)
        if val:
            query = query.filter(getattr(O, f).cast(String).ilike(f"%{val}%"))
    return query


@app.get("/api/oppv", response_model=schemas.OppvRecordList)
def get_oppv(
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=1000),
    sort_by: Optional[str] = "id",
    sort_order: Optional[str] = "asc",
    region: Optional[str] = None,
    bin: Optional[str] = None,
    bin_name: Optional[str] = None,
    oked_code: Optional[str] = None,
    oked_name: Optional[str] = None,
    gender: Optional[str] = None,
    oked_code_low: Optional[str] = None,
    oked_name_low: Optional[str] = None,
    current_user: models.User = Depends(auth.require_appvr),
    db: Session = Depends(database.get_db)
):
    O = models.OppvRecord
    params = {k: v for k, v in locals().items()
              if k not in ("page", "page_size", "sort_by", "sort_order", "current_user", "db")}
    query = apply_oppv_filters(db.query(O), params)
    total = query.count()
    # Сумма «Количество сотрудников» по всей выборке (для строки «Итого»)
    sum_count = int(apply_oppv_filters(
        db.query(func.coalesce(func.sum(O.count), 0)), params).scalar() or 0)

    if sort_by in OPPV_SORT_FIELDS:
        col = getattr(O, sort_by)
        query = query.order_by(col.desc() if sort_order == "desc" else col.asc())

    items = query.offset((page - 1) * page_size).limit(page_size).all()
    return schemas.OppvRecordList(items=items, total=total, page=page, page_size=page_size,
                                  sum_count=sum_count)


OPPV_EXPORT_HEADERS = [
    'Регион', 'БИН', 'Код ОКЭД', 'ОКЭД', 'Возраст', 'Пол',
    'Стаж', 'Количество сотрудников', 'ФОТ', 'СМЗ',
]
OPPV_EXPORT_WIDTHS = [22, 16, 14, 40, 10, 10, 10, 20, 16, 16]

# Готовый файл полной выгрузки — как суточные файлы в страховании. Сборка всех
# 271к строк занимает ~18 с (13 с уходит на запись ячеек), поэтому файл делается
# заранее в фоне, а запрос без фильтров просто отдаёт его.
OPPV_EXPORT_FILE = "oppv_svod.xlsx"
_oppv_export_lock = threading.Lock()


def oppv_export_query(db, params: dict):
    O = models.OppvRecord
    # Верхний уровень ОКЭД скрыт; нижний уровень идёт как «Код ОКЭД» / «ОКЭД».
    cols = (O.region, O.bin, O.oked_code_low, O.oked_name_low,
            O.age, O.gender, O.experience, O.count, O.fot, O.smz)
    return apply_oppv_filters(db.query(*cols), params).order_by(O.id)


def write_oppv_xlsx(query, path: str):
    """Пишет выгрузку ОПВР в xlsx потоково (constant_memory) в файл path."""
    wb = xlsxwriter.Workbook(path, {'constant_memory': True})
    ws = wb.add_worksheet('ОПВР')
    header_fmt = wb.add_format({'bold': True})
    for col, w in enumerate(OPPV_EXPORT_WIDTHS):
        ws.set_column(col, col, w)
    for col, name in enumerate(OPPV_EXPORT_HEADERS):
        ws.write_string(0, col, name, header_fmt)
    ws.freeze_panes(1, 0)

    row_idx = 0
    # Одна запись строки вместо двенадцати вызовов на ячейку. Текстовые поля
    # отдаём как str — БИН с ведущими нулями должен остаться текстом.
    for r in query.yield_per(5000):
        row_idx += 1
        ws.write_row(row_idx, 0, [
            r[0] or '', r[1] or '', r[2] or '', r[3] or '',
            r[4], r[5] or '', r[6], r[7], r[8], r[9],
        ])
    if row_idx:
        ws.autofilter(0, 0, row_idx, len(OPPV_EXPORT_HEADERS) - 1)
    wb.close()


def oppv_cached_export_path(params: dict):
    """Путь к готовому файлу, если запрос без фильтров, иначе None."""
    if any(params.get(k) not in (None, "") for k in params):
        return None
    return os.path.join(EXPORT_DIR, OPPV_EXPORT_FILE)


def rebuild_oppv_export(wait: bool = False, only_missing: bool = False):
    """Пересобирает готовый файл ОПВР. Атомарно (temp -> os.replace).

    wait=False — пропустить, если сборка уже идёт (планировщик);
    wait=True  — дождаться и собрать (после загрузки новой выгрузки).
    """
    if not _oppv_export_lock.acquire(blocking=wait):
        return
    try:
        dest = os.path.join(EXPORT_DIR, OPPV_EXPORT_FILE)
        if only_missing and os.path.exists(dest):
            return
        db = SessionLocal()
        try:
            if not db.execute(text("SELECT 1 FROM oppv_records LIMIT 1")).first():
                return                       # данных нет — собирать нечего
            tmp = dest + ".tmp"
            write_oppv_xlsx(oppv_export_query(db, {}), tmp)
            os.replace(tmp, dest)
            print(f"Rebuilt cached export: {OPPV_EXPORT_FILE}", flush=True)
        finally:
            db.close()
    except Exception as e:
        print(f"OPPV export rebuild failed: {e}", flush=True)
    finally:
        _oppv_export_lock.release()


@app.get("/api/oppv/download")
def download_oppv(
    region: Optional[str] = None,
    bin: Optional[str] = None,
    bin_name: Optional[str] = None,
    oked_code: Optional[str] = None,
    oked_name: Optional[str] = None,
    gender: Optional[str] = None,
    oked_code_low: Optional[str] = None,
    oked_name_low: Optional[str] = None,
    current_user: models.User = Depends(auth.require_appvr),
    db: Session = Depends(database.get_db)
):
    params = {k: v for k, v in locals().items() if k not in ("current_user", "db")}

    # Без фильтров — отдаём готовый файл, собранный в фоне.
    cached = oppv_cached_export_path(params)
    if cached and os.path.exists(cached):
        return FileResponse(
            cached,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename=OPPV_EXPORT_FILE,
        )

    # С фильтрами — собираем на лету во временный файл (отфильтрованных строк
    # на порядки меньше, это быстро) и удаляем после отдачи.
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx')
    tmp.close()
    write_oppv_xlsx(oppv_export_query(db, params), tmp.name)

    return FileResponse(
        tmp.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="oppv_svod.xlsx",
        background=BackgroundTask(os.unlink, tmp.name),
    )


# Поля, по которым собираем справочник уникальных значений
OPPV_DICT_FIELDS = ('region', 'oked_code', 'oked_name',
                    'oked_code_low', 'oked_name_low', 'gender')


def rebuild_oppv_dict(db):
    """Пересобирает oppv_dict — уникальные значения полей ОПВР с частотой.

    Без него автоподсказки и список регионов делали DISTINCT по всей таблице
    (270к строк на каждое нажатие клавиши). В справочнике меньше тысячи строк.
    """
    db.execute(text("DELETE FROM oppv_dict"))
    for f in OPPV_DICT_FIELDS:           # имена полей из константы, не из запроса
        db.execute(text(
            "INSERT INTO oppv_dict (field, value, cnt) "
            "SELECT :f, {c}, count(*) FROM oppv_records "
            "WHERE {c} IS NOT NULL AND {c} <> '' GROUP BY {c} "
            "ON CONFLICT (field, value) DO NOTHING".format(c=f)
        ), {"f": f})
    db.commit()
    total = db.execute(text("SELECT count(*) FROM oppv_dict")).scalar() or 0
    print(f"Rebuilt oppv_dict: {total} rows", flush=True)


def _ensure_oppv_dict(db):
    """Собирает справочник, если он пуст, а данные ОПВР уже загружены."""
    try:
        have = db.execute(text("SELECT count(*) FROM oppv_dict")).scalar() or 0
        if have:
            return
        if db.execute(text("SELECT 1 FROM oppv_records LIMIT 1")).first():
            rebuild_oppv_dict(db)
    except Exception as e:
        db.rollback()
        print(f"oppv_dict init skipped: {e}", flush=True)


@app.get("/api/oppv/suggestions")
def get_oppv_suggestions(
    field: str,
    query: str = "",
    limit: int = Query(10, le=2000),
    current_user: models.User = Depends(auth.require_appvr),
    db: Session = Depends(database.get_db)
):
    """Справочник значений для фильтров ОПВР (ОКЭД и нижний уровень).

    Читаем из предрасчётного oppv_dict, а не DISTINCT по всей таблице.
    """
    if field not in OPPV_DICT_FIELDS:
        raise HTTPException(400, "Invalid field")
    _ensure_oppv_dict(db)
    sql = "SELECT value FROM oppv_dict WHERE field = :f"
    params = {"f": field, "lim": limit}
    if query:
        sql += " AND value ILIKE :like"
        params["like"] = f"%{query}%"
    sql += " ORDER BY value LIMIT :lim"
    rows = db.execute(text(sql), params).fetchall()
    return [str(r[0]) for r in rows if r[0] is not None]


@app.get("/api/oppv/regions")
def get_oppv_regions(
    current_user: models.User = Depends(auth.require_appvr),
    db: Session = Depends(database.get_db)
):
    _ensure_oppv_dict(db)
    rows = db.execute(text(
        "SELECT value FROM oppv_dict WHERE field = 'region' ORDER BY value"
    )).fetchall()
    return [r[0] for r in rows if r[0]]


def _run_oppv_upload(tmp_path: str, job_id: str):
    """Фоновый разбор сводного Excel ОПВР (колонки по позиции) с прогрессом."""
    db = SessionLocal()
    try:
        wb = openpyxl.load_workbook(tmp_path, read_only=True, data_only=True)
        ws = wb.active
        _set_job(job_id, total=_sheet_total_rows(ws))

        rows_iter = ws.iter_rows(values_only=True)
        header = list(next(rows_iter))  # строка заголовков

        def s_int(v):
            if v is None:
                return None
            try:
                return int(v)
            except Exception:
                return None

        def s_float(v):
            if v is None:
                return None
            try:
                f = float(v)
                return None if f != f else f
            except Exception:
                return None

        def s_str(v):
            return str(v).strip() if v is not None else None

        # Колонки читаем ПО НАЗВАНИЮ (регистронезависимо), а не по позиции.
        # Для каждого поля — список возможных заголовков по приоритету, чтобы
        # разные форматы источника (с «нижним уровнем» и без, старые/новые имена)
        # грузились без правок кода. Отображаемые «Код ОКЭД»/«ОКЭД» = *_low;
        # если «нижнего уровня» в файле нет — берём обычные «Код ОКЭД»/«ОКЭД».
        hidx = {str(h).strip().lower(): i for i, h in enumerate(header) if h is not None}
        OPPV_COL_ALIASES = {
            'region': ['Регион'],
            'bin': ['БИН'],
            'bin_name': ['Наименование организации', 'Наименование', 'Название компании'],
            'oked_code': ['Код ОКЭД'],
            'oked_name': ['ОКЭД'],
            'oked_code_low': ['Код ОКЭД (нижний уровень)', 'Код ОКЭД'],
            'oked_name_low': ['ОКЭД (нижний уровень)', 'ОКЭД'],
            'age': ['Возраст'],
            'gender': ['Пол'],
            'count': ['Кол-во', 'Количество сотрудников', 'Количество'],
            'experience': ['Стаж'],
            'fot': ['ФОТ'],
            'smz': ['СМЗ'],
        }
        colpos = {}
        for field, names in OPPV_COL_ALIASES.items():
            colpos[field] = next((hidx[n.strip().lower()] for n in names
                                  if n.strip().lower() in hidx), None)

        # Обязателен минимум: регион, БИН и ОКЭД (в любом виде). «Нижний уровень»
        # опционален — если его нет, отображаемый ОКЭД берётся из обычного.
        REQUIRED = {'region': 'Регион', 'bin': 'БИН', 'oked_name_low': 'ОКЭД'}
        missing = [label for f, label in REQUIRED.items() if colpos.get(f) is None]
        if missing:
            raise Exception("В файле не найдены колонки: " + ", ".join(missing))

        def cell(row, field):
            p = colpos.get(field)
            return row[p] if (p is not None and p < len(row)) else None

        db.query(models.OppvRecord).delete()
        db.commit()

        now = datetime.now()
        records = []
        processed = 0
        BATCH = 5000

        for idx, row in enumerate(rows_iter):
            if row is None:
                continue
            try:
                records.append({
                    'region': s_str(cell(row, 'region')),
                    'bin': s_str(cell(row, 'bin')),
                    'bin_name': s_str(cell(row, 'bin_name')),
                    'oked_code': s_str(cell(row, 'oked_code')),
                    'oked_name': s_str(cell(row, 'oked_name')),
                    'age': s_int(cell(row, 'age')),
                    'gender': s_str(cell(row, 'gender')),
                    'count': s_int(cell(row, 'count')),
                    'experience': s_int(cell(row, 'experience')),
                    'fot': s_float(cell(row, 'fot')),
                    'smz': s_float(cell(row, 'smz')),
                    'oked_code_low': s_str(cell(row, 'oked_code_low')),
                    'oked_name_low': s_str(cell(row, 'oked_name_low')),
                    'created_at': now,
                })
                processed += 1
                if len(records) >= BATCH:
                    try:
                        db.bulk_insert_mappings(models.OppvRecord, records)
                        db.commit()
                    except Exception as be:
                        db.rollback()
                        print(f"OPPV batch insert failed: {be}")
                    records = []
                    _set_job(job_id, processed=processed)
            except Exception as e:
                print(f"Error processing OPPV row {idx}: {e}")
                continue

        if records:
            try:
                db.bulk_insert_mappings(models.OppvRecord, records)
                db.commit()
            except Exception as be:
                db.rollback()
                print(f"OPPV final batch insert failed: {be}")

        wb.close()
        count = db.query(models.OppvRecord).count()
        try:
            rebuild_oppv_dict(db)          # значения изменились — обновляем подсказки
            db.execute(text("ANALYZE oppv_records"))
            db.commit()
        except Exception as de:
            db.rollback()
            print(f"oppv_dict rebuild failed: {de}")
        threading.Thread(                  # готовый Excel — в фоне, ~18 с
            target=lambda: rebuild_oppv_export(wait=True), daemon=True
        ).start()
        _set_job(job_id, status="done", processed=processed,
                 message=f"Загружено записей ОПВР: {count}", finished_at=time.time())

    except Exception as e:
        db.rollback()
        _set_job(job_id, status="error", error=str(e), finished_at=time.time())
    finally:
        db.close()
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.post("/api/oppv/upload")
def upload_oppv(
    file: UploadFile = File(...),
    current_user: models.User = Depends(auth.require_admin),
):
    """Принимает файл ОПВР, парсит в фоне. Возвращает job_id для опроса прогресса.
    Колонки читаются по названиям (Регион, БИН, Код ОКЭД, ОКЭД, Возраст, Пол,
    Кол-во, Стаж, ФОТ, СМЗ, Код ОКЭД (нижний уровень), ОКЭД (нижний уровень)) —
    порядок столбцов в файле значения не имеет."""
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(400, "Only Excel files are allowed")

    with tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx') as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    job_id = _new_upload_job()
    threading.Thread(
        target=_run_oppv_upload, args=(tmp_path, job_id), daemon=True
    ).start()
    return {"job_id": job_id}


# ============ REGIONS & DISTRICTS ============

@app.get("/api/regions")
def get_regions(
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    """Список уникальных областей из таблицы (для фильтра)"""
    rows = (
        db.query(models.InsuranceRecord.obl_name)
        .filter(models.InsuranceRecord.obl_name.isnot(None))
        .distinct()
        .order_by(models.InsuranceRecord.obl_name)
        .all()
    )
    return [r[0] for r in rows if r[0]]


@app.get("/api/districts")
def get_districts(
    region: str,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    """Список уникальных районов для заданной области"""
    rows = (
        db.query(models.InsuranceRecord.rai_name)
        .filter(
            models.InsuranceRecord.obl_name == region,
            models.InsuranceRecord.rai_name.isnot(None),
        )
        .distinct()
        .order_by(models.InsuranceRecord.rai_name)
        .all()
    )
    return [r[0] for r in rows if r[0]]


# ============ USER MANAGEMENT (ADMIN) ============

@app.get("/api/users", response_model=List[schemas.UserResponse])
def list_users(
    current_user: models.User = Depends(auth.require_admin_or_manager),
    db: Session = Depends(database.get_db)
):
    return db.query(models.User).order_by(models.User.id).all()


def _normalize_iin(raw):
    """Пустая строка/None → None; иначе ровно 12 цифр, иначе ошибка 400."""
    if raw is None:
        return None
    s = str(raw).strip()
    if s == "":
        return None
    if not re.fullmatch(r"\d{12}", s):
        raise HTTPException(400, "ИИН должен состоять ровно из 12 цифр")
    return s


def _check_iin_unique(db, iin, exclude_user_id=None):
    if not iin:
        return
    q = db.query(models.User).filter(models.User.iin == iin)
    if exclude_user_id is not None:
        q = q.filter(models.User.id != exclude_user_id)
    if q.first():
        raise HTTPException(400, "Этот ИИН уже привязан к другому аккаунту")


ALLOWED_ROLES = ("user", "manager", "admin", "dkgit")


@app.post("/api/users", response_model=schemas.UserResponse)
def create_user(
    data: schemas.UserCreate,
    current_user: models.User = Depends(auth.require_admin_or_manager),
    db: Session = Depends(database.get_db)
):
    if db.query(models.User).filter(models.User.username == data.username).first():
        raise HTTPException(400, "Пользователь с таким логином уже существует")

    role = data.role if data.role in ALLOWED_ROLES else "user"
    iin = _normalize_iin(data.iin)
    eds_disabled = 1 if data.eds_disabled else 0

    # Менеджер может создавать только обычные аккаунты и только с ЭЦП
    if current_user.role == "manager":
        role = "user"
        eds_disabled = 0
        if not iin:
            raise HTTPException(400, "Менеджер может создавать только аккаунты с ЭЦП — укажите ИИН")

    _check_iin_unique(db, iin)
    user = models.User(
        username=data.username,
        hashed_password=auth.get_password_hash(data.password),
        role=role,
        region=data.region,
        appvr_access=1 if data.appvr_access else 0,
        dashboard_access=1 if data.dashboard_access else 0,
        iin=iin,
        eds_disabled=eds_disabled,
        is_active=1,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@app.patch("/api/users/{user_id}", response_model=schemas.UserResponse)
def update_user(
    user_id: int,
    data: schemas.UserUpdate,
    current_user: models.User = Depends(auth.require_admin),
    db: Session = Depends(database.get_db)
):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    if data.role is not None and data.role in ALLOWED_ROLES:
        user.role = data.role
    if data.appvr_access is not None:
        user.appvr_access = 1 if data.appvr_access else 0
    if data.dashboard_access is not None:
        user.dashboard_access = 1 if data.dashboard_access else 0
    if data.eds_disabled is not None:
        user.eds_disabled = 1 if data.eds_disabled else 0
    # iin присылается только когда админ его редактирует; "" → отвязать ИИН
    if data.iin is not None:
        iin = _normalize_iin(data.iin)
        _check_iin_unique(db, iin, exclude_user_id=user.id)
        user.iin = iin
    db.commit()
    db.refresh(user)
    return user


@app.delete("/api/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: models.User = Depends(auth.require_admin),
    db: Session = Depends(database.get_db)
):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    if user.username in ("admin", "user"):
        raise HTTPException(400, "Нельзя удалить системных пользователей")
    db.delete(user)
    db.commit()
    return {"message": "Удалён"}


# ============ LOGIN LOGS ============

@app.get("/api/logs", response_model=schemas.LoginLogList)
def get_login_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    username: Optional[str] = None,
    region: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    current_user: models.User = Depends(auth.require_admin_or_manager),
    db: Session = Depends(database.get_db)
):
    query = db.query(models.LoginLog).filter(
        models.LoginLog.username.notin_(SYSTEM_ACCOUNTS)
    )

    if username:
        query = query.filter(models.LoginLog.username.ilike(f"%{username}%"))
    if region:
        query = query.filter(models.LoginLog.region == region)
    if date_from:
        query = query.filter(models.LoginLog.logged_at >= date_from)
    if date_to:
        # включаем весь день date_to
        query = query.filter(models.LoginLog.logged_at < date_to + timedelta(days=1))

    total = query.count()
    items = (
        query.order_by(models.LoginLog.logged_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return schemas.LoginLogList(items=items, total=total, page=page, page_size=page_size)


@app.get("/api/logs/stats", response_model=schemas.LogStatList)
def login_stats_table(
    username: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    current_user: models.User = Depends(auth.require_admin_or_manager),
    db: Session = Depends(database.get_db)
):
    """Таблица: сколько раз каждый аккаунт заходил (всего или за период).
    Поиск по логину. Включает аккаунты, которые ни разу не заходили (0)."""
    L = models.LoginLog
    stats_q = db.query(
        L.username,
        func.count().label("logins"),
        func.max(L.logged_at).label("last_login"),
    ).filter(L.username.notin_(SYSTEM_ACCOUNTS))
    if date_from:
        stats_q = stats_q.filter(L.logged_at >= date_from)
    if date_to:
        stats_q = stats_q.filter(L.logged_at < date_to + timedelta(days=1))
    stats = {r.username: r for r in stats_q.group_by(L.username).all()}

    uq = db.query(models.User).filter(models.User.username.notin_(SYSTEM_ACCOUNTS))
    if username:
        uq = uq.filter(models.User.username.ilike(f"%{username}%"))
    users = uq.all()

    rows = []
    for u in users:
        s = stats.get(u.username)
        rows.append(schemas.LogStatRow(
            username=u.username,
            full_name=u.full_name,
            role=u.role,
            region=u.region,
            logins=(s.logins if s else 0),
            last_login=(s.last_login if s else None),
        ))
    rows.sort(key=lambda r: (r.logins, r.last_login or datetime.min), reverse=True)
    return schemas.LogStatList(items=rows, total=len(rows))


@app.get("/api/logs/heatmap")
def login_heatmap(
    year: int,
    month: int = Query(..., ge=1, le=12),
    current_user: models.User = Depends(auth.require_dashboard),
    db: Session = Depends(database.get_db)
):
    """Активность заходов по регионам за месяц: по каждому региону — счётчики по
    дням (для «гит-календаря»), число активных дней и всего заходов за месяц.
    Для регионального пользователя — только его регион."""
    import calendar
    L = models.LoginLog
    days_in_month = calendar.monthrange(year, month)[1]
    start = date(year, month, 1)
    end = date(year, month, days_in_month)
    day_expr = func.extract('day', L.logged_at)
    q = (db.query(L.region, day_expr.label('d'),
                  func.count().label('c'),
                  func.count(func.distinct(L.username)).label('u'))
         .filter(L.username.notin_(SYSTEM_ACCOUNTS),
                 L.logged_at >= start,
                 L.logged_at < end + timedelta(days=1)))
    if current_user.region:
        q = q.filter(L.region == current_user.region)
    rows = q.group_by(L.region, day_expr).all()
    # всего заходов и уникальных учёток за месяц по региону (не сумма дневных uniq)
    mq = (db.query(L.region,
                   func.count().label('c'),
                   func.count(func.distinct(L.username)).label('u'))
          .filter(L.username.notin_(SYSTEM_ACCOUNTS),
                  L.logged_at >= start,
                  L.logged_at < end + timedelta(days=1)))
    if current_user.region:
        mq = mq.filter(L.region == current_user.region)
    month_tot = {}
    for region, c, u in mq.group_by(L.region).all():
        month_tot[region or NO_REGION_LABEL] = (int(c), int(u))
    agg = {}
    for region, d, c, u in rows:
        key = region or NO_REGION_LABEL
        agg.setdefault(key, {})[int(d)] = (int(c), int(u))
    regions = []
    for region, days in agg.items():
        mc, mu = month_tot.get(region, (0, 0))
        regions.append({
            'region': region,
            # число заходов за день
            'days': [days.get(d, (0, 0))[0] for d in range(1, days_in_month + 1)],
            # число уникальных учёток за день
            'users': [days.get(d, (0, 0))[1] for d in range(1, days_in_month + 1)],
            'active_days': len(days),
            'total': mc,          # всего заходов за месяц
            'total_users': mu,    # уникальных учёток за месяц
        })
    # ГАК всегда первым, остальные — по алфавиту
    regions.sort(key=lambda r: (0 if 'ГАК' in (r['region'] or '').upper() else 1, r['region'] or ''))
    return {'year': year, 'month': month, 'days_in_month': days_in_month, 'regions': regions}


@app.get("/api/logs/stats/export")
def export_login_stats_table(
    username: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    current_user: models.User = Depends(auth.require_admin_or_manager),
    db: Session = Depends(database.get_db)
):
    """Excel-выгрузка таблицы логов (сколько раз какой аккаунт заходил)."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, Side
    from openpyxl.utils import get_column_letter

    data = login_stats_table(username=username, date_from=date_from, date_to=date_to,
                             current_user=current_user, db=db)

    wb = Workbook()
    ws = wb.active
    ws.title = "Таблица логов"

    thin = Side(style="thin", color="000000")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)

    headers = ["Логин", "ФИО", "Роль", "Регион", "Кол-во входов", "Последний вход"]
    for col, name in enumerate(headers, start=1):
        c = ws.cell(row=1, column=col, value=name)
        c.font = Font(bold=True)
        c.alignment = center
        c.border = border

    for i, r in enumerate(data.items, start=2):
        vals = [
            r.username, r.full_name or "", r.role or "",
            r.region or NO_REGION_LABEL, r.logins,
            r.last_login,
        ]
        for col, v in enumerate(vals, start=1):
            c = ws.cell(row=i, column=col, value=v)
            c.border = border
            c.alignment = center if col in (3, 5) else left
            if col == 6 and r.last_login:
                c.number_format = "DD.MM.YYYY, HH:MM:SS"

    widths = [22, 32, 12, 26, 15, 24]
    for col, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(col)].width = w
    ws.freeze_panes = "A2"

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx')
    tmp.close()
    wb.save(tmp.name)
    return FileResponse(
        tmp.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="login_stats_table.xlsx",
        background=BackgroundTask(os.unlink, tmp.name),
    )


NO_REGION_LABEL = "АО КСЖ ГАК"

_MONTHS_GEN = (
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
)


def _period_caption(date_from: Optional[date], date_to: Optional[date]) -> str:
    """Подпись колонки: «за период с 8 – 9 июля 2026 года» и т.п."""
    if not date_from and not date_to:
        return "Кол-во авторизаций за весь период"

    def full(d):
        return f"{d.day} {_MONTHS_GEN[d.month - 1]} {d.year} года"

    if date_from and date_to:
        if (date_from.month, date_from.year) == (date_to.month, date_to.year):
            return (f"Кол-во авторизаций за период с {date_from.day} – "
                    f"{date_to.day} {_MONTHS_GEN[date_to.month - 1]} {date_to.year} года")
        return f"Кол-во авторизаций за период с {full(date_from)} по {full(date_to)}"
    if date_from:
        return f"Кол-во авторизаций с {full(date_from)}"
    return f"Кол-во авторизаций по {full(date_to)}"


@app.get("/api/logs/export")
def export_login_stats_xlsx(
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    current_user: models.User = Depends(auth.require_admin_or_manager),
    db: Session = Depends(database.get_db)
):
    """Excel: статистика авторизаций по регионам. Без дат — за всё время."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, Side
    from openpyxl.utils import get_column_letter

    L = models.LoginLog

    # Все учётные записи, включая тех, кто ни разу не заходил
    users = (
        db.query(models.User)
        .filter(models.User.username.notin_(SYSTEM_ACCOUNTS))
        .all()
    )

    stats_q = db.query(
        L.username,
        func.count().label("logins"),
        func.max(L.logged_at).label("last_login"),
    ).filter(L.username.notin_(SYSTEM_ACCOUNTS))

    if date_from:
        stats_q = stats_q.filter(L.logged_at >= date_from)
    if date_to:
        stats_q = stats_q.filter(L.logged_at < date_to + timedelta(days=1))

    stats = {r.username: r for r in stats_q.group_by(L.username).all()}

    # Группируем учётки по регионам
    regions = {}
    for u in users:
        regions.setdefault(u.region or NO_REGION_LABEL, []).append(u)

    # Регионы по алфавиту, «АО КСЖ ГАК» — в конец
    ordered = sorted(regions, key=lambda r: (r == NO_REGION_LABEL, r.lower()))

    wb = Workbook()
    ws = wb.active
    ws.title = "Статистика"

    thin = Side(style="thin", color="000000")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)

    ws.merge_cells("A1:E1")
    title = ws["A1"]
    title.value = "Статистика входа пользователей АО «КСЖ «ГАК» в портал"
    title.font = Font(bold=True, size=12)
    title.alignment = center

    headers = ["№", "Регион", "Кол-во учетных записей",
               _period_caption(date_from, date_to),
               "Дата и время авторизации последней авторизации"]
    for col, name in enumerate(headers, start=1):
        c = ws.cell(row=2, column=col, value=name)
        c.font = Font(bold=True)
        c.alignment = left if col == 2 else center
        c.border = border

    row = 3
    for num, region in enumerate(ordered, start=1):
        accounts = regions[region]
        # Активные сверху, самый свежий вход первым
        accounts.sort(
            key=lambda u: (stats[u.username].last_login if u.username in stats else datetime.min),
            reverse=True,
        )
        total_logins = sum(stats[u.username].logins for u in accounts if u.username in stats)
        first_row, last_row = row, row + len(accounts) - 1

        for u in accounts:
            last_login = stats[u.username].last_login if u.username in stats else None
            c = ws.cell(row=row, column=5)
            if last_login:
                c.value = last_login
                c.number_format = "DD.MM.YYYY, HH:MM:SS"
            c.alignment = left
            c.border = border
            for col in (1, 2, 3, 4):
                ws.cell(row=row, column=col).border = border
            row += 1

        for col, value, align in (
            (1, num, center),
            (2, region, left),
            (3, len(accounts), center),
            (4, total_logins, center),
        ):
            if last_row > first_row:
                ws.merge_cells(start_row=first_row, start_column=col,
                               end_row=last_row, end_column=col)
            cell = ws.cell(row=first_row, column=col, value=value)
            cell.alignment = align
            cell.border = border

    for col, width in enumerate((6, 34, 20, 24, 30), start=1):
        ws.column_dimensions[get_column_letter(col)].width = width
    ws.row_dimensions[2].height = 32

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    fname = f"logins_{date_from or 'all'}_{date_to or 'all'}.xlsx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={fname}"}
    )


# ============ SHARED FILES ============

FILES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads", "files")
os.makedirs(FILES_DIR, exist_ok=True)

MAX_FILE_SIZE = 200 * 1024 * 1024  # 200 МБ — столько же пропускает nginx


@app.get("/api/files", response_model=List[schemas.StoredFileResponse])
def list_files(
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    return db.query(models.StoredFile).order_by(models.StoredFile.uploaded_at.desc()).all()


@app.post("/api/files", response_model=schemas.StoredFileResponse)
def upload_shared_file(
    file: UploadFile = File(...),
    current_user: models.User = Depends(auth.require_admin),
    db: Session = Depends(database.get_db)
):
    if not file.filename:
        raise HTTPException(400, "Файл без имени")

    ext = os.path.splitext(file.filename)[1][:20]
    stored_name = f"{uuid.uuid4().hex}{ext}"
    dest = os.path.join(FILES_DIR, stored_name)

    size = 0
    try:
        with open(dest, "wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_FILE_SIZE:
                    raise HTTPException(413, "Файл больше 200 МБ")
                out.write(chunk)
    except Exception:
        if os.path.exists(dest):
            os.unlink(dest)
        raise

    record = models.StoredFile(
        original_name=os.path.basename(file.filename)[:300],
        stored_name=stored_name,
        size_bytes=size,
        content_type=file.content_type,
        uploaded_by=current_user.username,
        uploaded_at=datetime.now(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


@app.get("/api/files/{file_id}/download")
def download_shared_file(
    file_id: int,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    record = db.query(models.StoredFile).filter(models.StoredFile.id == file_id).first()
    if not record:
        raise HTTPException(404, "Файл не найден")

    path = os.path.join(FILES_DIR, record.stored_name)
    if not os.path.exists(path):
        raise HTTPException(404, "Файл отсутствует на диске")

    return FileResponse(
        path,
        filename=record.original_name,
        media_type=record.content_type or "application/octet-stream",
    )


@app.delete("/api/files/{file_id}")
def delete_shared_file(
    file_id: int,
    current_user: models.User = Depends(auth.require_admin),
    db: Session = Depends(database.get_db)
):
    record = db.query(models.StoredFile).filter(models.StoredFile.id == file_id).first()
    if not record:
        raise HTTPException(404, "Файл не найден")

    path = os.path.join(FILES_DIR, record.stored_name)
    if os.path.exists(path):
        os.unlink(path)
    db.delete(record)
    db.commit()
    return {"message": "Удалён"}


# ============ LAST UPDATE DATE ============

@app.get("/api/settings/last_update")
def get_last_update(
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    row = db.query(models.AppSetting).filter(models.AppSetting.key == "last_update").first()
    return {"last_update": row.value if row else None}


@app.put("/api/settings/last_update")
def set_last_update(
    body: dict,
    current_user: models.User = Depends(auth.require_admin),
    db: Session = Depends(database.get_db)
):
    value = body.get("last_update", "")
    row = db.query(models.AppSetting).filter(models.AppSetting.key == "last_update").first()
    if row:
        row.value = value
    else:
        db.add(models.AppSetting(key="last_update", value=value))
    db.commit()
    return {"last_update": value}


@app.get("/api/suggestions")
def get_suggestions(
    field: str,
    query: str = "",
    limit: int = Query(10, le=20),
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    allowed = {
        'bin': models.InsuranceRecord.bin,
        'bin_name': models.InsuranceRecord.bin_name,
        'system_delimiter_bin': models.InsuranceRecord.system_delimiter_bin,
        'system_delimiter_bin_name': models.InsuranceRecord.system_delimiter_bin_name,
    }
    if field not in allowed:
        raise HTTPException(400, "Invalid field")

    bin_fields = {'bin', 'system_delimiter_bin'}
    col = allowed[field]
    q = db.query(col).filter(col.isnot(None))
    if query:
        # Для БИН-полей убираем ведущие нули перед сравнением
        search = (query.lstrip('0') or query) if field in bin_fields else query
        q = q.filter(col.cast(String).ilike(f"%{search}%"))
    rows = q.distinct().limit(limit).all()
    # Для БИН-полей форматируем с нулями в ответе
    if field in bin_fields:
        return [str(int(float(r[0]))).zfill(12) for r in rows if r[0] is not None]
    return [str(r[0]) for r in rows if r[0] is not None]


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
