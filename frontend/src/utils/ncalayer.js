// Подпись данных через NCALayer (ЭЦП РК). Со страницы по HTTPS подключаемся к
// локальному NCALayer по wss://127.0.0.1:13579/, с запасным ws://127.0.0.1:14579/.

const NCALAYER_URLS = ['wss://127.0.0.1:13579/', 'ws://127.0.0.1:14579/']

// Пробуем адреса по очереди, по 3 секунды на каждый.
function connect() {
  return new Promise((resolve, reject) => {
    let idx = 0
    const tryNext = () => {
      if (idx >= NCALAYER_URLS.length) {
        reject(new Error('NCALayer не запущен или недоступен. Запустите NCALayer (pki.gov.kz) и попробуйте снова.'))
        return
      }
      const url = NCALAYER_URLS[idx++]
      let settled = false
      let ws
      try {
        ws = new WebSocket(url)
      } catch {
        tryNext()
        return
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { ws.close() } catch {}
        tryNext()
      }, 3000)
      ws.onopen = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ws)
      }
      ws.onerror = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { ws.close() } catch {}
        tryNext()
      }
    }
    tryNext()
  })
}

// Достаём подпись из ответа NCALayer (форма ответа зависит от версии).
function extractSignature(data) {
  if (data.responseObject) {
    return typeof data.responseObject === 'string'
      ? data.responseObject
      : (data.responseObject.signature || null)
  }
  if (typeof data.result === 'string') return data.result
  if (data.result && typeof data.result === 'object' && data.result.signature) {
    return data.result.signature
  }
  return null
}

// Подписывает строку challenge и возвращает base64 CMS-подпись (attached).
// onStage(text) — колбэк для отображения этапа пользователю.
export async function signChallenge(challenge, onStage) {
  onStage && onStage('Подключение к NCALayer…')
  const ws = await connect()

  return new Promise((resolve, reject) => {
    let sent = false
    let done = false

    const finish = (fn, arg) => {
      if (done) return
      done = true
      try { ws.close() } catch {}
      fn(arg)
    }

    // UTF-8 → base64, как требует createCAdESFromBase64
    const base64Data = btoa(unescape(encodeURIComponent(challenge)))
    const sendSignRequest = () => {
      if (sent) return
      sent = true
      onStage && onStage('Подпишите данные в окне NCALayer…')
      ws.send(JSON.stringify({
        module: 'kz.gov.pki.knca.commonUtils',
        method: 'createCAdESFromBase64',
        // последний аргумент true (attached) обязателен: подписанные данные
        // должны оказаться внутри CMS, иначе сервер не сверит их с challenge
        args: ['PKCS12', 'SIGNATURE', base64Data, true],
      }))
    }

    // Если handshake не пришёл — всё равно отправляем запрос через 600 мс
    const fallback = setTimeout(sendSignRequest, 600)

    ws.onmessage = (evt) => {
      let data
      try { data = JSON.parse(evt.data) } catch { return }

      // handshake NCALayer: {"result":{"version":"1.x"}} — после него шлём запрос
      if (!sent && data && data.result && typeof data.result === 'object' && data.result.version) {
        clearTimeout(fallback)
        sendSignRequest()
        return
      }

      // ошибка (отмена, неверный пароль от ключа и т.п.)
      if (data && data.code != null && String(data.code) !== '200') {
        finish(reject, new Error(data.message || 'Подпись не выполнена'))
        return
      }

      const sig = extractSignature(data)
      if (sig) {
        onStage && onStage('Проверка подписи…')
        finish(resolve, sig)
      }
    }

    ws.onerror = () => finish(reject, new Error('Ошибка соединения с NCALayer'))
    ws.onclose = () => finish(reject, new Error('NCALayer закрыл соединение до завершения подписи'))
  })
}
