import { useEffect, useRef, useState, useCallback } from 'react'
import Peer from 'simple-peer-light'
import './index.css'

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'wss://kirimin-signaling.darfinstar.workers.dev/ws'

const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
const formatSpeed = (bps) => `${formatSize(bps)}/s`

function useMediaQuery(q) {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const x = window.matchMedia(q)
    const h = () => setM(x.matches)
    x.addEventListener('change', h)
    return () => x.removeEventListener('change', h)
  }, [q])
  return m
}

const PEER_CONFIG = {
  initiator: false,
  trickle: false,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  }
}

function IconArrow() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconDownload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  )
}
function IconCloud() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconCheck() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
function IconMoon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.4 15.1A8.6 8.6 0 0 1 8.9 3.6 8.6 8.6 0 1 0 20.4 15.1Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
}
function IconSun() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.8" /><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
}
function IconBolt() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
}
function Logo({ dark }) {
  return (
    <img
      src={dark ? "/logo-light.png" : "/logo-dark.png"}
      alt="Kirimin"
      className="brand-logo"
    />
  )
}
function ThemeToggle({ dark, onClick }) {
  return <button className="theme-toggle" onClick={onClick} aria-label={dark ? 'Gunakan tema terang' : 'Gunakan tema gelap'} title={dark ? 'Gunakan tema terang' : 'Gunakan tema gelap'}>{dark ? <IconSun /> : <IconMoon />}</button>
}
const PLN_LOGO_SRCS = ['/pln-mobile-logo.svg', '/pln-mobile-logo.png']
function PlnBadge({ label = 'PLN Mobile' }) {
  const [srcIdx, setSrcIdx] = useState(0)
  if (srcIdx >= PLN_LOGO_SRCS.length) {
    return <span className="pln-badge pln-badge-text">{label}</span>
  }
  return (
    <span className="pln-badge">
      <img src={PLN_LOGO_SRCS[srcIdx]} alt={label} className="pln-logo" onError={() => setSrcIdx(i => i + 1)} />
    </span>
  )
}
function initials(value) {
  return value.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()
}
function formatTime(time) {
  return new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(time)
}

