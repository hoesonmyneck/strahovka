import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
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

  // Все 12 месяцев начиная с текущего
  const expiryOptions = Array.from({ length: 12 }, (_, i) => getMonthOption(i))

  const [rowData, setRowData] = useState([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 100

  const [uploadFile, setUploadFile] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [editingDate, setEditingDate] = useState(false)
  const [dateInput, setDateInput] = useState('')

  // ─── Регионы / районы ─────────────────────────────────────────────────────
  const [availableRegions, setAvailableRegions] = useState([])
  const [availableDistricts, setAvailableDistricts] = useState([])

  // ─── Управление пользователями (только admin) ─────────────────────────────
  const [usersList, setUsersList] = useState([])
  const [showUserMgmt, setShowUserMgmt] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', region: '' })
  const [userMgmtMsg, setUserMgmtMsg] = useState('')

  // ─── Колонки (useMemo чтобы AG Grid не сбрасывал фильтры при ре-рендере) ──
  const columnDefs = useMemo(() => [
    // Закреплённые слева
    {
      field: 'bin',
      headerName: 'БИН',
      sortable: true, filter: 'agTextColumnFilter', floatingFilter: true,
      width: 150, pinned: 'left',
      valueFormatter: binFormatter,
      // filterValueGetter позволяет AG Grid искать по строке с нулями
      filterValueGetter: (p) => p.data?.bin != null ? String(p.data.bin).padStart(12, '0') : '',
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
      filterValueGetter: (p) => p.data?.system_delimiter_bin != null ? String(p.data.system_delimiter_bin).padStart(12, '0') : '',
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
    // Даты
    { field: 'contract_date', headerName: 'Дата договора', sortable: true, filter: 'agDateColumnFilter', floatingFilter: true, minWidth: 150 },
    { field: 'date_beg', headerName: 'Дата начала', sortable: true, filter: 'agDateColumnFilter', floatingFilter: true, minWidth: 140 },
    { field: 'date_end', headerName: 'Дата окончания', sortable: true, filter: 'agDateColumnFilter', floatingFilter: true, minWidth: 150 },
    { field: 'rescinding_date', headerName: 'Дата расторжения', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 160 },
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
    // ТИП и Флаг скрыты в таблице, но экспортируются в Excel
    { field: 'tip', headerName: 'ТИП', hide: true },
    { field: 'flag_head', headerName: 'Флаг', hide: true },
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
  ], [])  // useMemo — колонки не пересоздаются при ре-рендере

  const defaultColDef = useMemo(() => ({
    resizable: true,
    sortable: true,
    filter: true,
    floatingFilter: true,
    suppressMenu: false,
    wrapHeaderText: true,
    autoHeaderHeight: true,
  }), [])

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

  // Фильтры в колонках AG Grid работают клиентски на текущей странице.
  // При скачивании Excel buildFilterParams() читает их и передаёт на сервер.

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

  // Запоминаем модель фильтра с которой делали последний запрос.
  // Если AG Grid вызывает onFilterChanged после setRowData — модель та же → пропускаем.
  const lastFetchedFilterModelRef = useRef('')

  // Параллельная загрузка метрик и данных
  const fetchAll = useCallback(async (page = 1) => {
    setIsLoading(true)
    try {
      const filterParams = buildFilterParams()
      // Фиксируем текущую модель фильтров AG Grid до начала запроса
      lastFetchedFilterModelRef.current = JSON.stringify(
        gridRef.current?.api?.getFilterModel() || {}
      )
      await Promise.all([
        fetchMetrics(filterParams),
        fetchData(page, filterParams),
      ])
    } finally {
      setIsLoading(false)
    }
  }, [buildFilterParams, fetchMetrics, fetchData])

  const fetchDataRef = useRef(fetchAll)
  useEffect(() => { fetchDataRef.current = fetchAll }, [fetchAll])

  // Debounce-таймер для фильтров в заголовках столбцов AG Grid
  const filterChangeTimer = useRef(null)
  const onAgGridFilterChanged = useCallback(() => {
    const currentModel = JSON.stringify(gridRef.current?.api?.getFilterModel() || {})
    // Если модель фильтра не изменилась — событие вызвано обновлением rowData, игнорируем
    if (currentModel === lastFetchedFilterModelRef.current) return
    clearTimeout(filterChangeTimer.current)
    filterChangeTimer.current = setTimeout(() => {
      fetchDataRef.current(1)
    }, 600)
  }, [])

  // ─── Дата обновления ──────────────────────────────────────────────────────
  const fetchLastUpdate = useCallback(async () => {
    try {
      const res = await api.get('/api/settings/last_update')
      setLastUpdate(res.data.last_update)
    } catch {}
  }, [])

  const saveLastUpdate = async () => {
    try {
      await api.put('/api/settings/last_update', { last_update: dateInput })
      setLastUpdate(dateInput)
      setEditingDate(false)
    } catch { toast.error('Ошибка сохранения') }
  }

  // ─── Загрузка регионов (для admin — все регионы) ──────────────────────────
  const fetchRegions = useCallback(async () => {
    try {
      const res = await api.get('/api/regions')
      setAvailableRegions(res.data)
    } catch {}
  }, [])

  // ─── Загрузка районов для выбранного региона ──────────────────────────────
  const fetchDistricts = useCallback(async (region) => {
    if (!region) { setAvailableDistricts([]); return }
    try {
      const res = await api.get('/api/districts', { params: { region } })
      setAvailableDistricts(res.data)
    } catch {}
  }, [])

  // ─── Управление пользователями ────────────────────────────────────────────
  const fetchUsers = useCallback(async () => {
    try {
      const res = await api.get('/api/users')
      setUsersList(res.data)
    } catch {}
  }, [])

  const createRegionalUser = async () => {
    if (!newUser.username || !newUser.password || !newUser.region) {
      setUserMgmtMsg('Заполните все поля')
      return
    }
    try {
      await api.post('/api/users', { ...newUser, role: 'user' })
      setNewUser({ username: '', password: '', region: '' })
      setUserMgmtMsg('Пользователь создан')
      fetchUsers()
    } catch (e) {
      setUserMgmtMsg(e.response?.data?.detail || 'Ошибка')
    }
  }

  const deleteUser = async (id) => {
    if (!window.confirm('Удалить пользователя?')) return
    try {
      await api.delete(`/api/users/${id}`)
      fetchUsers()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Ошибка удаления')
    }
  }

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
    fetchLastUpdate()
    if (isAdmin()) {
      fetchRegions()
      fetchUsers()
    } else if (user?.region) {
      // Региональный пользователь — загружаем только его районы
      fetchDistricts(user.region)
    }
  }, [])

  // Авто-ширина колонок после загрузки данных
  const onFirstDataRendered = useCallback((params) => {
    params.api.autoSizeAllColumns(false)
  }, [])

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Государственная компания по страхованию жизни</h1>
          <div className="last-update-line">
            {editingDate ? (
              <>
                <span>Дата обновления: </span>
                <input
                  type="text"
                  value={dateInput}
                  onChange={e => setDateInput(e.target.value)}
                  placeholder="дд.мм.гггг"
                  style={{ width: 110, fontSize: 13, padding: '2px 6px', borderRadius: 4, border: '1px solid #aaa' }}
                />
                <button onClick={saveLastUpdate} style={{ marginLeft: 6, fontSize: 12, padding: '2px 8px', background: '#4a6fa5', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Сохранить</button>
                <button onClick={() => setEditingDate(false)} style={{ marginLeft: 4, fontSize: 12, padding: '2px 8px', background: '#eee', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Отмена</button>
              </>
            ) : (
              <>
                <span>Дата обновления данных: <b>{lastUpdate || 'не указана'}</b></span>
                {isAdmin() && (
                  <button onClick={() => { setDateInput(lastUpdate || ''); setEditingDate(true) }} style={{ marginLeft: 8, fontSize: 12, padding: '2px 8px', background: 'transparent', border: '1px solid #aaa', borderRadius: 4, cursor: 'pointer' }}>✏️ Изменить</button>
                )}
              </>
            )}
          </div>
        </div>
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


          {/* Для admin — выбор области; для регионального пользователя — скрыто */}
          {isAdmin() && (
            <div className="filter-group">
              <label>Область</label>
              <select
                value={filters.obl_name}
                onChange={(e) => {
                  const val = e.target.value
                  setFilters({ ...filters, obl_name: val, rai_name: '' })
                  fetchDistricts(val)
                }}
              >
                <option value="">Все области</option>
                {availableRegions.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          )}

          {/* Район — для admin зависит от выбранной области, для регионального — все его районы */}
          {(isAdmin() ? filters.obl_name : user?.region) && (
            <div className="filter-group">
              <label>Район</label>
              <select
                value={filters.rai_name}
                onChange={(e) => setFilters({ ...filters, rai_name: e.target.value })}
              >
                <option value="">Все районы</option>
                {availableDistricts.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          )}

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

      {/* Управление пользователями (только admin) */}
      {isAdmin() && (
        <div className="upload-section">
          <h3
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={() => { setShowUserMgmt(v => !v); if (!showUserMgmt) fetchUsers() }}
          >
            👥 Управление региональными пользователями {showUserMgmt ? '▲' : '▼'}
          </h3>

          {showUserMgmt && (
            <div style={{ marginTop: 12 }}>
              {/* Создание нового пользователя */}
              <div className="user-create-form">
                <select
                  value={newUser.region}
                  onChange={(e) => setNewUser({ ...newUser, region: e.target.value })}
                >
                  <option value="">— Выберите регион —</option>
                  {availableRegions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <input
                  type="text"
                  placeholder="Логин (латиница)"
                  value={newUser.username}
                  onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="Пароль"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                />
                <button onClick={createRegionalUser} className="apply-btn" style={{ padding: '8px 16px' }}>
                  Создать
                </button>
                {userMgmtMsg && <span style={{ marginLeft: 8, color: userMgmtMsg.includes('создан') ? 'green' : 'red' }}>{userMgmtMsg}</span>}
              </div>

              {/* Список пользователей */}
              <table className="users-table">
                <thead>
                  <tr><th>Логин</th><th>Роль</th><th>Регион</th><th></th></tr>
                </thead>
                <tbody>
                  {usersList.map(u => (
                    <tr key={u.id}>
                      <td>{u.username}</td>
                      <td>{u.role}</td>
                      <td>{u.region || '— все регионы —'}</td>
                      <td>
                        {!['admin', 'user'].includes(u.username) && (
                          <button onClick={() => deleteUser(u.id)} className="reset-btn" style={{ padding: '4px 10px', fontSize: 12 }}>
                            Удалить
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
            onFilterChanged={onAgGridFilterChanged}
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
