from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, or_, String, case
from typing import Optional, List
from datetime import date, datetime, timedelta
import pandas as pd
import io
import os

from . import models, schemas, database, auth
from .database import SessionLocal, engine

models.Base.metadata.create_all(bind=engine)

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


def apply_filters(query, model, params: dict):
    """Применяет все фильтры к запросу"""
    M = model

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

    if params.get("date_end_from"):
        query = query.filter(M.date_end >= params["date_end_from"])
    if params.get("date_end_to"):
        query = query.filter(M.date_end <= params["date_end_to"])

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

    if params.get("is_insured") is not None:
        query = query.filter(M.is_insured == params["is_insured"])

    if params.get("expires_in_months"):
        target_date = date.today() + timedelta(days=30 * params["expires_in_months"])
        query = query.filter(
            and_(
                M.date_end >= date.today(),
                M.date_end <= target_date
            )
        )

    return query


# ============ AUTH ============

@app.post("/api/auth/login", response_model=schemas.Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(database.get_db)):
    user = auth.authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
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
    # Один SQL-запрос вместо трёх отдельных COUNT
    query = apply_filters(
        db.query(
            func.count().label("total"),
            func.sum(case((models.InsuranceRecord.is_insured == 1, 1), else_=0)).label("insured"),
            func.sum(case((models.InsuranceRecord.is_insured == 0, 1), else_=0)).label("not_insured"),
        ),
        models.InsuranceRecord,
        params
    )
    row = query.one()
    return schemas.MetricsResponse(
        total=row.total or 0,
        insured=row.insured or 0,
        not_insured=row.not_insured or 0
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
    query = apply_filters(db.query(models.InsuranceRecord), models.InsuranceRecord, params)

    total = query.count()

    if sort_by and hasattr(models.InsuranceRecord, sort_by):
        order_col = getattr(models.InsuranceRecord, sort_by)
        query = query.order_by(order_col.desc() if sort_order == "desc" else order_col.asc())

    records = query.offset((page - 1) * page_size).limit(page_size).all()
    return schemas.InsuranceRecordList(items=records, total=total, page=page, page_size=page_size)


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
    query = apply_filters(db.query(models.InsuranceRecord), models.InsuranceRecord, params)
    records = query.all()

    data = []
    for r in records:
        data.append({
            'БИН': r.bin,
            'Название компании': r.bin_name,
            'БИН страховой компании': r.system_delimiter_bin,
            'Страховая компания': r.system_delimiter_bin_name,
            'Номер договора': r.contract_number,
            'Дата договора': r.contract_date,
            'Дата начала': r.date_beg,
            'Дата окончания': r.date_end,
            'Дата расторжения': r.rescinding_date,
            'Сумма': r.calculated_amount,
            'Застрахованных сотр.': r.count_employees,
            'Всего сотрудников': r.total_employees_count,
            'Кол-во 12 мес.': r.kol_12mes,
            'ФОТ 12 мес.': r.fot_12mes,
            'ESUTD акт. ТД': r.esutd_akt_td,
            'Область': r.obl_name,
            'Район': r.rai_name,
            'Адрес': r.address,
            'Телефон': r.phone,
            'Руководитель': f"{r.leader_surname or ''} {r.leader_name or ''} {r.leader_middlename or ''}".strip(),
            'ОПФ': r.opf_name,
            'Код ОКЭД': r.id_oked,
            'Вид деятельности (ОКЭД)': r.name_oked,
            'ИП': r.ip,
            'ТИП': r.tip,
            'Флаг': r.flag_head,
            'Застрахован': 'Да' if r.is_insured else 'Нет',
        })

    df = pd.DataFrame(data)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Insurance Records')
    output.seek(0)

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=insurance_records.xlsx"}
    )


# ============ UPLOAD (ADMIN ONLY) ============

