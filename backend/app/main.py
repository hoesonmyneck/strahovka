from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, or_, String
from typing import Optional, List
from datetime import date, datetime, timedelta
import pandas as pd
import io
import os

from . import models, schemas, database, auth
from .database import SessionLocal, engine

# Создаем таблицы
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Strahovka Insurance API")

# CORS для фронтенда
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Инициализация пользователей при старте
@app.on_event("startup")
def startup_event():
    db = SessionLocal()
    try:
        auth.init_default_users(db)
    finally:
        db.close()

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
    contract_number: Optional[str] = None,
    contract_date_from: Optional[date] = None,
    contract_date_to: Optional[date] = None,
    date_end_from: Optional[date] = None,
    date_end_to: Optional[date] = None,
    obl_name: Optional[str] = None,
    rai_name: Optional[str] = None,
    opf_name: Optional[str] = None,
    is_insured: Optional[int] = None,
    expires_in_months: Optional[int] = None,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    query = db.query(models.InsuranceRecord)
    
    # Применяем фильтры
    if bin:
        query = query.filter(models.InsuranceRecord.bin.cast(String).like(f"%{bin}%"))
    if bin_name:
        query = query.filter(models.InsuranceRecord.bin_name.ilike(f"%{bin_name}%"))
    if contract_number:
        query = query.filter(models.InsuranceRecord.contract_number.ilike(f"%{contract_number}%"))
    if contract_date_from:
        query = query.filter(models.InsuranceRecord.contract_date >= contract_date_from)
    if contract_date_to:
        query = query.filter(models.InsuranceRecord.contract_date <= contract_date_to)
    if date_end_from:
        query = query.filter(models.InsuranceRecord.date_end >= date_end_from)
    if date_end_to:
        query = query.filter(models.InsuranceRecord.date_end <= date_end_to)
    if obl_name:
        query = query.filter(models.InsuranceRecord.obl_name.ilike(f"%{obl_name}%"))
    if rai_name:
        query = query.filter(models.InsuranceRecord.rai_name.ilike(f"%{rai_name}%"))
    if opf_name:
        query = query.filter(models.InsuranceRecord.opf_name.ilike(f"%{opf_name}%"))
    if is_insured is not None:
        query = query.filter(models.InsuranceRecord.is_insured == is_insured)
    if expires_in_months:
        target_date = date.today() + timedelta(days=30*expires_in_months)
        query = query.filter(
            and_(
                models.InsuranceRecord.date_end >= date.today(),
                models.InsuranceRecord.date_end <= target_date
            )
        )
    
    total = query.count()
    insured = query.filter(models.InsuranceRecord.is_insured == 1).count()
    not_insured = query.filter(models.InsuranceRecord.is_insured == 0).count()
    
    return schemas.MetricsResponse(
        total=total,
        insured=insured,
        not_insured=not_insured
    )

# ============ RECORDS ============

@app.get("/api/records", response_model=schemas.InsuranceRecordList)
def get_records(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=1000),
    sort_by: Optional[str] = "id",
    sort_order: Optional[str] = "asc",
    bin: Optional[str] = None,
    bin_name: Optional[str] = None,
    contract_number: Optional[str] = None,
    contract_date_from: Optional[date] = None,
    contract_date_to: Optional[date] = None,
    date_end_from: Optional[date] = None,
    date_end_to: Optional[date] = None,
    obl_name: Optional[str] = None,
    rai_name: Optional[str] = None,
    opf_name: Optional[str] = None,
    is_insured: Optional[int] = None,
    expires_in_months: Optional[int] = None,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    query = db.query(models.InsuranceRecord)
    
    # Фильтры
    if bin:
        query = query.filter(models.InsuranceRecord.bin.cast(String).like(f"%{bin}%"))
    if bin_name:
        query = query.filter(models.InsuranceRecord.bin_name.ilike(f"%{bin_name}%"))
    if contract_number:
        query = query.filter(models.InsuranceRecord.contract_number.ilike(f"%{contract_number}%"))
    if contract_date_from:
        query = query.filter(models.InsuranceRecord.contract_date >= contract_date_from)
    if contract_date_to:
        query = query.filter(models.InsuranceRecord.contract_date <= contract_date_to)
    if date_end_from:
        query = query.filter(models.InsuranceRecord.date_end >= date_end_from)
    if date_end_to:
        query = query.filter(models.InsuranceRecord.date_end <= date_end_to)
    if obl_name:
        query = query.filter(models.InsuranceRecord.obl_name.ilike(f"%{obl_name}%"))
    if rai_name:
        query = query.filter(models.InsuranceRecord.rai_name.ilike(f"%{rai_name}%"))
    if opf_name:
        query = query.filter(models.InsuranceRecord.opf_name.ilike(f"%{opf_name}%"))
    if is_insured is not None:
        query = query.filter(models.InsuranceRecord.is_insured == is_insured)
    if expires_in_months:
        target_date = date.today() + timedelta(days=30*expires_in_months)
        query = query.filter(
            and_(
                models.InsuranceRecord.date_end >= date.today(),
                models.InsuranceRecord.date_end <= target_date
            )
        )
    
    total = query.count()
    
    # Сортировка
    if sort_by and hasattr(models.InsuranceRecord, sort_by):
        order_col = getattr(models.InsuranceRecord, sort_by)
        if sort_order == "desc":
            query = query.order_by(order_col.desc())
        else:
            query = query.order_by(order_col.asc())
    
    # Пагинация
    records = query.offset((page - 1) * page_size).limit(page_size).all()
    
    return schemas.InsuranceRecordList(
        items=records,
        total=total,
        page=page,
        page_size=page_size
    )

