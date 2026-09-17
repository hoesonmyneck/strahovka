import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { AgGridReact } from 'ag-grid-react'
import api from '../utils/api.js'
import { toast } from 'react-toastify'
import { Search, Filter, Download } from 'lucide-react'
import SuggestInput from './SuggestInput.jsx'

// Форматирование числа с пробелами: 1000000 → "1 000 000"
const fmtNumber = (v, decimals = 0) => {
  if (v == null || v === '') return ''
  return Number(v).toLocaleString('ru-RU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

const EMPTY = {
  region: '', bin: '', gender: '', oked_name_low: '',
}

// ─── Раздел «Пенсионные взносы работников» (ОПВР) ────────────────────────────
const OppvSection = () => {
  const gridRef = useRef()
  const [filters, setFilters] = useState(EMPTY)
  const [rowData, setRowData] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [isLoading, setIsLoading] = useState(false)
  const [regions, setRegions] = useState([])
  const sortRef = useRef({ sort_by: 'id', sort_order: 'asc' })
  const pageSize = 100

  const columnDefs = useMemo(() => [
    { field: 'region', headerName: 'Регион', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 160, pinned: 'left' },
    { field: 'bin', headerName: 'БИН', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, width: 150, pinned: 'left' },
    { field: 'oked_code_low', headerName: 'Код ОКЭД', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 150 },
    { field: 'oked_name_low', headerName: 'ОКЭД', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 300 },
    { field: 'age', headerName: 'Возраст', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 110 },
    { field: 'gender', headerName: 'Пол', sortable: true, filter: 'agTextColumnFilter', floatingFilter: true, minWidth: 110 },
    { field: 'experience', headerName: 'Стаж', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 100 },
    { field: 'count', headerName: 'Количество сотрудников', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 150 },
    { field: 'fot', headerName: 'ФОТ', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 150, valueFormatter: (p) => fmtNumber(p.value, 0) },
    { field: 'smz', headerName: 'СМЗ', sortable: true, filter: 'agNumberColumnFilter', floatingFilter: true, minWidth: 150, valueFormatter: (p) => fmtNumber(p.value, 0) },
  ], [])

  const defaultColDef = useMemo(() => ({
    resizable: true, sortable: true, filter: true, floatingFilter: true,
    suppressMenu: false, wrapHeaderText: true, autoHeaderHeight: true,
  }), [])

  // Параметры фильтра: верхняя панель + floating-фильтры колонок AG Grid
  const buildParams = useCallback(() => {
    const params = {}
    Object.keys(EMPTY).forEach((k) => { if (filters[k]) params[k] = filters[k] })
    if (gridRef.current?.api) {
      const model = gridRef.current.api.getFilterModel()
      Object.keys(EMPTY).forEach((f) => {
        if (model[f]?.filter && !params[f]) params[f] = model[f].filter
      })
    }
    return params
  }, [filters])

  // Модель фильтров AG Grid на момент последнего запроса — чтобы отличать
  // реальное изменение фильтра от события после обновления rowData.
  const lastFilterModelRef = useRef('')

  const fetchData = useCallback(async (toPage = 1, override) => {
    setIsLoading(true)
    try {
      const base = override ?? buildParams()
      const params = { ...base, page: toPage, page_size: pageSize, ...sortRef.current }
      lastFilterModelRef.current = JSON.stringify(gridRef.current?.api?.getFilterModel() || {})
      const res = await api.get('/api/oppv', { params })
      setRowData(res.data.items)
      setTotal(res.data.total)
      setPage(toPage)
    } catch {
      toast.error('Ошибка загрузки данных ОПВР')
    } finally {
      setIsLoading(false)
    }
  }, [buildParams])

  const fetchDataRef = useRef(fetchData)
  useEffect(() => { fetchDataRef.current = fetchData }, [fetchData])

  useEffect(() => {
    fetchData(1)
    api.get('/api/oppv/regions').then(r => setRegions(r.data)).catch(() => {})
  }, [])

  const onSortChanged = useCallback(() => {
    const cols = gridRef.current?.api?.getColumnState?.() || []
    const sorted = cols.filter(c => c.sort).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))[0]
    sortRef.current = sorted
      ? { sort_by: sorted.colId, sort_order: sorted.sort }
      : { sort_by: 'id', sort_order: 'asc' }
    fetchDataRef.current(1)
  }, [])

  // Debounce для floating-фильтров колонок
  const filterTimer = useRef(null)
  const onFilterChanged = useCallback(() => {
    const model = JSON.stringify(gridRef.current?.api?.getFilterModel() || {})
    if (model === lastFilterModelRef.current) return
    clearTimeout(filterTimer.current)
    filterTimer.current = setTimeout(() => fetchDataRef.current(1), 600)
  }, [])

  const resetFilters = () => {
    if (gridRef.current?.api) gridRef.current.api.setFilterModel(null)
    setFilters(EMPTY)
    setTimeout(() => fetchData(1, {}), 0)
  }

  const downloadExcel = async () => {
    try {
      const params = buildParams()
      const res = await api.get('/api/oppv/download', { params, responseType: 'blob' })
      const url = window.URL.createObjectURL(new Blob([res.data]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `oppv_${new Date().toISOString().split('T')[0]}.xlsx`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      toast.success('Файл скачан')
    } catch {
      toast.error('Ошибка при скачивании')
    }
  }

  const totalPages = Math.ceil(total / pageSize) || 1
  const goToPage = (p) => { if (p >= 1 && p <= totalPages) fetchData(p) }

  return (
    <div className="oppv-section">
      <div className="filters-section">
        <h3><Filter size={20} /> Фильтры</h3>
        <div className="filters-grid">
          <div className="filter-group">
            <label>Регион</label>
            <select value={filters.region} onChange={(e) => setFilters({ ...filters, region: e.target.value })}>
              <option value="">Все регионы</option>
              {regions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="filter-group">
            <label>БИН</label>
            <input type="text" value={filters.bin} placeholder="Поиск по БИН..."
              onChange={(e) => setFilters({ ...filters, bin: e.target.value })} />
          </div>
          <div className="filter-group">
            <label>Пол</label>
            <select value={filters.gender} onChange={(e) => setFilters({ ...filters, gender: e.target.value })}>
              <option value="">Все</option>
              <option value="Мужской">Мужской</option>
              <option value="Женский">Женский</option>
            </select>
          </div>

          {/* Справочник ОКЭД (по нижнему уровню, отображается как «ОКЭД») */}
          <div className="filter-group filter-group--half">
            <label>ОКЭД</label>
            <SuggestInput
              endpoint="/api/oppv/suggestions"
              field="oked_name_low"
              value={filters.oked_name_low}
              onChange={(v) => setFilters({ ...filters, oked_name_low: v })}
              placeholder="Выберите или введите..."
              openOnFocus
            />
          </div>
        </div>

        <div className="filter-actions">
          <button onClick={() => fetchData(1)} className="apply-btn">
            <Search size={18} /> Применить фильтры
          </button>
          <button onClick={resetFilters} className="reset-btn">Сбросить</button>
          <button onClick={downloadExcel} className="download-btn">
            <Download size={18} /> Скачать Excel
          </button>
        </div>
      </div>

      <div className="table-section">
        {isLoading && (
          <div className="loading-bar"><div className="loading-bar-inner" /></div>
        )}
        <div className="table-header">
          <span>Всего: {total.toLocaleString()} записей</span>
          <div className="pagination">
            <button onClick={() => goToPage(page - 1)} disabled={page === 1}>← Назад</button>
            <span>Страница {page} из {totalPages}</span>
            <button onClick={() => goToPage(page + 1)} disabled={page === totalPages}>Вперед →</button>
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
            onSortChanged={onSortChanged}
            onFilterChanged={onFilterChanged}
          />
        </div>

        <div className="pagination-bottom">
          <button onClick={() => goToPage(page - 1)} disabled={page === 1}>← Назад</button>
          <span>Страница {page} из {totalPages}</span>
          <button onClick={() => goToPage(page + 1)} disabled={page === totalPages}>Вперед →</button>
        </div>
      </div>
    </div>
  )
}

export default OppvSection
