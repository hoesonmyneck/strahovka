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
    system_delimiter_bin_name = Column(String(500), index=True)
    contract_number = Column(String(100), index=True)
    contract_date = Column(Date)
    date_beg = Column(Date)
    date_end = Column(Date, index=True)  # для фильтра "истекает через N месяцев"
    rescinding_date = Column(Date)
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
    is_passport = Column(Integer, index=True)  # 1 = есть паспорт (для правила «обязан»)

    # Дополнительные поля для фильтрации
    is_insured = Column(Integer, default=1)  # 1 - застрахован, 0 - нет
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index('idx_bin_name', 'bin_name'),  # для поиска по названию
        Index('idx_date_end', 'date_end'),  # для фильтра по дате окончания
    )

class CompanySummary(Base):
    """Предрасчёт: одна строка на БИН (реестр организаций) + флаги статуса.
    Пересобирается после каждой загрузки. Карточки/таблица/выгрузка читают
    отсюда → мгновенно, без агрегации по всей таблице на каждый запрос."""
    __tablename__ = "company_summary"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    bin = Column(BigInteger, index=True)
    bin_name = Column(String(500), index=True)
    system_delimiter_bin = Column(Float)
    system_delimiter_bin_name = Column(String(500), index=True)
    contract_number = Column(String(100))
    contract_date = Column(Date)
    date_beg = Column(Date)
    date_end = Column(Date)
    rescinding_date = Column(Date)
    calculated_amount = Column(Float)
    count_employees = Column(Float)
    total_employees_count = Column(Float)
    flag_head = Column(Float)
    row_num = Column(BigInteger)
    id_reg = Column(BigInteger)
    obl_name = Column(String(200), index=True)
    rai_name = Column(String(200))
    address = Column(String(500))
    phone = Column(String(100))
    leader_surname = Column(String(100))
    leader_name = Column(String(100))
    leader_middlename = Column(String(100))
    opf_name = Column(String(200))
    id_oked = Column(String(20))
    name_oked = Column(String(300))
    kol_12mes = Column(BigInteger)
    fot_12mes = Column(BigInteger)
    esutd_akt_td = Column(BigInteger)
    ip = Column(BigInteger)
    tip = Column(BigInteger)
    # Флаги статуса (агрегированы по БИН на момент пересборки)
    obl = Column(Integer)       # обязан
    act = Column(Integer)       # есть действующий договор
    ins_old = Column(Integer)   # застрахован по старому правилу
    status = Column(Integer, index=True)  # 0 не застрах / 1 застрах / 2 прочее
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index('idx_cs_bin', 'bin'),
        Index('idx_cs_status', 'status'),
        Index('idx_cs_obl_name', 'obl_name'),
    )


class OppvRecord(Base):
    """Обязательные пенсионные взносы работодателя (ОПВР) — сводная выгрузка.
    БИН хранится строкой: в источнике есть ведущие нули (000940000567)."""
    __tablename__ = "oppv_records"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    region = Column(String(200), index=True)              # Регион
    bin = Column(String(20), index=True)                  # БИН (строка, ведущие нули)
    oked_code = Column(String(20))                         # Код ОКЭД
    oked_name = Column(String(300))                        # ОКЭД
    age = Column(Integer)                                  # Возраст
    gender = Column(String(20))                            # Пол
    count = Column(Integer)                                # Кол-во
    experience = Column(Integer)                           # Стаж
    fot = Column(Float)                                    # ФОТ
    smz = Column(Float)                                    # СМЗ
    oked_code_low = Column(String(20))                     # Код ОКЭД (нижний уровень)
    oked_name_low = Column(String(300))                    # ОКЭД (нижний уровень)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index('idx_oppv_bin', 'bin'),
        Index('idx_oppv_region', 'region'),
    )


class AppSetting(Base):
    """Общие настройки приложения (ключ-значение)"""
    __tablename__ = "app_settings"
    key   = Column(String(100), primary_key=True)
    value = Column(String(500))


class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True)
    hashed_password = Column(String(255))
    role = Column(String(20), default="user")  # admin или user
    region = Column(String(200), nullable=True)  # None = без ограничений, иначе = значение obl_name
    appvr_access = Column(Integer, default=0)  # 1 = доступ к разделу ОПВР (Пенсионные взносы)
    is_active = Column(Integer, default=1)
    created_at = Column(DateTime, default=datetime.utcnow)


class StoredFile(Base):
    """Файлы, доступные пользователям для скачивания"""
    __tablename__ = "stored_files"

    id = Column(Integer, primary_key=True, index=True)
    original_name = Column(String(300))        # имя, которое видит пользователь
    stored_name = Column(String(300))          # имя на диске (uuid + расширение)
    size_bytes = Column(BigInteger)
    content_type = Column(String(200), nullable=True)
    uploaded_by = Column(String(50), nullable=True)
    uploaded_at = Column(DateTime, default=datetime.utcnow, index=True)


class LoginLog(Base):
    """Журнал входов в систему"""
    __tablename__ = "login_logs"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), index=True)
    role = Column(String(20))
    region = Column(String(200), nullable=True)
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(500), nullable=True)
    logged_at = Column(DateTime, default=datetime.utcnow, index=True)

    __table_args__ = (
        Index('idx_login_logs_logged_at', 'logged_at'),
    )