@app.get("/api/records/download")
def download_records(
    bin: Optional[str] = None,
    bin_name: Optional[str] = None,
    contract_number: Optional[str] = None,
    contract_date_from: Optional[date] = None,
    contract_date_to: Optional[date] = None,
    date_end_from: Optional[date] = None,
    date_end_to: Optional[date] = None,
    obl_name: Optional[str] = None,
    rai_name: Optional[str] = None,
    opf_name: Optional[str] = None,
    is_insured: Optional[int] = None,
    expires_in_months: Optional[int] = None,
    current_user: models.User = Depends(auth.get_current_active_user),
    db: Session = Depends(database.get_db)
):
    """Скачать отфильтрованные данные в Excel"""
    query = db.query(models.InsuranceRecord)
    
    # Применяем те же фильтры
    if bin:
        query = query.filter(models.InsuranceRecord.bin.cast(String).like(f"%{bin}%"))
    if bin_name:
        query = query.filter(models.InsuranceRecord.bin_name.ilike(f"%{bin_name}%"))
    if contract_number:
        query = query.filter(models.InsuranceRecord.contract_number.ilike(f"%{contract_number}%"))
    if contract_date_from:
        query = query.filter(models.InsuranceRecord.contract_date >= contract_date_from)
    if contract_date_to:
        query = query.filter(models.InsuranceRecord.contract_date <= contract_date_to)
    if date_end_from:
        query = query.filter(models.InsuranceRecord.date_end >= date_end_from)
    if date_end_to:
        query = query.filter(models.InsuranceRecord.date_end <= date_end_to)
    if obl_name:
        query = query.filter(models.InsuranceRecord.obl_name.ilike(f"%{obl_name}%"))
    if rai_name:
        query = query.filter(models.InsuranceRecord.rai_name.ilike(f"%{rai_name}%"))
    if opf_name:
        query = query.filter(models.InsuranceRecord.opf_name.ilike(f"%{opf_name}%"))
    if is_insured is not None:
        query = query.filter(models.InsuranceRecord.is_insured == is_insured)
    if expires_in_months:
        target_date = date.today() + timedelta(days=30*expires_in_months)
        query = query.filter(
            and_(
                models.InsuranceRecord.date_end >= date.today(),
                models.InsuranceRecord.date_end <= target_date
            )
        )
    
    records = query.all()
    
    # Конвертируем в DataFrame
    data = []
    for r in records:
        data.append({
            'BIN': r.bin,
            'Название': r.bin_name,
            'Номер договора': r.contract_number,
            'Дата договора': r.contract_date,
            'Дата начала': r.date_beg,
            'Дата окончания': r.date_end,
            'Область': r.obl_name,
            'Район': r.rai_name,
            'Адрес': r.address,
            'Телефон': r.phone,
            'Руководитель': f"{r.leader_surname} {r.leader_name} {r.leader_middlename}",
            'ОПФ': r.opf_name,
            'ОКЭД': r.id_oked,
            'Вид деятельности': r.name_oked,
            'Кол-во сотрудников': r.count_employees,
            'Всего сотрудников': r.total_employees_count,
            'Сумма': r.calculated_amount,
            'Застрахован': 'Да' if r.is_insured else 'Нет'
        })
    
    df = pd.DataFrame(data)
    
    # Создаем Excel в памяти
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
    """Загрузка нового Excel файла (только админ)"""
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(400, "Only Excel files are allowed")
    
    try:
        # Читаем файл
        contents = file.file.read()
        df = pd.read_excel(io.BytesIO(contents))
        
        # Очищаем старые данные
        db.query(models.InsuranceRecord).delete()
        db.commit()
        
        # Загружаем новые данные
        for idx, row in df.iterrows():
            try:
                record = models.InsuranceRecord(
                    row_num=int(row.get('   ', idx+1)),
                    bin=int(row.get('BIN', 0)) if pd.notna(row.get('BIN')) else None,
                    system_delimiter_bin=float(row.get('SYSTEM_DELIMITER_BIN', 0)) if pd.notna(row.get('SYSTEM_DELIMITER_BIN')) else None,
                    contract_number=str(row.get('CONTRACT_NUMBER', '')) if pd.notna(row.get('CONTRACT_NUMBER')) else None,
                    contract_date=row.get('CONTRACT_DATE') if pd.notna(row.get('CONTRACT_DATE')) else None,
                    date_beg=row.get('DATE_BEG') if pd.notna(row.get('DATE_BEG')) else None,
                    date_end=row.get('DATE_END') if pd.notna(row.get('DATE_END')) else None,
                    rescinding_date=float(row.get('RESCINDING_DATE', 0)) if pd.notna(row.get('RESCINDING_DATE')) else None,
                    calculated_amount=float(row.get('CALCULATED_AMOUNT', 0)) if pd.notna(row.get('CALCULATED_AMOUNT')) else None,
                    count_employees=float(row.get('COUNT_EMPLOYEES', 0)) if pd.notna(row.get('COUNT_EMPLOYEES')) else None,
                    total_employees_count=float(row.get('TOTAL_EMPLOYEES_COUNT', 0)) if pd.notna(row.get('TOTAL_EMPLOYEES_COUNT')) else None,
                    id_system=float(row.get('ID', 0)) if pd.notna(row.get('ID')) else None,
                    flag_head=float(row.get('FLAG_HEAD', 0)) if pd.notna(row.get('FLAG_HEAD')) else None,
                    sys_date=row.get('SYS_DATE') if pd.notna(row.get('SYS_DATE')) else None,
                    bin_name=str(row.get('BIN_NAME', '')) if pd.notna(row.get('BIN_NAME')) else None,
                    id_reg=int(row.get('ID_REG', 0)) if pd.notna(row.get('ID_REG')) else None,
                    obl_name=str(row.get('OBL_NAME', '')) if pd.notna(row.get('OBL_NAME')) else None,
                    idrai=int(row.get('IDRAI', 0)) if pd.notna(row.get('IDRAI')) else None,
                    rai_name=str(row.get('RAI_NAME', '')) if pd.notna(row.get('RAI_NAME')) else None,
                    address=str(row.get('ADDRESS', '')) if pd.notna(row.get('ADDRESS')) else None,
                    phone=str(row.get('PHONE', '')) if pd.notna(row.get('PHONE')) else None,
                    mail=float(row.get('MAIL', 0)) if pd.notna(row.get('MAIL')) else None,
                    leader_surname=str(row.get('LEADER_SURNAME', '')) if pd.notna(row.get('LEADER_SURNAME')) else None,
                    leader_name=str(row.get('LEADER_NAME', '')) if pd.notna(row.get('LEADER_NAME')) else None,
                    leader_middlename=str(row.get('LEADER_MIDDLENAME', '')) if pd.notna(row.get('LEADER_MIDDLENAME')) else None,
                    opf=float(row.get('OPF', 0)) if pd.notna(row.get('OPF')) else None,
                    opf_name=str(row.get('OPF_NAME', '')) if pd.notna(row.get('OPF_NAME')) else None,
                    id_oked=str(row.get('ID_OKED', '')) if pd.notna(row.get('ID_OKED')) else None,
                    name_oked=str(row.get('NAME_OKED', '')) if pd.notna(row.get('NAME_OKED')) else None,
                    kol_12mes=int(row.get('KOL_12MES', 0)) if pd.notna(row.get('KOL_12MES')) else None,
                    fot_12mes=int(row.get('FOT_12MES', 0)) if pd.notna(row.get('FOT_12MES')) else None,
                    esutd_akt_td=int(row.get('ESUTD_AKT_TD', 0)) if pd.notna(row.get('ESUTD_AKT_TD')) else None,
                    ip=int(row.get('IP', 0)) if pd.notna(row.get('IP')) else None,
                    tip=int(row.get('TIP', 0)) if pd.notna(row.get('TIP')) else None,
                    is_insured=1 if pd.notna(row.get('DATE_END')) and row.get('DATE_END') and row.get('DATE_END') > datetime.now() else 0
                )
                db.add(record)
                
                # Коммитим пакетами по 1000 записей
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

@app.get("/api/health")
def health_check():
    return {"status": "ok"}
