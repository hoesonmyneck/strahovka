import React, { createContext, useState, useContext, useEffect } from 'react'
import api from '../utils/api.js'

const AuthContext = createContext(null)

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (token) {
      api.defaults.headers.common['Authorization'] = `Bearer ${token}`
      fetchUser()
    } else {
      setLoading(false)
    }
  }, [])

  const fetchUser = async () => {
    try {
      const response = await api.get('/api/auth/me')
      setUser(response.data)
    } catch (error) {
      logout()
    } finally {
      setLoading(false)
    }
  }

  const applyToken = async (access_token) => {
    localStorage.setItem('token', access_token)
    api.defaults.headers.common['Authorization'] = `Bearer ${access_token}`
    await fetchUser()
  }

  // Шаг 1: логин/пароль. Возвращает {requires2fa:true, challenge} для аккаунтов
  // с ЭЦП, либо {requires2fa:false} когда токен уже получен (вход по паролю).
  const login = async (username, password) => {
    const formData = new URLSearchParams()
    formData.append('username', username)
    formData.append('password', password)

    const { data } = await api.post('/api/auth/login', formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })

    if (data.requires_2fa) {
      return { requires2fa: true, challenge: data.challenge }
    }
    await applyToken(data.access_token)
    return { requires2fa: false }
  }

  // Шаг 2: подпись challenge через ЭЦП уже получена — меняем её на токен.
  const loginWith2fa = async (challenge, signature) => {
    const { data } = await api.post('/api/auth/login-2fa', { challenge, signature })
    await applyToken(data.access_token)
    return true
  }

  const logout = () => {
    localStorage.removeItem('token')
    delete api.defaults.headers.common['Authorization']
    setUser(null)
  }

  const isAdmin = () => {
    return user?.role === 'admin'
  }

  const isManager = () => {
    return user?.role === 'manager'
  }

  const isDkgit = () => {
    return user?.role === 'dkgit'
  }

  // Демонстрационный аккаунт: один логин, два «вида» — от лица ГАК и от лица
  // ДКГИТ. Сервер отдаёт роль выбранного вида (user / dkgit), поэтому весь
  // интерфейс перестраивается сам; здесь только переключение.
  const isDemo = () => !!user?.is_demo
  const setDemoView = async (view) => {
    localStorage.setItem('demoView', view === 'dkgit' ? 'dkgit' : 'gak')
    await fetchUser()
  }

  return (
    <AuthContext.Provider value={{ user, login, loginWith2fa, logout, isAdmin, isManager, isDkgit, isDemo, setDemoView, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