export default function App() {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  const [dark, setDark] = useState(prefersDark)
  const [name, setName] = useState(() => localStorage.getItem('kirimin_username') || '')
  const [joined, setJoined] = useState(() => Boolean(localStorage.getItem('kirimin_username')?.trim()))
  const [users, setUsers] = useState([])
  const [selected, setSelected] = useState(null)
  const [sending, setSending] = useState(null)
  const [receiving, setReceiving] = useState(null)
  const [history, setHistory] = useState([])
  const [notify, setNotify] = useState(null)
  const [error, setError] = useState(null)
  const [receivedFiles, setReceivedFiles] = useState([])
  const [socketId, setSocketId] = useState(null)
  const peerRef = useRef(null)
  const recvStateRef = useRef(null)
  const usersRef = useRef([])
  const socketRef = useRef(null)
  const wsRef = useRef(null)
  const fileQueueRef = useRef([])
  const isSendingRef = useRef(false)
  const urlCacheRef = useRef([])
  const audioRef = useRef(new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAA='))
  const [showProfile, setShowProfile] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState('')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  useEffect(() => {
    if (!notify) return
    const timer = setTimeout(() => setNotify(null), 1000)
    return () => clearTimeout(timer)
  }, [notify])

  useEffect(() => {
    usersRef.current = users
  }, [users])

  useEffect(() => {
    if (!joined) return

    let reconnectTimeout
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const connect = () => {
      const ws = new WebSocket(SIGNALING_URL)
      socketRef.current = ws
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[ws] connected')
        ws.send(JSON.stringify({ type: 'register', name }))
      }

      ws.onmessage = (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }

        if (message.type === 'registered') {
          console.log('[ws] registered:', message.id)
          setSocketId(message.id)
        } else if (message.type === 'users') {
          console.log('[ws] users:', message.users.map(u => u.name))
          const myId = socketId || message.users.find(u => u.name === name)?.id
          if (myId) setSocketId(myId)
          setUsers(message.users.filter((u) => u.id !== (myId || socketId)))
        } else if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
          const from = message.from
          const signal = message.data
          console.log('[signal] from', from, 'type:', signal?.type)
          const fromUser = usersRef.current.find(u => u.id === from)?.name || 'Seseorang'

          try {
            if (!peerRef.current) {
              const peer = new Peer(PEER_CONFIG)
              peerRef.current = peer

              peer.on('signal', (answer) => {
                console.log('[peer] answering')
                ws.send(JSON.stringify({ type: answer.type, target: from, data: answer }))
              })

              peer.on('connect', () => {
                console.log('[peer] connected!')
                setReceiving(r => r ? { ...r, connected: true } : r)
                setError(null)
              })

              peer.on('data', (data) => {
                chain = chain.then(async () => {
                  if (typeof data === 'string') {
                    try {
                      const msg = JSON.parse(data)
                      if (msg.type === 'file-meta') {
                        console.log('[file] meta received:', msg)
                        const pending = recvStateRef.current?.pendingChunks || []
                        recvStateRef.current = {
                          name: msg.name,
                          size: msg.size,
                          mime: msg.mime || 'application/octet-stream',
                          checksum: msg.checksum,
                          fromName: fromUser,
                          received: 0,
                          chunks: [...pending],
                          startTime: Date.now(),
                          speed: 0,
                          connected: true,
                          complete: false
                        }
                        pending.forEach(chunk => {
                          recvStateRef.current.received += chunk.byteLength
                        })
                        setReceiving(recvStateRef.current)
                        return
                      }
                      if (msg.type === 'file-end') {
                        console.log('[file] end signal received')
                        if (recvStateRef.current) {
                          recvStateRef.current.complete = true
                          await finalizeTransfer()
                        }
                        return
                      }
                    } catch {
                      console.warn('[file] non-JSON string received, treating as binary')
                    }
                  }

                  if (data instanceof ArrayBuffer || data instanceof Uint8Array || ArrayBuffer.isView(data)) {
                    const chunk = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                    if (recvStateRef.current) {
                      recvStateRef.current.chunks.push(chunk)
                      recvStateRef.current.received += chunk.byteLength
                      
                      if (recvStateRef.current.chunks.length % 50 === 0) {
                        console.log('[file] progress:', recvStateRef.current.received, '/', recvStateRef.current.size)
                      }
                      
                      const elapsed = (Date.now() - recvStateRef.current.startTime) / 1000
                      recvStateRef.current.speed = elapsed > 0 ? recvStateRef.current.received / elapsed : 0
                      setReceiving({ ...recvStateRef.current })

                      if (recvStateRef.current.received >= recvStateRef.current.size && recvStateRef.current.complete) {
                        await finalizeTransfer()
                      }
                    } else {
                      console.log('[file] early chunk buffered:', chunk.byteLength)
                      recvStateRef.current = {
                        pendingChunks: [chunk],
                        name: null, size: null, mime: null, checksum: null,
                        fromName, received: chunk.byteLength, chunks: [],
                        startTime: Date.now(), speed: 0, connected: true, complete: false
                      }
                    }
                  }
                })
              })

              peer.on('error', (err) => {
                console.error('[peer] error:', err)
                setError('Gagal terhubung ke penerima. Coba lagi.')
                if (peerRef.current) {
                  peerRef.current.destroy()
                  peerRef.current = null
                }
                recvStateRef.current = null
                setReceiving(null)
              })

              peer.on('close', () => {
                console.log('[peer] closed')
                peerRef.current = null
              })
            }
            peerRef.current.signal(signal)
          } catch (err) {
            console.error('[signal] error:', err)
          }
        } else if (message.type === 'error') {
          console.error('[ws] error:', message.message)
          setError(message.message)
        } else if (message.type === 'renamed') {
          console.log('[ws] renamed to:', message.name)
          setName(message.name)
          localStorage.setItem('kirimin_username', message.name)
          setShowRename(false)
        }
      }

      ws.onclose = () => {
        console.log('[ws] disconnected, reconnecting...')
        reconnectTimeout = setTimeout(connect, 3000)
      }

      ws.onerror = (e) => {
        console.error('[ws] error', e)
        ws.close()
      }
    }

    let chain = Promise.resolve()
    const finalizeTransfer = async () => {
      const state = recvStateRef.current
      if (!state || state.finalized) return
      state.finalized = true

      console.log('[file] finalizing, total:', state.received, 'expected:', state.size)
      if (state.received < state.size) {
        console.warn('[file] incomplete:', state.received, '/', state.size)
      }

      const blob = new Blob(state.chunks, { type: state.mime })
      const receivedDigest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      const receivedChecksum = Array.from(new Uint8Array(receivedDigest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (state.checksum && receivedChecksum !== state.checksum) {
        setError('Berkas rusak saat transfer. Pengiriman dibatalkan.')
        recvStateRef.current = null
        setReceiving(null)
        return
      }

      const url = URL.createObjectURL(blob)
      console.log('[file] download ready:', state.name, 'url:', url)
      urlCacheRef.current.push(url)
      setReceivedFiles(prev => [...prev, { name: state.name, size: state.size, url, time: Date.now() }])
      setNotify({ type: 'success', message: `Berkas "${state.name}" diterima utuh tanpa kompresi` })
      setHistory(h => [{ name: state.name, size: state.size, peer: state.fromName, time: Date.now(), type: 'received' }, ...h].slice(0, 20))
      audioRef.current.play().catch(() => {})

      setTimeout(() => {
        if (peerRef.current) {
          peerRef.current.destroy()
          peerRef.current = null
        }
        recvStateRef.current = null
        setReceiving(null)
      }, 1000)
    }

    connect()

    return () => {
      clearTimeout(reconnectTimeout)
      if (socketRef.current) {
        socketRef.current.onclose = null
        socketRef.current.close()
      }
      if (wsRef.current) {
        wsRef.current = null
      }
    }
  }, [joined])

  useEffect(() => {
    return () => {
      urlCacheRef.current.forEach(url => URL.revokeObjectURL(url))
    }
  }, [])

  const join = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    localStorage.setItem('kirimin_username', name.trim())
    setJoined(true)
  }

  const sendFile = useCallback((file, recipient) => new Promise((resolve) => {
    if (!file || !recipient) {
      resolve()
      return
    }

    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }

    const peer = new Peer({
      ...PEER_CONFIG,
      initiator: true
    })
    peerRef.current = peer

    const transfer = { name: file.name, size: file.size, sent: 0, connected: false, startTime: Date.now(), speed: 0 }
    setSending(transfer)
    setError(null)

    let connectTimeout
    let settled = false
    const finish = (success) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimeout)
      if (peerRef.current === peer) {
        peer.destroy()
        peerRef.current = null
      }
      setSending(null)
      resolve(success)
    }

    peer.on('signal', (signal) => {
      console.log('[peer] offering, type:', signal?.type)
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: signal.type || 'ice-candidate', target: recipient.id, data: signal }))
      }
    })

    peer.on('connect', async () => {
      console.log('[peer] connected, waiting for channel ready...')
      clearTimeout(connectTimeout)
      setSending(s => s ? { ...s, connected: true } : s)

      try {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
        const checksum = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
        const meta = JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mime: file.type, checksum })
        console.log('[file] sending meta:', { name: file.name, size: file.size, mime: file.type })
        peer.send(meta)

        await new Promise(r => setTimeout(r, 100))

        const chunkSize = 16 * 1024
        const maxBufferedAmount = 256 * 1024
        let offset = 0
        let chunkCount = 0
        const startTime = Date.now()

        const send = async () => {
          if (!peer.connected) {
            finish(false)
            return
          }

          const bufferedAmount = peer.bufferSize
          if (bufferedAmount > maxBufferedAmount) {
            setTimeout(send, 20)
            return
          }

          const chunk = file.slice(offset, offset + chunkSize)
          const buffer = await chunk.arrayBuffer()
          if (!peer.connected) {
            finish(false)
            return
          }

          peer.send(buffer)
          offset += buffer.byteLength
          chunkCount += 1

          if (chunkCount % 50 === 0 || offset === file.size) console.log('[file] sent:', offset, '/', file.size)

          const elapsed = (Date.now() - startTime) / 1000
          const speed = elapsed > 0 ? offset / elapsed : 0
          setSending(s => s ? { ...s, sent: offset, speed } : s)

          if (offset < file.size) {
            setTimeout(send, 0)
            return
          }

          console.log('[file] sending complete signal')
          peer.send(JSON.stringify({ type: 'file-end' }))
          setHistory(h => [{ name: file.name, size: file.size, peer: recipient.name, time: Date.now(), type: 'sent' }, ...h].slice(0, 20))
          setNotify({ type: 'success', message: `Berkas "${file.name}" terkirim ke ${recipient.name}` })
          setTimeout(() => finish(true), 2000)
        }
        send()
      } catch (err) {
        console.error('[send] error:', err)
        setError('Gagal mengirim berkas.')
        finish(false)
      }
    })

    connectTimeout = setTimeout(() => {
      setError('Koneksi timeout. Pastikan penerima online dan refresh halaman.')
      finish(false)
    }, 40000)

    peer.on('error', (err) => {
      console.error('[peer] error:', err)
      setError('Gagal terhubung. Coba lagi.')
      finish(false)
    })

    peer.on('close', () => {
      if (!settled) finish(false)
    })
  }), [])

  const handleRename = () => {
    const newName = renameValue.trim()
    if (!newName) {
      setRenameError('Nama tidak boleh kosong')
      return
    }
    if (newName === name) {
      setShowRename(false)
      setRenameValue('')
      return
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'rename', name: newName }))
    }
  }

  const processFileQueue = useCallback(async () => {
    if (isSendingRef.current) return
    isSendingRef.current = true

    while (fileQueueRef.current.length > 0) {
      const item = fileQueueRef.current.shift()
      await sendFile(item.file, item.recipient)
    }

    isSendingRef.current = false
  }, [sendFile])

  const handleFiles = useCallback((files) => {
    if (!selected) return
    fileQueueRef.current.push(...Array.from(files).map(file => ({ file, recipient: selected })))
    processFileQueue()
  }, [processFileQueue, selected])

  const onDrop = useCallback((e) => { e.preventDefault(); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files) }, [handleFiles])
  const onDragOver = useCallback((e) => e.preventDefault(), [])

  if (!joined) return <main className={`login ${dark ? 'dark' : ''}`}>
    <header className="login-header"><div className="brand-group"><Logo dark={dark} /><span className="pln-separator" aria-hidden="true" /><PlnBadge label="PLN Mobile" /></div><ThemeToggle dark={dark} onClick={() => setDark(d => !d)} /></header>
    <div className="login-shell">
      <div className="login-kicker"><span className="kicker-dot" /> Berbagi langsung, lebih sederhana</div>
      <h1>Kirim berkas<br /><em>tanpa perantara.</em></h1>
      <p>Transfer file langsung dari browser ke browser. Cepat, aman, tanpa menyimpan file di server.</p>
      <form onSubmit={join}>
        <label htmlFor="display-name">Nama Anda</label>
        <div className="login-form-row"><input id="display-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Masukkan nama Anda" maxLength="32" autoComplete="off" /><button type="submit">Mulai Berbagi <span>→</span></button></div>
      </form>
      <div className="trust-row"><span><IconCheck /> P2P langsung</span><span><IconCheck /> Tanpa upload server</span><span><IconCheck /> Gratis digunakan</span></div>
      <div className="pln-note"><span className="pln-bolt"><IconBolt /></span><span>PLN Workspace</span><span className="pln-note-sep" aria-hidden="true">·</span><span className="pln-note-sub">Berbagi berkas untuk kebutuhan kerja</span></div>
    </div>
    <div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" />
    <footer className="site-footer"><span>Kirimin — Berbagi Berkas Langsung</span><span className="pln-foot"><span className="pln-bolt"><IconBolt /></span>PLN Workspace</span></footer>
  </main>

  const sentPercent = sending ? Math.min(100, Math.round((sending.sent / sending.size) * 100)) : 0
  const recvPercent = receiving ? Math.min(100, Math.round((receiving.received / receiving.size) * 100)) : 0
  const sendSpeed = sending ? formatSpeed(sending.speed || 0) : ''
  const recvSpeed = receiving ? formatSpeed(receiving.speed || 0) : ''
  const sendETA = (sending && sending.speed > 0 && sending.sent < sending.size) ? Math.ceil((sending.size - sending.sent) / sending.speed) + 's' : ''
  const recvETA = (receiving && receiving.speed > 0 && receiving.received < receiving.size) ? Math.ceil((receiving.size - receiving.received) / receiving.speed) + 's' : ''

  return <main className={`app ${dark ? 'dark' : ''}`}>
    <header>
       <div className="brand-wrap"><Logo dark={dark} /><span className="pln-separator" aria-hidden="true" /><PlnBadge label="PLN Workspace" /></div>
      <div className="profile">
        <span className="connection-status"><span className="dot" /> Terhubung</span>
        <div className="profile-container">
          <button className="profile-trigger" onClick={() => setShowProfile(!showProfile)}>
            <span className="name-badge">{initials(name)} <b>{name}</b></span>
          </button>
          {showProfile && (
            <div className="profile-dropdown">
              <div className="dropdown-info"><b>{name}</b><small><span className="dot" /> Online</small></div>
              <button className="dropdown-item" onClick={() => { setShowRename(true); setRenameValue(name); setShowProfile(false); }}><span>✏️</span> Ganti Nama</button>
            </div>
          )}
        </div>
        <ThemeToggle dark={dark} onClick={() => setDark(d => !d)} />
      </div>
    </header>
    {showRename && (
      <div className="modal-overlay" onClick={() => setShowRename(false)}>
        <div className="modal-content" onClick={e => e.stopPropagation()}>
          <div className="modal-header"><h3>Ganti Nama</h3><button onClick={() => setShowRename(false)}>×</button></div>
          <div className="modal-body">
            <p>Nama saat ini: <b>{name}</b></p>
            <div className="input-group">
              <label>Nama Baru</label>
              <input autoFocus value={renameValue} onChange={e => { setRenameValue(e.target.value); setRenameError(''); }} placeholder="Ketik nama baru..." maxLength="30" onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setShowRename(false); }} />
              {renameError && <small className="error-text">{renameError}</small>}
            </div>
          </div>
          <div className="modal-footer"><button className="btn-secondary" onClick={() => setShowRename(false)}>Batal</button><button className="btn-primary" onClick={handleRename}>Simpan Nama</button></div>
        </div>
      </div>
    )}
    <section className="layout">
      <aside>
        <div className="pln-context"><span className="pln-bolt"><IconBolt /></span><span>PLN Internal · Workspace</span></div>
        <div className="sidebar-section">
          <div className="sidebar-title"><span>Pengguna Online</span><b>{users.length}</b></div>
          {users.length === 0 && <p className="empty-hint">Menunggu pengguna lain bergabung…</p>}
          {users.map((u) => (
            <button key={u.id} className={`user-card ${selected?.id === u.id ? 'active' : ''}`} onClick={() => setSelected(u)}>
              <span className="avatar">{initials(u.name)}</span><span className="user-details"><b>{u.name}</b><small><span className="dot" /> Online</small></span>
            </button>
          ))}
        </div>
        <div className="sidebar-section history-section">
          <div className="sidebar-title"><span>Riwayat Transfer</span></div>
          {history.length === 0 && <p className="empty-hint">Belum ada aktivitas transfer</p>}
          {history.map((h, i) => (
            <div key={i} className={`history-card ${h.type}`}><span className="history-icon">{h.type === 'sent' ? '↑' : '↓'}</span><div><b>{h.name}</b><small>{h.type === 'sent' ? `Ke ${h.peer}` : `Dari ${h.peer}`} · {formatSize(h.size)} · {formatTime(h.time)}</small></div></div>
          ))}
        </div>
      </aside>
      <article>
        <div className="eyebrow">TRANSFER AMAN P2P</div>
        <h1>{selected ? <>Kirim ke <strong>{selected.name}</strong></> : <><span className="hero-icon"><IconCloud /></span>Pilih penerima</>}</h1>
        <p className="sub">{selected ? 'Pilih satu atau beberapa berkas dari perangkat Anda.' : 'Pilih pengguna online untuk memulai transfer berkas langsung.'}</p>
        <label className={`dropzone ${!selected ? 'disabled' : ''}`} onDrop={onDrop} onDragOver={onDragOver}>
          <input type="file" multiple disabled={!selected} onChange={(e) => handleFiles(e.target.files)} />
          <div className="drop-icon"><IconArrow /></div><div className="drop-content"><b>{selected ? 'Tarik berkas ke sini' : 'Pilih penerima terlebih dahulu'}</b><span>{selected ? 'atau pilih berkas dari perangkat' : 'Daftar pengguna online ada di samping'}</span><small>Transfer langsung antar perangkat · Ukuran bebas</small></div>
        </label>
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError(null)} aria-label="Tutup pesan kesalahan">×</button></div>}
        {(sending || receiving) && (
          <div className="progress-card">
            <div className="progress-head"><div className="progress-label"><span className={`dot ${sending?.connected || receiving?.connected ? 'ok' : 'pulse'}`} /><div><span>{sending ? (sending.connected ? 'Mengirim berkas' : 'Menyiapkan koneksi') : (receiving?.connected ? 'Menerima berkas' : 'Menunggu koneksi')}</span><b>{sending?.name || receiving?.name || 'Menyiapkan transfer'}</b></div></div><strong>{sending ? sentPercent : recvPercent}%</strong></div>
            <div className="track"><div style={{ width: `${sending ? sentPercent : recvPercent}%` }} /></div>
            <div className="progress-meta"><span>{sending ? formatSize(sending.sent) : formatSize(receiving.received)} dari {sending ? formatSize(sending.size) : formatSize(receiving.size)}</span><span>{sending ? sendSpeed : recvSpeed}</span>{sendETA && <span className="eta">Sisa {sendETA}</span>}{recvETA && <span className="eta">Sisa {recvETA}</span>}<span className={`conn ${sending?.connected || receiving?.connected ? 'ok' : 'pulse'}`}>{sending?.connected || receiving?.connected ? 'Terhubung langsung' : 'Menghubungkan…'}</span></div>
          </div>
        )}
      </article>
    </section>
    <footer className="site-footer"><span>Kirimin — Berbagi Berkas Langsung</span><span className="pln-foot"><span className="pln-bolt"><IconBolt /></span>PLN Workspace</span></footer>
    {notify && <div className={`toast ${notify.type}`} onClick={() => setNotify(null)}><span><IconCheck /></span>{notify.message}</div>}
    {receivedFiles.length > 0 && <div className="download-panel"><div className="download-panel-header"><div><span className="received-check"><IconCheck /></span><div><b>Berkas berhasil diterima</b><small>{receivedFiles.length} berkas siap diunduh</small></div></div><button onClick={() => { urlCacheRef.current.forEach(URL.revokeObjectURL); urlCacheRef.current = []; setReceivedFiles([]) }} aria-label="Tutup daftar">×</button></div>{receivedFiles.map((file, idx) => <div key={idx} className="download-item"><div className="download-info"><b>{file.name}</b><small>{formatSize(file.size)}</small></div><a href={file.url} download={file.name} className="download-btn">Download <IconDownload /></a></div>)}</div>}
  </main>
}