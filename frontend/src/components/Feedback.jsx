import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const FeedbackContext = createContext(null)

/** Toasts + a promise-based confirmation dialog for destructive actions. */
export function FeedbackProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const [dialog, setDialog] = useState(null)
  const idRef = useRef(0)

  const toast = useCallback((message, kind = 'info') => {
    const id = ++idRef.current
    setToasts((t) => [...t, { id, message, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 4500)
  }, [])

  const confirm = useCallback(
    (options) => new Promise((resolve) => setDialog({ ...options, resolve })),
    []
  )

  const close = (value) => {
    dialog?.resolve(value)
    setDialog(null)
  }

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'toast-error' : ''}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span>{t.message}</span>
            <button type="button" aria-label="Fechar" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
      {dialog && <ConfirmDialog {...dialog} onClose={close} />}
    </FeedbackContext.Provider>
  )
}

function ConfirmDialog({ title, message, details, confirmLabel = 'Confirmar', danger = false, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.focus()
    const onKey = (e) => e.key === 'Escape' && onClose(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 id="confirm-title">{title}</h3>
        {message && <p>{message}</p>}
        {details?.length > 0 && (
          <ul className="modal-details">
            {details.map((d) => <li key={d}>{d}</li>)}
          </ul>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={() => onClose(false)}>Cancelar</button>
          <button type="button" ref={ref} className={danger ? 'danger' : 'primary'} onClick={() => onClose(true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

export function useFeedback() {
  const ctx = useContext(FeedbackContext)
  if (!ctx) throw new Error('useFeedback must be used inside FeedbackProvider')
  return ctx
}
