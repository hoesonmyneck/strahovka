import React, { useState, useEffect, useCallback, useRef } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { useAuth } from '../context/AuthContext.jsx'
import api from '../utils/api.js'
import { toast } from 'react-toastify'
import DatePicker from 'react-datepicker'
import { 
  LogOut, 
  Download, 
  Upload, 
  Search, 
  Filter, 
  Users, 
  Shield, 
  ShieldOff
} from 'lucide-react'
import 'react-datepicker/dist/react-datepicker.css'

const Dashboard = () => {
  const { user, logout, isAdmin } = useAuth()
  const gridRef = useRef()
  
  const [metrics, setMetrics] = useState({ total: 0, insured: 0, not_insured: 0 })
  
  const [filters, setFilters] = useState({
    bin: '',
    bin_name: '',
    contract_number: '',
    contract_date_from: null,
    contract_date_to: null,
    date_end_from: null,
    date_end_to: null,
    obl_name: '',
    rai_name: '',
    opf_name: '',
    is_insured: '',
    expires_in_months: '',
  })
  
  const [rowData, setRowData] = useState([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 100
  
  const [uploadFile, setUploadFile] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  
  const columnDefs = [
    // Основные поля застрахованной компании
    { field: 'bin', headerName: 'БИН', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 130, pinned: 'left' },
    { field: 'bin_name', headerName: 'Название компании', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 300 },
    // Страховая компания (кто дал страховку)
    { field: 'system_delimiter_bin', headerName: 'БИН страховой компании', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 190 },
    { field: 'system_delimiter_bin_name', headerName: 'Страховая компания', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 250 },
    // Договор
    { field: 'contract_number', headerName: '№ Договора', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 150 },
    { field: 'contract_date', headerName: 'Дата договора', sortable: true, filter: 'agDateColumnFilter', floatingFilter: true, width: 150 },
    { field: 'date_beg', headerName: 'Дата начала', sortable: true, filter: 'agDateColumnFilter', floatingFilter: true, width: 140 },
    { field: 'date_end', headerName: 'Дата окончания', sortable: true, filter: 'agDateColumnFilter', floatingFilter: true, width: 150 },
    { field: 'rescinding_date', headerName: 'Дата расторжения', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 160 },
    // Финансы и сотрудники
    { field: 'calculated_amount', headerName: 'Сумма', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, width: 130 },
    { field: 'count_employees', headerName: 'Застрахованных', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, width: 150 },
    { field: 'total_employees_count', headerName: 'Всего сотр.', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, width: 130 },
    { field: 'kol_12mes', headerName: 'Кол-во 12 мес.', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, width: 140 },
    { field: 'fot_12mes', headerName: 'ФОТ 12 мес.', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, width: 140 },
    { field: 'esutd_akt_td', headerName: 'ESUTD акт. ТД', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, width: 140 },
    // Местоположение
    { field: 'obl_name', headerName: 'Область', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 180 },
    { field: 'rai_name', headerName: 'Район', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 180 },
    { field: 'address', headerName: 'Адрес', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 280 },
    // Контакты
    { field: 'phone', headerName: 'Телефон', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 150 },
    // Руководитель
    { 
      field: 'leader_surname', 
      headerName: 'Руководитель', 
      sortable: true, 
      filter: 'agTextColumnFilter',
      floatingFilter: true,
      width: 220,
      valueGetter: (params) => {
        if (!params.data) return ''
        const s = params.data.leader_surname || ''
        const n = params.data.leader_name || ''
        const m = params.data.leader_middlename || ''
        return `${s} ${n} ${m}`.trim()
      }
    },
    // ОПФ и деятельность
    { field: 'opf_name', headerName: 'ОПФ', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 200 },
    { field: 'id_oked', headerName: 'Код ОКЭД', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 120 },
    { field: 'name_oked', headerName: 'Вид деятельности (ОКЭД)', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 280 },
    // Доп. поля
    { field: 'ip', headerName: 'ИП', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, width: 90 },
    { field: 'tip', headerName: 'ТИП', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, width: 90 },
    { field: 'flag_head', headerName: 'Флаг', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, width: 90 },
    { 
      field: 'is_insured', 
      headerName: 'Застрахован', 
      sortable: true, 
      filter: 'agTextColumnFilter',
      floatingFilter: true,
      width: 130,
      cellRenderer: (params) => {
        if (!params.data) return ''
        return params.value ? '✅ Да' : '❌ Нет'
      }
    },
  ]

  const defaultColDef = {
    resizable: true,
    sortable: true,
    filter: true,
    floatingFilter: true,
    suppressMenu: false,
  }

  const buildFilterParams = () => {
    const params = {}
    if (filters.bin) params.bin = filters.bin
    if (filters.bin_name) params.bin_name = filters.bin_name
    if (filters.contract_number) params.contract_number = filters.contract_number
    if (filters.contract_date_from) params.contract_date_from = filters.contract_date_from.toISOString().split('T')[0]
    if (filters.contract_date_to) params.contract_date_to = filters.contract_date_to.toISOString().split('T')[0]
    if (filters.date_end_from) params.date_end_from = filters.date_end_from.toISOString().split('T')[0]
    if (filters.date_end_to) params.date_end_to = filters.date_end_to.toISOString().split('T')[0]
    if (filters.obl_name) params.obl_name = filters.obl_name
    if (filters.rai_name) params.rai_name = filters.rai_name
    if (filters.opf_name) params.opf_name = filters.opf_name
    if (filters.is_insured !== '') params.is_insured = parseInt(filters.is_insured)
    if (filters.expires_in_months) params.expires_in_months = parseInt(filters.expires_in_months)
    return params
  }

  const fetchMetrics = useCallback(async () => {
    try {
      const params = buildFilterParams()
      const response = await api.get('/api/metrics', { params })
      setMetrics(response.data)
    } catch (error) {
      console.error('Error fetching metrics:', error)
    }
  }, [filters])

  const fetchData = useCallback(async (page = 1) => {
    try {
      const params = {
        ...buildFilterParams(),
        page,
        page_size: pageSize,
      }
      const response = await api.get('/api/records', { params })
      setRowData(response.data.items)
      setTotalRecords(response.data.total)
      setCurrentPage(page)
    } catch (error) {
      toast.error('Ошибка загрузки данных')
    }
  }, [filters])

  const applyFilters = () => {
    setCurrentPage(1)
    fetchMetrics()
    fetchData(1)
  }

  const resetFilters = () => {
    setFilters({
      bin: '',
      bin_name: '',
      contract_number: '',
      contract_date_from: null,
      contract_date_to: null,
      date_end_from: null,
      date_end_to: null,
      obl_name: '',
      rai_name: '',
      opf_name: '',
      is_insured: '',
      expires_in_months: '',
    })
    setTimeout(() => {
      fetchMetrics()
      fetchData(1)
    }, 0)
  }

  const downloadExcel = async () => {
    try {
      const params = buildFilterParams()
      const response = await api.get('/api/records/download', {
        params,
        responseType: 'blob',
      })
      
      const blob = new Blob([response.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `insurance_records_${new Date().toISOString().split('T')[0]}.xlsx`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      toast.success('Файл скачан')
    } catch (error) {
      toast.error('Ошибка при скачивании')
    }
  }

  const handleUpload = async (e) => {
    e.preventDefault()
    if (!uploadFile) {
      toast.error('Выберите файл')
      return
    }

    setIsUploading(true)
    const formData = new FormData()
    formData.append('file', uploadFile)

    try {
      await api.post('/api/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      toast.success('Файл успешно загружен!')
      setUploadFile(null)
      fetchMetrics()
      fetchData(1)
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Ошибка загрузки файла')
    } finally {
      setIsUploading(false)
    }
  }

  const totalPages = Math.ceil(totalRecords / pageSize)
  
  const goToPage = (page) => {
    if (page >= 1 && page <= totalPages) {
      fetchData(page)
    }
  }

  useEffect(() => {
    fetchMetrics()
    fetchData(1)
  }, [])

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Страховка - Система учета</h1>
        <div className="user-info">
          <span>{user?.username} ({user?.role})</span>
          <button onClick={logout} className="logout-btn">
            <LogOut size={18} /> Выйти
          </button>
        </div>
      </header>

      <div className="metrics">
        <div className="metric-card">
          <Users className="metric-icon" size={32} />
          <div className="metric-info">
            <span className="metric-value">{metrics.total.toLocaleString()}</span>
            <span className="metric-label">Всего записей</span>
          </div>
        </div>
        <div className="metric-card insured">
          <Shield className="metric-icon" size={32} />
          <div className="metric-info">
            <span className="metric-value">{metrics.insured.toLocaleString()}</span>
            <span className="metric-label">Застрахованы</span>
          </div>
        </div>
        <div className="metric-card not-insured">
          <ShieldOff className="metric-icon" size={32} />
          <div className="metric-info">
            <span className="metric-value">{metrics.not_insured.toLocaleString()}</span>
            <span className="metric-label">Не застрахованы</span>
          </div>
        </div>
      </div>

      <div className="filters-section">
        <h3><Filter size={20} /> Фильтры</h3>
        <div className="filters-grid">
          <div className="filter-group">
            <label>БИН</label>
            <input
              type="text"
              placeholder="Поиск по БИН..."
              value={filters.bin}
              onChange={(e) => setFilters({ ...filters, bin: e.target.value })}
            />
          </div>
          
          <div className="filter-group">
            <label>Название компании</label>
            <input
              type="text"
              placeholder="Поиск по названию..."
              value={filters.bin_name}
              onChange={(e) => setFilters({ ...filters, bin_name: e.target.value })}
            />
          </div>
          
          <div className="filter-group">
            <label>№ Договора</label>
            <input
              type="text"
              placeholder="Номер договора..."
              value={filters.contract_number}
              onChange={(e) => setFilters({ ...filters, contract_number: e.target.value })}
            />
          </div>
          
          <div className="filter-group">
            <label>Область</label>
            <input
              type="text"
              placeholder="Область..."
              value={filters.obl_name}
              onChange={(e) => setFilters({ ...filters, obl_name: e.target.value })}
            />
          </div>
          
          <div className="filter-group">
            <label>Статус</label>
            <select
              value={filters.is_insured}
              onChange={(e) => setFilters({ ...filters, is_insured: e.target.value })}
            >
              <option value="">Все</option>
              <option value="1">Застрахованы</option>
              <option value="0">Не застрахованы</option>
            </select>
          </div>
          
          <div className="filter-group">
            <label>Истекает через (месяцев)</label>
            <select
              value={filters.expires_in_months}
              onChange={(e) => setFilters({ ...filters, expires_in_months: e.target.value })}
            >
              <option value="">Все</option>
              <option value="1">1 месяц</option>
              <option value="3">3 месяца</option>
              <option value="6">6 месяцев</option>
            </select>
          </div>

          <div className="filter-group date-range">
            <label>Дата договора</label>
            <div className="date-inputs">
              <DatePicker
                selected={filters.contract_date_from}
                onChange={(date) => setFilters({ ...filters, contract_date_from: date })}
                placeholderText="С"
                dateFormat="dd.MM.yyyy"
              />
              <DatePicker
                selected={filters.contract_date_to}
                onChange={(date) => setFilters({ ...filters, contract_date_to: date })}
                placeholderText="По"
                dateFormat="dd.MM.yyyy"
              />
            </div>
          </div>

          <div className="filter-group date-range">
            <label>Дата окончания</label>
            <div className="date-inputs">
              <DatePicker
                selected={filters.date_end_from}
                onChange={(date) => setFilters({ ...filters, date_end_from: date })}
                placeholderText="С"
                dateFormat="dd.MM.yyyy"
              />
              <DatePicker
                selected={filters.date_end_to}
                onChange={(date) => setFilters({ ...filters, date_end_to: date })}
                placeholderText="По"
                dateFormat="dd.MM.yyyy"
              />
            </div>
          </div>
        </div>

        <div className="filter-actions">
          <button onClick={applyFilters} className="apply-btn">
            <Search size={18} /> Применить фильтры
          </button>
          <button onClick={resetFilters} className="reset-btn">
            Сбросить
          </button>
          <button onClick={downloadExcel} className="download-btn">
            <Download size={18} /> Скачать Excel
          </button>
        </div>
      </div>

      {isAdmin() && (
        <div className="upload-section">
          <h3><Upload size={20} /> Загрузка нового файла (Admin)</h3>
          <form onSubmit={handleUpload} className="upload-form">
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => setUploadFile(e.target.files[0])}
            />
            <button type="submit" disabled={isUploading}>
              {isUploading ? 'Загрузка...' : 'Загрузить Excel'}
            </button>
          </form>
        </div>
      )}

      <div className="table-section">
        <div className="table-header">
          <span>Всего: {totalRecords.toLocaleString()} записей</span>
          <div className="pagination">
            <button 
              onClick={() => goToPage(currentPage - 1)} 
              disabled={currentPage === 1}
            >
              ← Назад
            </button>
            <span>Страница {currentPage} из {totalPages}</span>
            <button 
              onClick={() => goToPage(currentPage + 1)} 
              disabled={currentPage === totalPages}
            >
              Вперед →
            </button>
          </div>
        </div>
        
        <div className="ag-theme-alpine" style={{ height: 650, width: '100%' }}>
          <AgGridReact
            ref={gridRef}
            rowData={rowData}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            pagination={false}
            domLayout="normal"
            enableCellTextSelection={true}
            suppressClipboard={false}
            floatingFiltersHeight={40}
          />
        </div>

        <div className="pagination-bottom">
          <button 
            onClick={() => goToPage(currentPage - 1)} 
            disabled={currentPage === 1}
          >
            ← Назад
          </button>
          <span>Страница {currentPage} из {totalPages}</span>
          <button 
            onClick={() => goToPage(currentPage + 1)} 
            disabled={currentPage === totalPages}
          >
            Вперед →
          </button>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
