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

function IconUser({ fill = '#86868b' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="7" r="4" fill={fill} />
      <path d="M4 21v-1a6 6 0 0 1 12 0v1" fill={fill} />
    </svg>
  )
}
function IconArrow() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M5 12l7-7 7 7" stroke="#0a84ff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function IconSend() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" fill="#fff" stroke="none"/>
    </svg>
  )
}
function IconDownload() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  )
}
function IconCloud() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke="#0a84ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export default function App() {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  const [dark, setDark] = useState(prefersDark)
  const [name, setName] = useState('')
  const [joined, setJoined] = useState(false)
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
  const audioRef = useRef(new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAA='))

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

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
    }
  }, [joined])

  useEffect(() => {
    return () => {
      receivedFiles.forEach(f => URL.revokeObjectURL(f.url))
    }
  }, [receivedFiles])

  const join = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    setJoined(true)
  }

  const sendFile = useCallback(async (file) => {
    if (!file || !selected) return

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

    peer.on('signal', (signal) => {
      console.log('[peer] offering, type:', signal?.type)
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: signal.type || 'ice-candidate', target: selected.id, data: signal }))
      }
    })

    let connectTimeout
    peer.on('connect', async () => {
      console.log('[peer] connected, waiting for channel ready...')
      clearTimeout(connectTimeout)
      setSending(s => s ? { ...s, connected: true } : s)

      try {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
        const checksum = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')

        const meta = JSON.stringify({ 
          type: 'file-meta', 
          name: file.name, 
          size: file.size, 
          mime: file.type, 
          checksum 
        })
        console.log('[file] sending meta:', { name: file.name, size: file.size, mime: file.type })
        peer.send(meta)

        await new Promise(r => setTimeout(r, 100))

        const chunkSize = 16 * 1024
        const maxBufferedAmount = 256 * 1024
        let offset = 0
        let chunkCount = 0
        const startTime = Date.now()

        const send = async () => {
          if (!peer.connected) return

          const bufferedAmount = peer.bufferSize
          if (bufferedAmount > maxBufferedAmount) {
            setTimeout(send, 20)
            return
          }

          const chunk = file.slice(offset, offset + chunkSize)
          const buffer = await chunk.arrayBuffer()
          if (!peer.connected) return

          peer.send(buffer)
          offset += buffer.byteLength
          chunkCount += 1

          if (chunkCount % 50 === 0 || offset === file.size) {
            console.log('[file] sent:', offset, '/', file.size)
          }

          const elapsed = (Date.now() - startTime) / 1000
          const speed = elapsed > 0 ? offset / elapsed : 0
          setSending(s => s ? { ...s, sent: offset, speed } : s)

          if (offset < file.size) {
            setTimeout(send, 0)
          } else {
            console.log('[file] sending complete signal')
            peer.send(JSON.stringify({ type: 'file-end' }))
            setHistory(h => [{ name: file.name, size: file.size, peer: selected.name, time: Date.now(), type: 'sent' }, ...h].slice(0, 20))
            setNotify({ type: 'success', message: `Berkas "${file.name}" terkirim ke ${selected.name}` })
            setTimeout(() => {
              if (peer) peer.destroy()
              peerRef.current = null
              setSending(null)
            }, 2000)
          }
        }
        send()
      } catch (err) {
        console.error('[send] error:', err)
        setError('Gagal mengirim berkas.')
        setSending(null)
      }
    })

    connectTimeout = setTimeout(() => {
      if (sending && !sending.connected) {
        setError('Koneksi timeout. Pastikan penerima online dan refresh halaman.')
        setSending(null)
      }
    }, 40000)

    peer.on('error', (err) => {
      console.error('[peer] error:', err)
      clearTimeout(connectTimeout)
      setError('Gagal terhubung. Coba lagi.')
      if (peerRef.current) {
        peerRef.current.destroy()
        peerRef.current = null
      }
      setSending(null)
    })
  }, [selected, sending])

  const handleFiles = useCallback((files) => {
    Array.from(files).forEach(sendFile)
  }, [sendFile])

  const onDrop = useCallback((e) => { e.preventDefault(); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files) }, [handleFiles])
  const onDragOver = useCallback((e) => e.preventDefault(), [])

  if (!joined) return <main className={`login ${dark ? 'dark' : ''}`}>
    <div className="brand-wrap"><span className="brand">kirim<span>in</span></span><span className="tag">Berbagi Berkas Langsung</span></div>
    <h1>Kirim berkas seketika</h1>
    <p>Transfer langsung antar-browser (P2P). Tanpa simpan di server.</p>
    <form onSubmit={join}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Masukkan nama Anda" maxLength="32" autoComplete="off" />
      <button type="submit">Mulai Berbagi</button>
    </form>
    <button className="theme-toggle" onClick={() => setDark(d => !d)} aria-label="Ganti tema">{dark ? '☀️' : '🌙'}</button>
  </main>

  const sentPercent = sending ? Math.min(100, Math.round((sending.sent / sending.size) * 100)) : 0
  const recvPercent = receiving ? Math.min(100, Math.round((receiving.received / receiving.size) * 100)) : 0
  const sendSpeed = sending ? formatSpeed(sending.speed || 0) : ''
  const recvSpeed = receiving ? formatSpeed(receiving.speed || 0) : ''
  const sendETA = (sending && sending.speed > 0 && sending.sent < sending.size) ? Math.ceil((sending.size - sending.sent) / sending.speed) + 's' : ''
  const recvETA = (receiving && receiving.speed > 0 && receiving.received < receiving.size) ? Math.ceil((receiving.size - receiving.received) / receiving.speed) + 's' : ''

  return <main className={`app ${dark ? 'dark' : ''}`}>
    <header>
      <div className="brand-wrap">
        <span className="brand">kirim<span>in</span></span>
        <span className="pill">P2P</span>
      </div>
      <div className="profile">
        <span className="name-badge">{name}</span>
        <button className="theme-toggle" onClick={() => setDark(d => !d)} aria-label="Ganti tema">{dark ? '☀️' : '🌙'}</button>
      </div>
    </header>
    <section className="layout">
      <aside>
        <div className="sidebar-section">
          <div className="sidebar-title"><IconUser /> <span>Daring</span><b>{users.length}</b></div>
          {users.length === 0 && <p className="empty-hint">Menunggu pengguna lain bergabung…</p>}
          {users.map((u) => (
            <button key={u.id} className={`user-card ${selected?.id === u.id ? 'active' : ''}`} onClick={() => setSelected(u)}>
              <span className="dot" />
              <IconUser />
              <span>{u.name}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-section">
          <div className="sidebar-title"><IconSend /> <span>Riwayat</span></div>
          {history.length === 0 && <p className="empty-hint">Belum ada pengiriman</p>}
          {history.map((h, i) => (
            <div key={i} className={`history-card ${h.type}`}>
              {h.type === 'sent' ? <IconSend /> : <IconDownload />}
              <div>
                <b>{h.name}</b>
                <small>{formatSize(h.size)}</small>
              </div>
            </div>
          ))}
        </div>
      </aside>
      <article>
        <div className="eyebrow">LANGKAH 1</div>
        <h1>{selected ? 'Kirim ke' : <><IconCloud /> Pilih penerima</>} <strong>{selected && selected.name}</strong></h1>
        <p className="sub">{selected ? 'Pilih berkas yang ingin dikirim' : 'Pilih pengguna di kiri untuk mulai berbagi'}</p>
        <label className={`dropzone ${!selected ? 'disabled' : ''}`} onDrop={onDrop} onDragOver={onDragOver}>
          <input type="file" multiple disabled={!selected} onChange={(e) => handleFiles(e.target.files)} />
          <div className="drop-content">
            <IconArrow />
            <b>{selected ? 'Klik atau tarik berkas di sini' : 'Pilih pengguna dulu'}</b>
            <small>Mendukung banyak berkas · Ukuran bebas</small>
          </div>
        </label>
        {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}
        {(sending || receiving) && (
          <div className="progress-card">
            <div className="progress-head">
              <div className="progress-label">
                <span className={`dot ${sending?.connected || receiving?.connected ? 'ok' : 'pulse'}`} />
                <b>{sending ? `Mengirim ke ${selected?.name}` : `Menerima dari ${receiving?.fromName}`}</b>
              </div>
              <span>{sending ? sentPercent : recvPercent}%</span>
            </div>
            <div className="track"><div style={{ width: `${sending ? sentPercent : recvPercent}%` }} /></div>
            <div className="progress-meta">
              <span>{sending ? formatSize(sending.sent) : formatSize(receiving.received)} / {sending ? formatSize(sending.size) : formatSize(receiving.size)}</span>
              <span>{sending ? sendSpeed : recvSpeed}</span>
              {sendETA && <span className="eta">≈{sendETA}</span>}
              {recvETA && <span className="eta">≈{recvETA}</span>}
              <span className={`conn ${sending?.connected || receiving?.connected ? 'ok' : 'pulse'}`}>{sending?.connected || receiving?.connected ? 'Terhubung' : 'Menghubungkan…'}</span>
            </div>
          </div>
        )}
      </article>
    </section>
    {notify && <div className={`toast ${notify.type}`} onClick={() => setNotify(null)}>{notify.message}</div>}
    {receivedFiles.length > 0 && (
      <div className="download-panel">
        <div className="download-panel-header">
          <span>Berkas diterima ({receivedFiles.length})</span>
          <button onClick={() => {
            receivedFiles.forEach(f => URL.revokeObjectURL(f.url))
            setReceivedFiles([])
          }} aria-label="Tutup daftar">×</button>
        </div>
        {receivedFiles.map((file, idx) => (
          <div key={idx} className="download-item">
            <div className="download-info">
              <b>{file.name}</b>
              <small>{formatSize(file.size)}</small>
            </div>
            <a
              href={file.url}
              download={file.name}
              className="download-btn"
              onClick={() => {
                console.log('[download] clicked:', file.name)
                // Hapus satu file setelah diunduh (opsional) atau biarkan di list
              }}
            >Download</a>
          </div>
        ))}
      </div>
    )}
  </main>
}