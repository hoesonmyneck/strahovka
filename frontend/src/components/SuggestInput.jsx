import React, { useState, useEffect, useRef } from 'react'
import api from '../utils/api.js'

// Поле с автодополнением / справочник.
//  - endpoint: откуда брать значения (по умолчанию /api/suggestions)
//  - openOnFocus: показывать список сразу при клике (режим «справочник»)
const SuggestInput = ({ field, value, onChange, placeholder, endpoint = '/api/suggestions', openOnFocus = false }) => {
  const [inputValue, setInputValue] = useState(value)
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const timer = useRef(null)

  // Синхронизируем с родителем только когда он сбрасывает значение (сброс фильтров)
  useEffect(() => { if (value === '') setInputValue('') }, [value])

  const fetchSuggestions = async (q) => {
    try {
      const res = await api.get(endpoint, { params: { field, query: q, limit: openOnFocus ? 20 : 10 } })
      setSuggestions(res.data)
      setOpen(res.data.length > 0)
    } catch {
      setSuggestions([])
    }
  }

  const handleChange = (e) => {
    const v = e.target.value
    setInputValue(v)
    onChange(v)
    clearTimeout(timer.current)
    if (v.length >= 1 || openOnFocus) {
      timer.current = setTimeout(() => fetchSuggestions(v), 300)
    } else {
      setSuggestions([])
      setOpen(false)
    }
  }

  const handleFocus = () => {
    if (suggestions.length > 0) {
      setOpen(true)
    } else if (openOnFocus || inputValue.length >= 1) {
      fetchSuggestions(inputValue || '')
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
        onFocus={handleFocus}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <div className="suggestions-dropdown">
          {suggestions.map((s, i) => (
            <div key={i} className="suggestion-item" title={s} onMouseDown={() => selectSuggestion(s)}>
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default SuggestInput