@app.post("/api/upload")
def upload_file(
    file: UploadFile = File(...),
    current_user: models.User = Depends(auth.require_admin),
    db: Session = Depends(database.get_db)
):
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(400, "Only Excel files are allowed")

    try:
        contents = file.file.read()
        df = pd.read_excel(io.BytesIO(contents))

        db.query(models.InsuranceRecord).delete()
        db.commit()

        def safe_int(val):
            try:
                return int(val) if pd.notna(val) else None
            except Exception:
                return None

        def safe_float(val):
            try:
                return float(val) if pd.notna(val) else None
            except Exception:
                return None

        def safe_str(val):
            return str(val) if pd.notna(val) else None

        def safe_date(val):
            return val if pd.notna(val) else None

        for idx, row in df.iterrows():
            try:
                record = models.InsuranceRecord(
                    row_num=safe_int(row.get('   ', idx + 1)),
                    bin=safe_int(row.get('BIN')),
                    system_delimiter_bin=safe_float(row.get('SYSTEM_DELIMITER_BIN')),
                    system_delimiter_bin_name=safe_str(row.get('SYSTEM_DELIMITER_BIN_NAME')),
                    contract_number=safe_str(row.get('CONTRACT_NUMBER')),
                    contract_date=safe_date(row.get('CONTRACT_DATE')),
                    date_beg=safe_date(row.get('DATE_BEG')),
                    date_end=safe_date(row.get('DATE_END')),
                    rescinding_date=safe_float(row.get('RESCINDING_DATE')),
                    calculated_amount=safe_float(row.get('CALCULATED_AMOUNT')),
                    count_employees=safe_float(row.get('COUNT_EMPLOYEES')),
                    total_employees_count=safe_float(row.get('TOTAL_EMPLOYEES_COUNT')),
                    id_system=safe_float(row.get('ID')),
                    flag_head=safe_float(row.get('FLAG_HEAD')),
                    sys_date=safe_date(row.get('SYS_DATE')),
                    bin_name=safe_str(row.get('BIN_NAME')),
                    id_reg=safe_int(row.get('ID_REG')),
                    obl_name=safe_str(row.get('OBL_NAME')),
                    idrai=safe_int(row.get('IDRAI')),
                    rai_name=safe_str(row.get('RAI_NAME')),
                    address=safe_str(row.get('ADDRESS')),
                    phone=safe_str(row.get('PHONE')),
                    mail=safe_float(row.get('MAIL')),
                    leader_surname=safe_str(row.get('LEADER_SURNAME')),
                    leader_name=safe_str(row.get('LEADER_NAME')),
                    leader_middlename=safe_str(row.get('LEADER_MIDDLENAME')),
                    opf=safe_float(row.get('OPF')),
                    opf_name=safe_str(row.get('OPF_NAME')),
                    id_oked=safe_str(row.get('ID_OKED')),
                    name_oked=safe_str(row.get('NAME_OKED')),
                    kol_12mes=safe_int(row.get('KOL_12MES')),
                    fot_12mes=safe_int(row.get('FOT_12MES')),
                    esutd_akt_td=safe_int(row.get('ESUTD_AKT_TD')),
                    ip=safe_int(row.get('IP')),
                    tip=safe_int(row.get('TIP')),
                    is_insured=1 if (safe_date(row.get('DATE_END')) and row.get('DATE_END') > datetime.now()) else 0
                )
                db.add(record)
                if (idx + 1) % 1000 == 0:
                    db.commit()
            except Exception as e:
                print(f"Error processing row {idx}: {e}")
                continue

        db.commit()
        count = db.query(models.InsuranceRecord).count()
        return {"message": f"Successfully uploaded {count} records"}

    except Exception as e:
        db.rollback()
        raise HTTPException(500, f"Error processing file: {str(e)}")


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

    col = allowed[field]
    q = db.query(col).filter(col.isnot(None))
    if query:
        q = q.filter(col.cast(String).ilike(f"%{query}%"))
    rows = q.distinct().limit(limit).all()
    return [str(r[0]) for r in rows if r[0] is not None]


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
