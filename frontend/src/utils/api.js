import axios from 'axios'

const api = axios.create({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json',
  },
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
