import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import './hud.css'
import './theme-dark.css'

// Тема (тёмная по умолчанию) ставится на <html> ещё до первой отрисовки — так
// её получают и страница входа, и экран загрузки, без «белой вспышки».
// Переключает тему кнопка в шапке (Dashboard.jsx), выбор хранится в браузере.
try {
  document.documentElement.setAttribute(
    'data-theme', localStorage.getItem('theme') === 'light' ? 'light' : 'dark')
} catch {
  document.documentElement.setAttribute('data-theme', 'dark')
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
