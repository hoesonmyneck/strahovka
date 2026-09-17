from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from starlette.background import BackgroundTask
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session, aliased
from sqlalchemy import func, and_, or_, not_, String, case, distinct
from typing import Optional, List
from datetime import date, datetime, timedelta
import pandas as pd
import io
import os
import tempfile
import shutil
import uuid
import threading
import time
import openpyxl
import xlsxwriter

from . import models, schemas, database, auth
from .database import SessionLocal, engine

models.Base.metadata.create_all(bind=engine)

# Автомиграции
with engine.connect() as _conn:
    for _sql in [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS region VARCHAR(200)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS appvr_access INTEGER DEFAULT 0",
        "ALTER TABLE insurance_records ADD COLUMN IF NOT EXISTS is_passport INTEGER",
        "CREATE INDEX IF NOT EXISTS idx_insurance_is_passport ON insurance_records (is_passport)",
        """CREATE TABLE IF NOT EXISTS app_settings (
               key   VARCHAR(100) PRIMARY KEY,
               value VARCHAR(500)
           )""",
        "INSERT INTO app_settings (key, value) VALUES ('last_update', NULL) ON CONFLICT DO NOTHING",
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


def apply_filters(query, model, params: dict, force_region: str = None):
    """Применяет все фильтры к запросу. force_region — обязательный регион для региональных пользователей."""
    M = model

    # Региональный пользователь — жёстко фиксируем регион, obl_name из params игнорируем
    if force_region:
        query = query.filter(M.obl_name == force_region)
        params = {k: v for k, v in params.items() if k != 'obl_name'}

    bin_ = params.get("bin")
    if bin_:
        # Убираем ведущие нули чтобы "000101651508" находил число 101651508
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


# ============ AUTH ============

# Системные учётки — не журналируем и не показываем в статистике входов
SYSTEM_ACCOUNTS = ("admin", "user")


@app.post("/api/auth/login", response_model=schemas.Token)
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(database.get_db)):
    user = auth.authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Журналируем вход. Ошибка логирования не должна блокировать вход.
    if user.username not in SYSTEM_ACCOUNTS:
        try:
            fwd = request.headers.get("x-forwarded-for")
            ip = fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None)
            db.add(models.LoginLog(
                username=user.username,
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

    access_token = auth.create_access_token(
        data={"sub": user.username, "role": user.role}
    )
    return {"access_token": access_token, "token_type": "bearer"}


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
    expires_in_months: Optional[int] = None,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    params = locals()
    params.pop("current_user"); params.pop("db")

    # Карточки по уникальным БИН. Правила независимы (не дополняют друг друга):
    #   Всего        — все БИН;
    #   Застрахованы — старое правило (ins_old);
    #   Не застрах.  — обязан (obl) И нет действующего договора (act=0).
    # Флаги агрегируются по БИН, поэтому считаем поверх подзапроса с группировкой.
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


# ============ RECORDS ============

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
    expires_in_months: Optional[int] = None,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    params = {k: v for k, v in locals().items() if k not in ("page", "page_size", "sort_by", "sort_order", "current_user", "db")}

    # Одна строка на БИН (реестр организаций)
    query, Rep = deduped_records_query(db, params, force_region=current_user.region)

    total = query.count()

    if sort_by and hasattr(Rep, sort_by):
        order_col = getattr(Rep, sort_by)
        query = query.order_by(order_col.desc() if sort_order == "desc" else order_col.asc())

    records = query.offset((page - 1) * page_size).limit(page_size).all()

    items = []
    for rep, obl, act, ins_old in records:
        item = schemas.InsuranceRecordResponse.model_validate(rep)
        item.is_insured = company_status(obl, act, ins_old)
        items.append(item)

    return schemas.InsuranceRecordList(items=items, total=total, page=page, page_size=page_size)


# ============ EXPORT (xlsx) ============

# Реестр организаций (одна строка на БИН), со всеми колонками включая договорные
EXPORT_HEADERS = [
    'БИН', 'Название компании', 'БИН страховой компании', 'Страховая компания',
    'Номер договора', 'Дата договора', 'Дата начала', 'Дата окончания',
    'Дата расторжения', 'Сумма', 'Застрахованных сотр.', 'Всего сотрудников',
    'Кол-во 12 мес.', 'ФОТ 12 мес.', 'ESUTD акт. ТД', 'Область', 'Район',
    'Адрес', 'Телефон', 'Руководитель', 'ОПФ', 'Код ОКЭД',
    'Вид деятельности (ОКЭД)', 'ИП', 'Флаг', 'Застрахован',
]
EXPORT_COL_WIDTHS = [15, 40, 18, 40, 18, 13, 13, 13, 15, 14, 12, 12, 13, 14, 12,
                     22, 22, 40, 16, 30, 22, 10, 30, 6, 8, 12]

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
    """Запрос выгрузки: реестр организаций (одна строка на БИН) с фильтрами."""
    q, _ = deduped_records_query(db, params, force_region=force_region)
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
            r.address,
            r.phone,
            f"{r.leader_surname or ''} {r.leader_name or ''} {r.leader_middlename or ''}".strip(),
            r.opf_name,
            r.id_oked,
            r.name_oked,
            r.ip,
            r.flag_head,
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


def rebuild_cached_exports(wait: bool = False):
    """Пересобирает три суточных файла. Атомарно (temp -> os.replace).

    wait=False — пропустить, если сборка уже идёт (для планировщика).
    wait=True  — дождаться и собрать (после загрузки нового Excel).
    """
    if not _export_build_lock.acquire(blocking=wait):
        return
    try:
        db = SessionLocal()
        try:
            for iv, fname in CACHED_EXPORTS.items():
                q = records_export_query(db, {"is_insured": iv}, force_region=None)
                dest = os.path.join(EXPORT_DIR, fname)
                tmp = dest + ".tmp"
                write_records_xlsx(q, tmp)
                os.replace(tmp, dest)
                print(f"Rebuilt cached export: {fname}", flush=True)
        finally:
            db.close()
    finally:
        _export_build_lock.release()


def _export_scheduler():
    """Фоновый поток: собрать файлы если их нет, дальше пересобирать раз в сутки в 06:00."""
    if any(not os.path.exists(os.path.join(EXPORT_DIR, f)) for f in CACHED_EXPORTS.values()):
        try:
            rebuild_cached_exports()
        except Exception as e:
            print(f"Initial export build failed: {e}")
    while True:
        now = datetime.now()
        nxt = now.replace(hour=6, minute=0, second=0, microsecond=0)
        if nxt <= now:
            nxt += timedelta(days=1)
        time.sleep(max(1, (nxt - now).total_seconds()))
        try:
            rebuild_cached_exports()
        except Exception as e:
            print(f"Scheduled export build failed: {e}")


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
    expires_in_months: Optional[int] = None,
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
                    'phone': safe_str(row.get('PHONE')),
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

        # Данные сменились — пересобираем суточные готовые файлы в фоне.
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
    'id', 'region', 'bin', 'oked_code', 'oked_name', 'age', 'gender',
    'count', 'experience', 'fot', 'smz', 'oked_code_low', 'oked_name_low',
}
OPPV_TEXT_FILTERS = (
    'region', 'bin', 'oked_code', 'oked_name', 'gender',
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

    if sort_by in OPPV_SORT_FIELDS:
        col = getattr(O, sort_by)
        query = query.order_by(col.desc() if sort_order == "desc" else col.asc())

    items = query.offset((page - 1) * page_size).limit(page_size).all()
    return schemas.OppvRecordList(items=items, total=total, page=page, page_size=page_size)


OPPV_EXPORT_HEADERS = [
    'Регион', 'БИН', 'Код ОКЭД', 'ОКЭД', 'Возраст', 'Пол', 'Кол-во',
    'Стаж', 'ФОТ', 'СМЗ', 'Код ОКЭД (нижний уровень)', 'ОКЭД (нижний уровень)',
]
OPPV_EXPORT_WIDTHS = [22, 16, 12, 40, 10, 10, 10, 8, 16, 16, 20, 40]


@app.get("/api/oppv/download")
def download_oppv(
    region: Optional[str] = None,
    bin: Optional[str] = None,
    oked_code: Optional[str] = None,
    oked_name: Optional[str] = None,
    gender: Optional[str] = None,
    oked_code_low: Optional[str] = None,
    oked_name_low: Optional[str] = None,
    current_user: models.User = Depends(auth.require_appvr),
    db: Session = Depends(database.get_db)
):
    O = models.OppvRecord
    params = {k: v for k, v in locals().items() if k not in ("current_user", "db")}
    query = apply_oppv_filters(db.query(O), params).order_by(O.id)

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx')
    tmp.close()
    wb = xlsxwriter.Workbook(tmp.name, {'constant_memory': True})
    ws = wb.add_worksheet('ОПВР')
    header_fmt = wb.add_format({'bold': True})
    for col, w in enumerate(OPPV_EXPORT_WIDTHS):
        ws.set_column(col, col, w)
    for col, name in enumerate(OPPV_EXPORT_HEADERS):
        ws.write_string(0, col, name, header_fmt)
    ws.freeze_panes(1, 0)

    row_idx = 0
    for r in query.yield_per(2000):
        row_idx += 1
        ws.write_string(row_idx, 0, r.region or '')
        ws.write_string(row_idx, 1, r.bin or '')
        ws.write_string(row_idx, 2, r.oked_code or '')
        ws.write_row(row_idx, 3, [
            r.oked_name, r.age, r.gender, r.count, r.experience,
            r.fot, r.smz,
        ])
        ws.write_string(row_idx, 10, r.oked_code_low or '')
        ws.write_string(row_idx, 11, r.oked_name_low or '')
    if row_idx:
        ws.autofilter(0, 0, row_idx, len(OPPV_EXPORT_HEADERS) - 1)
    wb.close()

    return FileResponse(
        tmp.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="oppv_svod.xlsx",
        background=BackgroundTask(os.unlink, tmp.name),
    )


@app.get("/api/oppv/regions")
def get_oppv_regions(
    current_user: models.User = Depends(auth.require_appvr),
    db: Session = Depends(database.get_db)
):
    rows = (
        db.query(models.OppvRecord.region)
        .filter(models.OppvRecord.region.isnot(None))
        .distinct()
        .order_by(models.OppvRecord.region)
        .all()
    )
    return [r[0] for r in rows if r[0]]


def _run_oppv_upload(tmp_path: str, job_id: str):
    """Фоновый разбор сводного Excel ОПВР (колонки по позиции) с прогрессом."""
    db = SessionLocal()
    try:
        wb = openpyxl.load_workbook(tmp_path, read_only=True, data_only=True)
        ws = wb.active
        _set_job(job_id, total=_sheet_total_rows(ws))

        rows_iter = ws.iter_rows(values_only=True)
        next(rows_iter)  # пропускаем строку заголовков

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

        db.query(models.OppvRecord).delete()
        db.commit()

        now = datetime.now()
        records = []
        processed = 0
        BATCH = 5000

        for idx, row in enumerate(rows_iter):
            if row is None or len(row) < 12:
                continue
            try:
                records.append({
                    'region': s_str(row[0]),
                    'bin': s_str(row[1]),
                    'oked_code': s_str(row[2]),
                    'oked_name': s_str(row[3]),
                    'age': s_int(row[4]),
                    'gender': s_str(row[5]),
                    'count': s_int(row[6]),
                    'experience': s_int(row[7]),
                    'fot': s_float(row[8]),
                    'smz': s_float(row[9]),
                    'oked_code_low': s_str(row[10]),
                    'oked_name_low': s_str(row[11]),
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
    Колонки по позиции: 0 Регион, 1 БИН, 2 Код ОКЭД, 3 ОКЭД, 4 Возраст, 5 Пол,
    6 Кол-во, 7 Стаж, 8 ФОТ, 9 СМЗ, 10 Код ОКЭД (ниж.), 11 ОКЭД (ниж.)."""
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
    current_user: models.User = Depends(auth.require_admin),
    db: Session = Depends(database.get_db)
):
    return db.query(models.User).order_by(models.User.id).all()


@app.post("/api/users", response_model=schemas.UserResponse)
def create_user(
    data: schemas.UserCreate,
    current_user: models.User = Depends(auth.require_admin),
    db: Session = Depends(database.get_db)
):
    if db.query(models.User).filter(models.User.username == data.username).first():
        raise HTTPException(400, "Пользователь с таким логином уже существует")
    user = models.User(
        username=data.username,
        hashed_password=auth.get_password_hash(data.password),
        role=data.role,
        region=data.region,
        appvr_access=1 if data.appvr_access else 0,
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
    if data.appvr_access is not None:
        user.appvr_access = 1 if data.appvr_access else 0
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
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    current_user: models.User = Depends(auth.require_admin),
    db: Session = Depends(database.get_db)
):
    query = db.query(models.LoginLog).filter(
        models.LoginLog.username.notin_(SYSTEM_ACCOUNTS)
    )

    if username:
        query = query.filter(models.LoginLog.username.ilike(f"%{username}%"))
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
def export_login_stats(
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    current_user: models.User = Depends(auth.require_admin),
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
