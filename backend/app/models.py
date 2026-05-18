from sqlalchemy import Column, Integer, BigInteger, String, Float, DateTime, Date, Index, create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime

Base = declarative_base()

class InsuranceRecord(Base):
    __tablename__ = "insurance_records"
    
    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    row_num = Column(BigInteger)  # номер строки из Excel
    bin = Column(BigInteger, index=True)  # BIN для поиска
    system_delimiter_bin = Column(Float)
    contract_number = Column(String(100), index=True)
    contract_date = Column(Date)
    date_beg = Column(Date)
    date_end = Column(Date, index=True)  # для фильтра "истекает через N месяцев"
    rescinding_date = Column(Float)
    calculated_amount = Column(Float)
    count_employees = Column(Float)
    total_employees_count = Column(Float)
    id_system = Column(Float)
    flag_head = Column(Float)
    sys_date = Column(DateTime)
    bin_name = Column(String(500), index=True)  # название для поиска
    id_reg = Column(BigInteger)
    obl_name = Column(String(200))
    idrai = Column(BigInteger)
    rai_name = Column(String(200))
    address = Column(String(500))
    phone = Column(String(100))
    mail = Column(Float)
    leader_surname = Column(String(100))
    leader_name = Column(String(100))
    leader_middlename = Column(String(100))
    opf = Column(Float)
    opf_name = Column(String(200))
    id_oked = Column(String(20))
    name_oked = Column(String(300))
    kol_12mes = Column(BigInteger)
    fot_12mes = Column(BigInteger)
    esutd_akt_td = Column(BigInteger)
    ip = Column(BigInteger)
    tip = Column(BigInteger)
    
    # Дополнительные поля для фильтрации
    is_insured = Column(Integer, default=1)  # 1 - застрахован, 0 - нет
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index('idx_bin_name', 'bin_name'),  # для поиска по названию
        Index('idx_date_end', 'date_end'),  # для фильтра по дате окончания
    )

class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True)
    hashed_password = Column(String(255))
    role = Column(String(20), default="user")  # admin или user
    is_active = Column(Integer, default=1)
    created_at = Column(DateTime, default=datetime.utcnow)
