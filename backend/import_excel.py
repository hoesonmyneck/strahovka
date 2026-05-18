#!/usr/bin/env python3
"""
Скрипт для первоначальной загрузки данных из Excel в PostgreSQL.
Запуск: python import_excel.py GAK.xlsx
"""

import sys
import pandas as pd
from datetime import datetime
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.models import InsuranceRecord, Base

DATABASE_URL = "postgresql://postgres:postgres@db:5432/strahovka"

def import_excel(file_path):
    print(f"Reading file: {file_path}")
    df = pd.read_excel(file_path)
    print(f"Total rows to import: {len(df)}")
    
    engine = create_engine(DATABASE_URL)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()
    
    # Создаем таблицы если их нет
    Base.metadata.create_all(bind=engine)
    
    # Очищаем старые данные
    print("Clearing old data...")
    db.query(InsuranceRecord).delete()
    db.commit()
    
    # Загружаем новые данные
    imported = 0
    errors = 0
    
    for idx, row in df.iterrows():
        try:
            # Определяем застрахован ли (проверяем date_end)
            is_insured = 0
            date_end = row.get('DATE_END')
            if pd.notna(date_end) and date_end:
                try:
                    if isinstance(date_end, pd.Timestamp):
                        is_insured = 1 if date_end > pd.Timestamp.now() else 0
                    elif isinstance(date_end, datetime):
                        is_insured = 1 if date_end > datetime.now() else 0
                except:
                    pass
            
            record = InsuranceRecord(
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
                is_insured=is_insured
            )
            db.add(record)
            imported += 1
            
            # Коммитим каждые 1000 записей
            if imported % 1000 == 0:
                db.commit()
                print(f"Imported {imported} records...")
                
        except Exception as e:
            errors += 1
            print(f"Error on row {idx}: {e}")
            continue
    
    # Финальный коммит
    db.commit()
    db.close()
    
    print(f"\nImport completed!")
    print(f"Total imported: {imported}")
    print(f"Errors: {errors}")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python import_excel.py <excel_file>")
        sys.exit(1)
    
    import_excel(sys.argv[1])
