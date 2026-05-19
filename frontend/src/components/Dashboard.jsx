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

// ─── Вспомогательные функции ─────────────────────────────────────────────────
const MONTHS_RU_PREP = [
  'январе','феврале','марте','апреле','мае','июне',
  'июле','августе','сентябре','октябре','ноябре','декабре'
]

// Возвращает {label, date_end_from, date_end_to} для месяца +offset от текущего
const getMonthOption = (offset) => {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + offset          // 0-based month + offset
  const absYear = y + Math.floor(m / 12)
  const absMon  = ((m % 12) + 12) % 12      // нормализуем в [0..11]
  const from = new Date(absYear, absMon, 1)
  const to   = new Date(absYear, absMon + 1, 0) // последний день месяца
  const fmt  = (d) => d.toISOString().split('T')[0]
  return {
    label: `Истекает в ${MONTHS_RU_PREP[absMon]}`,
    value: fmt(from),                        // храним как "YYYY-MM-01"
    date_end_from: fmt(from),
    date_end_to:   fmt(to),
  }
}

// Форматирование числа с пробелами: 1000000 → "1 000 000"
const fmtNumber = (v, decimals = 0) => {
  if (v == null || v === '') return ''
  return Number(v).toLocaleString('ru-RU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

// ─── Компонент поля с автодополнением ────────────────────────────────────────
const SuggestInput = ({ field, value, onChange, placeholder }) => {
  // Локальный state чтобы input не сбрасывался при ре-рендере родителя
  const [inputValue, setInputValue] = useState(value)
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const timer = useRef(null)

  // Синхронизируем с родителем только когда родитель сбрасывает значение (сброс фильтров)
  useEffect(() => {
    if (value === '') setInputValue('')
  }, [value])

  const handleChange = (e) => {
    const v = e.target.value
    setInputValue(v)   // немедленно обновляем локальный state
    onChange(v)        // уведомляем родителя
    clearTimeout(timer.current)
    if (v.length >= 1) {
      timer.current = setTimeout(async () => {
        try {
          const res = await api.get('/api/suggestions', { params: { field, query: v, limit: 10 } })
          setSuggestions(res.data)
          setOpen(res.data.length > 0)
        } catch {
          setSuggestions([])
        }
      }, 300)
    } else {
      setSuggestions([])
      setOpen(false)
    }
  }

  const selectSuggestion = (s) => {
    setInputValue(s)
    onChange(s)
    setOpen(false)
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        value={inputValue}
        onChange={handleChange}
        placeholder={placeholder}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <div className="suggestions-dropdown">
          {suggestions.map((s, i) => (
            <div key={i} className="suggestion-item" onMouseDown={() => selectSuggestion(s)}>
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Форматтер БИН с ведущими нулями (12 цифр) ───────────────────────────────
const binFormatter = (params) => {
  if (params.value == null || params.value === '') return ''
  return String(params.value).padStart(12, '0')
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
const Dashboard = () => {
  const { user, logout, isAdmin } = useAuth()
  const gridRef = useRef()

  const [metrics, setMetrics] = useState({ total: 0, insured: 0, not_insured: 0 })

  const EMPTY_FILTERS = {
    bin: '', bin_name: '', system_delimiter_bin: '', system_delimiter_bin_name: '',
    contract_number: '', contract_date_from: null, contract_date_to: null,
    date_end_from: null, date_end_to: null,
    obl_name: '', rai_name: '', opf_name: '', is_insured: '',
    // Срок истечения — конкретный месяц (date_end_from/to считаем отдельно)
    expires_month: '',   // хранит date_end_from первого дня выбранного месяца
    expires_month_to: '', // хранит date_end_to последнего дня выбранного месяца
  }

  const [filters, setFilters] = useState(EMPTY_FILTERS)

  // Опции дропдауна "истекает в ..."  (текущий + следующие 2 месяца)
  const expiryOptions = [getMonthOption(0), getMonthOption(1), getMonthOption(2)]

  const [rowData, setRowData] = useState([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 100

  const [uploadFile, setUploadFile] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  // ─── Колонки ──────────────────────────────────────────────────────────────
  const columnDefs = [
    // Закреплённые слева
    {
      field: 'bin',
      headerName: 'БИН',
      sortable: true, filter: 'agTextColumnFilter', floatingFilter: true,
      width: 150, pinned: 'left',
      valueFormatter: binFormatter,
    },
    {
      field: 'bin_name',
      headerName: 'Название компании',
      sortable: true, filter: 'agTextColumnFilter', floatingFilter: true,
      minWidth: 250,
    },
    // Страховая компания
    {
      field: 'system_delimiter_bin',
      headerName: 'БИН страховой компании',
      sortable: true, filter: 'agTextColumnFilter', floatingFilter: true,
      width: 200,
      valueFormatter: binFormatter,
    },
    {
      field: 'system_delimiter_bin_name',
      headerName: 'Страховая компания',
      sortable: true, filter: 'agTextColumnFilter', floatingFilter: true,
      minWidth: 220,
    },
    // Договор
    {
      field: 'contract_number',
      headerName: '№ Договора',
      sortable: true, filter: 'agTextColumnFilter', floatingFilter: true,
      minWidth: 150,
    },
    // Даты — скрыты в таблице, только в Excel
    { field: 'contract_date', headerName: 'Дата договора', hide: true },
    { field: 'date_beg', headerName: 'Дата начала', hide: true },
    { field: 'date_end', headerName: 'Дата окончания', hide: true },
    { field: 'rescinding_date', headerName: 'Дата расторжения', hide: true },
    // Финансы и сотрудники
    {
      field: 'calculated_amount',
      headerName: 'Сумма',
      sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true,
      minWidth: 140,
      valueFormatter: (p) => fmtNumber(p.value, 0),
    },
    { field: 'count_employees', headerName: 'Застрахованных', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 150 },
    { field: 'total_employees_count', headerName: 'Всего сотр.', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 130 },
    { field: 'kol_12mes', headerName: 'Кол-во 12 мес.', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 150 },
    { field: 'fot_12mes', headerName: 'ФОТ 12 мес.', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 140 },
    { field: 'esutd_akt_td', headerName: 'ESUTD акт. ТД', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 145 },
    // Местоположение
    { field: 'obl_name', headerName: 'Область', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 180 },
    { field: 'rai_name', headerName: 'Район', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 180 },
    { field: 'address', headerName: 'Адрес', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 280 },
    // Контакты
    { field: 'phone', headerName: 'Телефон', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 150 },
    // Руководитель
    {
      field: 'leader_surname',
      headerName: 'Руководитель',
      sortable: true, filter: 'agTextColumnFilter', floatingFilter: true,
      minWidth: 220,
      valueGetter: (params) => {
        if (!params.data) return ''
        return `${params.data.leader_surname || ''} ${params.data.leader_name || ''} ${params.data.leader_middlename || ''}`.trim()
      },
    },
    // ОПФ и деятельность
    { field: 'opf_name', headerName: 'ОПФ', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 200 },
    { field: 'id_oked', headerName: 'Код ОКЭД', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 120 },
    { field: 'name_oked', headerName: 'Вид деятельности (ОКЭД)', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 280 },
    // Доп. поля
    { field: 'ip', headerName: 'ИП', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 90 },
    { field: 'tip', headerName: 'ТИП', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 90 },
    { field: 'flag_head', headerName: 'Флаг', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 90 },
    {
      field: 'is_insured',
      headerName: 'Застрахован',
      sortable: true, filter: 'agTextColumnFilter', floatingFilter: true,
      minWidth: 130,
      cellRenderer: (params) => {
        if (!params.data) return ''
        return params.value ? '✅ Да' : '❌ Нет'
      },
    },
  ]

  const defaultColDef = {
    resizable: true,
    sortable: true,
    filter: true,
    floatingFilter: true,
    suppressMenu: false,
    wrapHeaderText: true,
    autoHeaderHeight: true,
  }

  // ─── Сбор параметров фильтра (топ-панель + фильтры в колонках AG Grid) ────
  const buildFilterParams = useCallback(() => {
    const params = {}
    if (filters.bin) params.bin = filters.bin
    if (filters.bin_name) params.bin_name = filters.bin_name
    if (filters.system_delimiter_bin) params.system_delimiter_bin = filters.system_delimiter_bin
    if (filters.system_delimiter_bin_name) params.system_delimiter_bin_name = filters.system_delimiter_bin_name
    if (filters.contract_number) params.contract_number = filters.contract_number
    if (filters.contract_date_from) params.contract_date_from = filters.contract_date_from.toISOString().split('T')[0]
    if (filters.contract_date_to) params.contract_date_to = filters.contract_date_to.toISOString().split('T')[0]
    if (filters.date_end_from) params.date_end_from = filters.date_end_from.toISOString().split('T')[0]
    if (filters.date_end_to) params.date_end_to = filters.date_end_to.toISOString().split('T')[0]
    if (filters.obl_name) params.obl_name = filters.obl_name
    if (filters.rai_name) params.rai_name = filters.rai_name
    if (filters.opf_name) params.opf_name = filters.opf_name
    if (filters.is_insured !== '') params.is_insured = parseInt(filters.is_insured)
    // Фильтр по конкретному месяцу истечения (перекрывает date_end_from/to если заданы)
    if (filters.expires_month) {
      params.date_end_from = filters.expires_month
      params.date_end_to   = filters.expires_month_to
    }

    // Добавляем фильтры из колонок AG Grid (чтобы скачивание тоже их учитывало)
    if (gridRef.current?.api) {
      const model = gridRef.current.api.getFilterModel()
      const textFields = [
        'bin', 'bin_name', 'system_delimiter_bin', 'system_delimiter_bin_name',
        'contract_number', 'obl_name', 'rai_name', 'address', 'phone',
        'leader_surname', 'opf_name', 'id_oked', 'name_oked',
      ]
      textFields.forEach((f) => {
        if (model[f]?.filter && !params[f]) {
          params[f] = model[f].filter
        }
      })
    }

    return params
  }, [filters])

  // При изменении фильтра в колонке — делаем серверный запрос
  const handleGridFilterChanged = useCallback(() => {
    if (!gridRef.current?.api) return
    setCurrentPage(1)
    // Небольшая задержка чтобы пользователь мог дописать
    clearTimeout(handleGridFilterChanged._timer)
    handleGridFilterChanged._timer = setTimeout(() => {
      fetchDataRef.current(1)
    }, 400)
  }, [])

  const fetchMetrics = useCallback(async (overrideParams) => {
    try {
      const params = overrideParams ?? buildFilterParams()
      const response = await api.get('/api/metrics', { params })
      setMetrics(response.data)
    } catch (error) {
      console.error('Error fetching metrics:', error)
    }
  }, [buildFilterParams])

  const fetchData = useCallback(async (page = 1, overrideParams) => {
    try {
      const base = overrideParams ?? buildFilterParams()
      const params = { ...base, page, page_size: pageSize }
      const response = await api.get('/api/records', { params })
      setRowData(response.data.items)
      setTotalRecords(response.data.total)
      setCurrentPage(page)
    } catch (error) {
      toast.error('Ошибка загрузки данных')
    }
  }, [buildFilterParams])

  // Параллельная загрузка метрик и данных
  const fetchAll = useCallback(async (page = 1) => {
    setIsLoading(true)
    try {
      const filterParams = buildFilterParams()
      await Promise.all([
        fetchMetrics(filterParams),
        fetchData(page, filterParams),
      ])
    } finally {
      setIsLoading(false)
    }
  }, [buildFilterParams, fetchMetrics, fetchData])

  // Ref чтобы handleGridFilterChanged мог вызывать свежую версию fetchAll
  const fetchDataRef = useRef(fetchAll)
  useEffect(() => { fetchDataRef.current = fetchAll }, [fetchAll])

  const applyFilters = () => {
    setCurrentPage(1)
    fetchAll(1)
  }

  const resetFilters = () => {
    if (gridRef.current?.api) gridRef.current.api.setFilterModel(null)
    setFilters(EMPTY_FILTERS)
    setTimeout(() => fetchAll(1), 0)
  }

  const downloadExcel = async () => {
    try {
      const params = buildFilterParams()
      const response = await api.get('/api/records/download', { params, responseType: 'blob' })
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `insurance_records_${new Date().toISOString().split('T')[0]}.xlsx`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      toast.success('Файл скачан')
    } catch {
      toast.error('Ошибка при скачивании')
    }
  }

  const handleUpload = async (e) => {
    e.preventDefault()
    if (!uploadFile) { toast.error('Выберите файл'); return }
    setIsUploading(true)
    const formData = new FormData()
    formData.append('file', uploadFile)
    try {
      await api.post('/api/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } })
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
  const goToPage = (page) => { if (page >= 1 && page <= totalPages) fetchAll(page) }

  useEffect(() => {
    fetchAll(1)
  }, [])

  // Авто-ширина колонок после загрузки данных
  const onFirstDataRendered = useCallback((params) => {
    params.api.autoSizeAllColumns(false)
  }, [])

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Государственная компания по страхованию жизни</h1>
        <div className="user-info">
          <span>{user?.username} ({user?.role})</span>
          <button onClick={logout} className="logout-btn">
            <LogOut size={18} /> Выйти
          </button>
        </div>
      </header>

      {/* Метрики */}
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

      {/* Фильтры */}
      <div className="filters-section">
        <h3><Filter size={20} /> Фильтры</h3>
        <div className="filters-grid">

          <div className="filter-group">
            <label>БИН</label>
            <SuggestInput
              field="bin"
              value={filters.bin}
              onChange={(v) => setFilters({ ...filters, bin: v })}
              placeholder="Поиск по БИН..."
            />
          </div>

          <div className="filter-group">
            <label>Название компании</label>
            <SuggestInput
              field="bin_name"
              value={filters.bin_name}
              onChange={(v) => setFilters({ ...filters, bin_name: v })}
              placeholder="Поиск по названию..."
            />
          </div>

          <div className="filter-group">
            <label>БИН страховой компании</label>
            <SuggestInput
              field="system_delimiter_bin"
              value={filters.system_delimiter_bin}
              onChange={(v) => setFilters({ ...filters, system_delimiter_bin: v })}
              placeholder="БИН страховой..."
            />
          </div>

          <div className="filter-group">
            <label>Страховая компания</label>
            <SuggestInput
              field="system_delimiter_bin_name"
              value={filters.system_delimiter_bin_name}
              onChange={(v) => setFilters({ ...filters, system_delimiter_bin_name: v })}
              placeholder="Название страховой..."
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
            <label>Срок истечения</label>
            <select
              value={filters.expires_month}
              onChange={(e) => {
                const opt = expiryOptions.find(o => o.value === e.target.value)
                setFilters({
                  ...filters,
                  expires_month:    opt ? opt.date_end_from : '',
                  expires_month_to: opt ? opt.date_end_to   : '',
                })
              }}
            >
              <option value="">Все</option>
              {expiryOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
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

      {/* Загрузка (только admin) */}
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

      {/* Таблица */}
      <div className="table-section">
        {isLoading && (
          <div className="loading-bar">
            <div className="loading-bar-inner" />
          </div>
        )}
        <div className="table-header">
          <span>Всего: {totalRecords.toLocaleString()} записей</span>
          <div className="pagination">
            <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1}>← Назад</button>
            <span>Страница {currentPage} из {totalPages}</span>
            <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage === totalPages}>Вперед →</button>
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
            onFirstDataRendered={onFirstDataRendered}
            onFilterChanged={handleGridFilterChanged}
          />
        </div>

        <div className="pagination-bottom">
          <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1}>← Назад</button>
          <span>Страница {currentPage} из {totalPages}</span>
          <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage === totalPages}>Вперед →</button>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
