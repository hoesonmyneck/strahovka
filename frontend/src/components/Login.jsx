import React, { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { toast } from 'react-toastify'
import { Lock, User, ShieldCheck, RefreshCw } from 'lucide-react'
import { signChallenge } from '../utils/ncalayer.js'
import { AUTH_LOGO_SVG } from './authLogo.js'

const Login = () => {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [leaving, setLeaving] = useState(false)
  // Этап входа: 'creds' — логин/пароль, 'eds' — подпись ЭЦП
  const [step, setStep] = useState('creds')
  const [challenge, setChallenge] = useState(null)
  const [edsStage, setEdsStage] = useState('')     // текст текущего этапа ЭЦП
  const [edsError, setEdsError] = useState('')      // ошибка подписи (с кнопкой повтора)
  const { login, loginWith2fa } = useAuth()

  const finishLogin = () => {
    toast.success('Успешный вход!')
    setLeaving(true)
    setTimeout(() => { window.location.href = '/dashboard' }, 500)
  }

  // Подпись challenge через NCALayer и обмен её на токен
  const runEds = async (ch) => {
    setEdsError('')
    setEdsStage('Подключение к NCALayer…')
    try {
      const signature = await signChallenge(ch, setEdsStage)
      await loginWith2fa(ch, signature)
      finishLogin()
    } catch (error) {
      const msg = error.response?.data?.detail || error.message || 'Ошибка входа по ЭЦП'
      setEdsError(msg)
      setEdsStage('')
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setIsLoading(true)
    try {
      const res = await login(username, password)
      if (res.requires2fa) {
        // Пароль верный — переходим к ЭЦП и сразу запускаем подпись
        setChallenge(res.challenge)
        setStep('eds')
        setIsLoading(false)
        runEds(res.challenge)
        return
      }
      finishLogin()
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Ошибка входа')
      setIsLoading(false)
    }
  }

  const backToCreds = () => {
    setStep('creds')
    setChallenge(null)
    setEdsError('')
    setEdsStage('')
  }

  return (
    <div className={`login-container${leaving ? ' leaving' : ''}`}>
      {/* Декоративный анимированный фон: «живой дашборд» со статистикой */}
      <div className="auth-bg" aria-hidden="true">
        <span className="auth-blob auth-blob--1" />
        <span className="auth-blob auth-blob--2" />

        {/* Столбчатый график — «дышащие» столбцы */}
        <div className="auth-card auth-card--bars">
          <svg viewBox="0 0 120 72">
            <line x1="0" y1="66" x2="120" y2="66" className="axis" />
            <rect x="6"  y="30" width="16" height="36" rx="3" className="bar b1" />
            <rect x="30" y="18" width="16" height="48" rx="3" className="bar b2" />
            <rect x="54" y="38" width="16" height="28" rx="3" className="bar b3" />
            <rect x="78" y="10" width="16" height="56" rx="3" className="bar b4" />
            <rect x="102" y="24" width="16" height="42" rx="3" className="bar b5" />
          </svg>
        </div>

        {/* Линейный график — линия «рисуется» и заливается */}
        <div className="auth-card auth-card--line">
          <svg viewBox="0 0 150 76">
            <polygon className="line-area" points="4,56 30,40 56,46 82,22 108,32 146,10 146,72 4,72" />
            <polyline className="line-path" fill="none" points="4,56 30,40 56,46 82,22 108,32 146,10" />
            <circle className="line-dot d1" cx="82" cy="22" r="3.5" />
            <circle className="line-dot d2" cx="146" cy="10" r="3.5" />
          </svg>
        </div>

        {/* Кольцевой индикатор — дуга наполняется */}
        <div className="auth-card auth-card--ring">
          <svg viewBox="0 0 84 84">
            <circle cx="42" cy="42" r="30" className="ring-bg" />
            <circle cx="42" cy="42" r="30" className="ring-fg" />
          </svg>
        </div>

        {/* KPI-плитка со спарклайном */}
        <div className="auth-card auth-card--kpi">
          <span className="kpi-value">98<span className="kpi-pct">%</span></span>
          <div className="kpi-spark">
            <i className="s1" /><i className="s2" /><i className="s3" /><i className="s4" /><i className="s5" /><i className="s6" />
          </div>
        </div>

        {/* Круговая диаграмма — сегменты, медленно вращается */}
        <div className="auth-card auth-card--pie">
          <svg viewBox="0 0 84 84">
            <g className="pie-rot">
              <circle cx="42" cy="42" r="30" className="pie-seg p1" />
              <circle cx="42" cy="42" r="30" className="pie-seg p2" />
              <circle cx="42" cy="42" r="30" className="pie-seg p3" />
            </g>
          </svg>
        </div>

        {/* Двойной график с областями */}
        <div className="auth-card auth-card--area">
          <svg viewBox="0 0 160 80">
            <polygon className="area2 a-back" points="4,60 34,46 64,52 94,30 124,40 156,20 156,76 4,76" />
            <polygon className="area2 a-front" points="4,68 34,58 64,62 94,50 124,56 156,42 156,76 4,76" />
            <polyline className="area2-line l-back" fill="none" points="4,60 34,46 64,52 94,30 124,40 156,20" />
            <polyline className="area2-line l-front" fill="none" points="4,68 34,58 64,62 94,50 124,56 156,42" />
          </svg>
        </div>

        {/* Горизонтальные прогресс-бары */}
        <div className="auth-card auth-card--prog">
          <div className="prog-row"><span className="prog-fill pf1" /></div>
          <div className="prog-row"><span className="prog-fill pf2" /></div>
          <div className="prog-row"><span className="prog-fill pf3" /></div>
        </div>

        {/* Полукруглый спидометр со стрелкой */}
        <div className="auth-card auth-card--gauge">
          <svg viewBox="0 0 100 60">
            <path className="gauge-bg" d="M10 54 A40 40 0 0 1 90 54" fill="none" />
            <path className="gauge-fg" d="M10 54 A40 40 0 0 1 90 54" fill="none" />
            <line className="gauge-needle" x1="50" y1="54" x2="50" y2="20" />
            <circle cx="50" cy="54" r="4" className="gauge-hub" />
          </svg>
        </div>
      </div>

      <div className="login-box">
        <div className="auth-logo-wrap" dangerouslySetInnerHTML={{ __html: AUTH_LOGO_SVG }} />
        <h1>Государственная компания по страхованию жизни</h1>

        {step === 'creds' && (
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
              {isLoading ? <><span className="spinner"></span>Проверяем…</> : 'Войти'}
            </button>
          </form>
        )}

        {step === 'eds' && (
          <div className="eds-step">
            <ShieldCheck className="eds-icon" size={40} />
            <p className="eds-title">Подтверждение входа по ЭЦП</p>
            {!edsError ? (
              <div className="eds-progress">
                <span className="spinner spinner--dark"></span>
                <span>{edsStage || 'Ожидание NCALayer…'}</span>
              </div>
            ) : (
              <>
                <p className="eds-error">{edsError}</p>
                <button type="button" className="eds-retry" onClick={() => runEds(challenge)}>
                  <RefreshCw size={16} /> Повторить подпись
                </button>
              </>
            )}
            <button type="button" className="eds-back" onClick={backToCreds}>
              ← Назад ко входу
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default Login
