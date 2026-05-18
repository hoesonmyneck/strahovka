from pydantic import BaseModel
from typing import Optional, List
from datetime import date, datetime

class InsuranceRecordBase(BaseModel):
    row_num: Optional[int] = None
    bin: Optional[int] = None
    contract_number: Optional[str] = None
    contract_date: Optional[date] = None
    date_beg: Optional[date] = None
    date_end: Optional[date] = None
    bin_name: Optional[str] = None
    obl_name: Optional[str] = None
    rai_name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    leader_surname: Optional[str] = None
    leader_name: Optional[str] = None
    leader_middlename: Optional[str] = None
    opf_name: Optional[str] = None
    id_oked: Optional[str] = None
    name_oked: Optional[str] = None
    calculated_amount: Optional[float] = None
    count_employees: Optional[float] = None
    total_employees_count: Optional[float] = None
    kol_12mes: Optional[int] = None
    fot_12mes: Optional[int] = None
    is_insured: Optional[int] = 1

class InsuranceRecordResponse(InsuranceRecordBase):
    id: int
    created_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True

class InsuranceRecordList(BaseModel):
    items: List[InsuranceRecordResponse]
    total: int
    page: int
    page_size: int

class FilterParams(BaseModel):
    bin: Optional[str] = None
    bin_name: Optional[str] = None
    contract_number: Optional[str] = None
    contract_date_from: Optional[date] = None
    contract_date_to: Optional[date] = None
    date_end_from: Optional[date] = None
    date_end_to: Optional[date] = None
    obl_name: Optional[str] = None
    rai_name: Optional[str] = None
    opf_name: Optional[str] = None
    is_insured: Optional[int] = None
    expires_in_months: Optional[int] = None  # 1, 3, или 6 месяцев

class MetricsResponse(BaseModel):
    total: int
    insured: int
    not_insured: int

class UserBase(BaseModel):
    username: str
    role: str = "user"

class UserCreate(UserBase):
    password: str

class UserResponse(UserBase):
    id: int
    is_active: int
    
    class Config:
        from_attributes = True

class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    username: Optional[str] = None
    role: Optional[str] = None
