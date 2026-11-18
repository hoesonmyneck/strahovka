import axios from 'axios'

const api = axios.create({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json',
  },
})

// Демонстрационный аккаунт: какой «вид» сейчас выбран (ГАК / ДКГИТ). Сервер
// учитывает заголовок только у демо-аккаунта, остальным он безразличен.
api.interceptors.request.use((config) => {
  try {
    const view = localStorage.getItem('demoView')
    if (view) config.headers['X-Demo-View'] = view
  } catch {}
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    // 401 на самих эндпоинтах входа (неверный пароль, неудачная ЭЦП) обрабатывает
    // форма входа — не выкидываем и не редиректим, иначе теряется текст ошибки.
    const url = error.config?.url || ''
    if (error.response?.status === 401 && !url.includes('/api/auth/')) {
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export default api
