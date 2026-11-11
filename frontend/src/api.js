// Small API client. Same-origin by default (Vite proxy in dev, backend-served build in prod).
const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const CLIENT_HEADER = { 'X-ClipForge-Client': '1' }

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const init = { method, signal, headers: { ...CLIENT_HEADER } }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['Content-Type'] = 'application/json'
  }
  let res
  try {
    res = await fetch(BASE + path, init)
  } catch {
    throw new ApiError('Não foi possível falar com o servidor local. O ClipForge está aberto?', 0, 'OFFLINE')
  }
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) throw new ApiError(data?.error || `Erro ${res.status}`, res.status, data?.code)
  return data
}

/** Upload with progress (fetch has no upload progress events). */
export function uploadWithProgress(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', BASE + path)
    xhr.setRequestHeader('X-ClipForge-Client', '1')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
    xhr.onerror = () => reject(new ApiError('Falha de conexão durante o envio.', 0, 'OFFLINE'))
    xhr.onload = () => {
      let data = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        data = null
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else reject(new ApiError(data?.error || `Erro ${xhr.status}`, xhr.status, data?.code))
    }
    xhr.send(form)
  })
}

export const mediaUrl = (url) => (url ? BASE + url : null)
