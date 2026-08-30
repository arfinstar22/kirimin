import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'
import Peer from 'simple-peer-light'
import './index.css'

const socket = io(import.meta.env.VITE_SIGNALING_URL || `${window.location.protocol}//${window.location.hostname}:3002`, {
  transports: ['websocket', 'polling'],
  reconnection: true
})
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
  const peerRef = useRef(null)
  const recvStateRef = useRef(null)
  const usersRef = useRef([])
  const audioRef = useRef(new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAA='))

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  useEffect(() => {
    usersRef.current = users
  }, [users])

  useEffect(() => {
    socket.on('users', (list) => {
      console.log('Received users:', list)
      setUsers(list.filter((u) => u.id !== socket.id))
    })

    let chain = Promise.resolve()

    socket.on('signal', ({ from, signal }) => {
      console.log('[signal] from', from, 'type:', signal?.type)
      const fromUser = usersRef.current.find(u => u.id === from)?.name || 'Seseorang'

      try {
        if (!peerRef.current) {
          const peer = new Peer(PEER_CONFIG)
          peerRef.current = peer

          peer.on('signal', (answer) => {
            console.log('[peer] answering')
            socket.emit('signal', { to: from, signal: answer })
          })

          peer.on('connect', () => {
            console.log('[peer] connected!')
            setReceiving(r => r ? { ...r, connected: true } : r)
            setError(null)
          })

          const toArrayBuffer = (data) => {
            if (data instanceof ArrayBuffer) return Promise.resolve(data)
            if (data instanceof Uint8Array) return Promise.resolve(data.slice(0).buffer)
            if (ArrayBuffer.isView(data)) return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(0).buffer)
            if (data instanceof Blob) return data.arrayBuffer()
            if (typeof data === 'string') return Promise.resolve(new TextEncoder().encode(data).buffer)
            return Promise.resolve(data)
          }

          peer.on('data', (data) => {
            chain = chain.then(async () => {
              const buffer = await toArrayBuffer(data)

              try {
                if (buffer.byteLength < 5000) {
                  const str = new TextDecoder().decode(buffer)
                  const meta = JSON.parse(str)
                  if (meta.type === 'meta') {
                    const newState = {
                      name: meta.name,
                      size: meta.size,
                      mime: meta.mime || 'application/octet-stream',
                      checksum: meta.checksum,
                      fromName: fromUser,
                      received: 0,
                      chunks: [],
                      startTime: Date.now(),
                      speed: 0,
                      connected: true
                    }
                    recvStateRef.current = newState
                    setReceiving(newState)
                    return
                  }
                }
              } catch (_) {}

              if (recvStateRef.current) {
                const current = recvStateRef.current
                current.chunks.push(buffer)
                current.received += buffer.byteLength
                const now = Date.now()
                const elapsed = (now - current.startTime) / 1000
                current.speed = elapsed > 0 ? current.received / elapsed : 0
                setReceiving({ ...current })

                if (current.received >= current.size) {
                  const blob = new Blob(current.chunks, { type: current.mime })
                  const receivedDigest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
                  const receivedChecksum = Array.from(new Uint8Array(receivedDigest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
                  if (current.checksum && receivedChecksum !== current.checksum) {
                    setError('Berkas rusak saat transfer. Pengiriman dibatalkan.')
                    return
                  }
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = current.name
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                  URL.revokeObjectURL(url)

                  audioRef.current.play().catch(() => {})
                  setNotify({ type: 'success', message: `Berkas "${current.name}" diterima utuh tanpa kompresi` })
                  setHistory(h => [{ name: current.name, size: current.size, peer: current.fromName, time: Date.now(), type: 'received' }, ...h].slice(0, 20))

                  setTimeout(() => {
                    if (peerRef.current) {
                      peerRef.current.destroy()
                      peerRef.current = null
                    }
                    recvStateRef.current = null
                    setReceiving(null)
                  }, 1000)
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
    })

    return () => { socket.off('users'); socket.off('signal') }
  }, [])

  const join = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    console.log('Joining with name:', name.trim())
    socket.emit('join', name.trim())
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
      socket.emit('signal', { to: selected.id, signal })
    })

    let connectTimeout
    peer.on('connect', async () => {
      console.log('[peer] connected, sending meta...')
      clearTimeout(connectTimeout)
      setSending(s => s ? { ...s, connected: true } : s)

      try {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
        const checksum = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
        const meta = JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type, checksum })
        peer.send(meta)

        const chunkSize = 64 * 1024
        let offset = 0
        const startTime = Date.now()
        let sendTimeout = null

        const send = async () => {
          if (!peer || !peer.connected) return
          const chunk = file.slice(offset, offset + chunkSize)
          const buffer = await chunk.arrayBuffer()
          if (!peer.connected) return
          peer.send(buffer)
          offset += buffer.byteLength
          const elapsed = (Date.now() - startTime) / 1000
          const speed = elapsed > 0 ? offset / elapsed : 0
          setSending(s => s ? { ...s, sent: offset, speed } : s)
          if (offset < file.size) {
            setTimeout(send, peer.bufferSize > chunkSize * 8 ? 40 : 0)
          } else {
            setHistory(h => [{ name: file.name, size: file.size, peer: selected.name, time: Date.now(), type: 'sent' }, ...h].slice(0, 20))
            setNotify({ type: 'success', message: `Berkas "${file.name}" terkirim ke ${selected.name}` })
            setTimeout(() => {
              if (peer) peer.destroy()
              peerRef.current = null
              setSending(null)
            }, 2000)
          }
        }
        const startSend = () => { sendTimeout = setTimeout(send, 200) }
        startSend()
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
  </main>
}
