import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { toast } from 'react-toastify'
import { Lock, User } from 'lucide-react'

const Login = () => {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      await login(username, password)
      toast.success('Успешный вход!')
      // Плавный уход формы, затем переход в приложение (страница перезагрузится)
      setLeaving(true)
      setTimeout(() => { window.location.href = '/dashboard' }, 500)
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Ошибка входа')
      setIsLoading(false)
    }
  }

  return (
    <div className={`login-container${leaving ? ' leaving' : ''}`}>
      <div className="login-box">
        <h1>Государственная компания по страхованию жизни</h1>
        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <User className="input-icon" size={20} />
            <input
              type="text"
              placeholder="Логин"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="input-group">
            <Lock className="input-icon" size={20} />
            <input
              type="password"
              placeholder="Пароль"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" disabled={isLoading}>
            {isLoading ? <><span className="spinner"></span>Загружаем…</> : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default Login
