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
  trickle: true,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  }
}

function attachIceDiagnostics(peer) {
  if (!import.meta.env.DEV) return
  try {
    const pc = peer._pc
    if (!pc) return
    pc.addEventListener('icegatheringstatechange', () => {
      console.log(`[ICE] gathering: ${pc.iceGatheringState}`)
    })
    pc.addEventListener('iceconnectionstatechange', () => {
      console.log(`[ICE] connection: ${pc.iceConnectionState}`)
    })
    if (typeof pc.connectionState === 'string') {
      pc.addEventListener('connectionstatechange', () => {
        console.log(`[ICE] connection-state: ${pc.connectionState}`)
      })
    }
    pc.addEventListener('icecandidateerror', (e) => {
      console.log(`[ICE] candidate-error: host=${e.hostCandidate ?? ''} url=${e.url ?? ''} code=${e.errorCode ?? ''} text=${e.errorText ?? ''}`)
    })
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) return
      const type = e.candidate.type === 'srflx' ? 'srflx' : e.candidate.type === 'relay' ? 'relay' : (e.candidate.address?.includes('.local') ? 'mdns/host' : e.candidate.type || 'host')
      console.log(`[ICE] candidate: ${type}`)
    })
  } catch {
    /* diagnostics best-effort */
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
function IconRefresh() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M23 4v6h-6M1 20v-6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
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
function RefreshButton() {
  return <button className="theme-toggle" onClick={() => window.location.reload()} aria-label="Refresh aplikasi" title="Refresh aplikasi"><IconRefresh /></button>
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
  const [history, setHistory] = useState(() => {
    try {
      const saved = localStorage.getItem('kirimin_transfer_history')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  const [notify, setNotify] = useState(null)
  const [error, setError] = useState(null)
  const [receivedFiles, setReceivedFiles] = useState([])
  const [socketId, setSocketId] = useState(null)
  const [wsState, setWsState] = useState('disconnected')
  const senderPeerRef = useRef(null)
  const receiverPeerRef = useRef(null)
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
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef(null)
  const shouldReconnectRef = useRef(true)
  const nameRef = useRef(name)
  const socketIdRef = useRef(socketId)
  const backpressureTimerRef = useRef(null)

  useEffect(() => {
    nameRef.current = name
  }, [name])

  useEffect(() => {
    socketIdRef.current = socketId
  }, [socketId])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  useEffect(() => {
    try {
      localStorage.setItem('kirimin_transfer_history', JSON.stringify(history))
    } catch {
      /* history persistence is best-effort; ignore quota/serialization errors */
    }
  }, [history])

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

    const MAX_RECONNECT_DELAY = 30000
    const BASE_DELAY = 1000

    const scheduleReconnect = () => {
      if (!shouldReconnectRef.current) return
      
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      
      const attempt = reconnectAttemptRef.current
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY)
      const jitter = Math.random() * 200
      const finalDelay = delay + jitter

      if (import.meta.env.DEV) console.log(`[ws] reconnect scheduled in ${Math.round(finalDelay)}ms (attempt ${attempt + 1})`)
      setWsState('reconnecting')
      
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        reconnectAttemptRef.current += 1
        connect()
      }, finalDelay)
    }

    const handleSocketClosed = (ws) => {
      if (socketRef.current !== ws) return
      if (import.meta.env.DEV) console.log('[ws] closed or error, cleaning up socket')
      
      socketRef.current = null
      wsRef.current = null
      
      if (shouldReconnectRef.current) {
        scheduleReconnect()
      } else {
        setWsState('disconnected')
      }
    }

    const connect = () => {
      if (!shouldReconnectRef.current) return

      const existing = socketRef.current
      if (existing && (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)) {
        return
      }

      if (import.meta.env.DEV) console.log('[ws] connecting...')
      setWsState('connecting')

      const ws = new WebSocket(SIGNALING_URL)
      socketRef.current = ws
      wsRef.current = ws

      ws.onopen = () => {
        if (socketRef.current !== ws) {
          ws.close()
          return
        }
        if (import.meta.env.DEV) console.log('[ws] connected')
        reconnectAttemptRef.current = 0
        setWsState('connected')
        ws.send(JSON.stringify({ type: 'register', name: nameRef.current }))
      }

      ws.onmessage = (event) => {
        if (socketRef.current !== ws) return
        
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }

        if (message.type === 'registered') {
          if (import.meta.env.DEV) console.log('[ws] registered:', message.id)
          setSocketId(message.id)
        } else if (message.type === 'users') {
          const currentSocketId = socketIdRef.current
          const currentName = nameRef.current
          
          if (import.meta.env.DEV) console.log('[ws] users:', message.users.map(u => u.name))
          const myId = currentSocketId || message.users.find(u => u.name === currentName)?.id
          if (myId) setSocketId(myId)
          setUsers(message.users.filter((u) => u.id !== (myId || currentSocketId)))
        } else if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
          const from = message.from
          const signal = message.data
          if (import.meta.env.DEV) console.log('[signal] from', from, 'type:', signal?.type)
          const fromUser = usersRef.current.find(u => u.id === from)?.name || 'Seseorang'

          try {
            if (message.type === 'answer') {
              if (senderPeerRef.current && !senderPeerRef.current.destroyed) {
                senderPeerRef.current.signal(signal)
              }
              return
            }

            if (message.type === 'ice-candidate') {
              if (senderPeerRef.current && !senderPeerRef.current.destroyed) {
                try { senderPeerRef.current.signal(signal) } catch { /* ignore */ }
              }
              if (receiverPeerRef.current && !receiverPeerRef.current.destroyed) {
                try { receiverPeerRef.current.signal(signal) } catch { /* ignore */ }
              }
              return
            }

            if (!receiverPeerRef.current) {
              const peer = new Peer(PEER_CONFIG)
              receiverPeerRef.current = peer
              attachIceDiagnostics(peer)

              peer.on('signal', (answer) => {
                if (receiverPeerRef.current !== peer || peer.destroyed) return
                if (import.meta.env.DEV) console.log('[peer] answering')
                const s = socketRef.current
                if (s && s.readyState === WebSocket.OPEN) {
                  s.send(JSON.stringify({ type: answer.type === 'candidate' ? 'ice-candidate' : (answer.type || 'ice-candidate'), target: from, data: answer }))
                }
              })

              peer.on('connect', () => {
                if (receiverPeerRef.current !== peer || peer.destroyed) return
                if (import.meta.env.DEV) console.log('[peer] connected!')
                setReceiving(r => r ? { ...r, connected: true } : r)
                setError(null)
              })

              peer.on('data', (data) => {
                if (receiverPeerRef.current !== peer || peer.destroyed) return
                chain = chain.then(async () => {
                  if (typeof data === 'string') {
                    try {
                      const msg = JSON.parse(data)
                      if (msg.type === 'file-meta') {
                        if (import.meta.env.DEV) console.log('[file] meta received:', msg)
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
                        if (import.meta.env.DEV) console.log('[file] end signal received')
                        if (recvStateRef.current) {
                          recvStateRef.current.complete = true
                          await finalizeTransfer()
                        }
                        return
                      }
                    } catch {
                      if (import.meta.env.DEV) console.warn('[file] non-JSON string received, treating as binary')
                    }
                  }

                  if (data instanceof ArrayBuffer || data instanceof Uint8Array || ArrayBuffer.isView(data)) {
                    const chunk = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                    if (recvStateRef.current) {
                      recvStateRef.current.chunks.push(chunk)
                      recvStateRef.current.received += chunk.byteLength
                      
                      const elapsed = (Date.now() - recvStateRef.current.startTime) / 1000
                      recvStateRef.current.speed = elapsed > 0 ? recvStateRef.current.received / elapsed : 0

                      const RECEIVER_PROGRESS_UPDATE_BYTES = 1024 * 1024
                      const received = recvStateRef.current.received
                      const size = recvStateRef.current.size
                      const lastUpdate = recvStateRef.current.lastProgressUpdate || 0
                      if (received - lastUpdate >= RECEIVER_PROGRESS_UPDATE_BYTES || received >= size || recvStateRef.current.complete) {
                        recvStateRef.current.lastProgressUpdate = received
                        setReceiving({ ...recvStateRef.current })
                      }

                      if (recvStateRef.current.received >= recvStateRef.current.size && recvStateRef.current.complete) {
                        await finalizeTransfer()
                      }
                    } else {
                      if (import.meta.env.DEV) console.log('[file] early chunk buffered:', chunk.byteLength)
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
                const errCode = err?.code || err?.name || 'unknown'
                if (import.meta.env.DEV) console.error('[peer] error:', errCode)
                if (receiverCompleted) return
                setError('Gagal terhubung ke penerima. Coba lagi.')
                if (receiverPeerRef.current === peer) {
                  receiverPeerRef.current.destroy()
                  receiverPeerRef.current = null
                }
                if (recvStateRef.current?.fromName === fromUser) {
                  recvStateRef.current = null
                  setReceiving(null)
                }
              })

              peer.on('close', () => {
                if (receiverPeerRef.current !== peer) return
                if (import.meta.env.DEV) console.log('[peer] closed')
                receiverPeerRef.current = null
                if (recvStateRef.current?.fromName === fromUser) {
                  recvStateRef.current = null
                  setReceiving(null)
                }
              })
            }
            if (receiverPeerRef.current && !receiverPeerRef.current.destroyed) {
              receiverPeerRef.current.signal(signal)
            }
          } catch (err) {
            if (import.meta.env.DEV) console.error('[signal] error:', err)
          }
        } else if (message.type === 'error') {
          if (import.meta.env.DEV) console.error('[ws] error:', message.message)
          setError(message.message)
        } else if (message.type === 'renamed') {
          if (import.meta.env.DEV) console.log('[ws] renamed to:', message.name)
          setName(message.name)
          localStorage.setItem('kirimin_username', message.name)
          setShowRename(false)
        }
      }

      ws.onclose = () => {
        handleSocketClosed(ws)
      }

      ws.onerror = () => {
        if (import.meta.env.DEV) console.error('[ws] error')
        handleSocketClosed(ws)
      }
    }

    let chain = Promise.resolve()
    let receiverCompleted = false
    const finalizeTransfer = async () => {
      const state = recvStateRef.current
      if (!state || state.finalized) return
      state.finalized = true

      if (import.meta.env.DEV) console.log('[file] finalizing, total:', state.received, 'expected:', state.size)
      if (state.received < state.size) {
        if (import.meta.env.DEV) console.warn('[file] incomplete:', state.received, '/', state.size)
      }

      const blob = new Blob(state.chunks, { type: state.mime })
      state.chunks = []
      const receivedDigest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      const receivedChecksum = Array.from(new Uint8Array(receivedDigest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (state.checksum && receivedChecksum !== state.checksum) {
        setError('Berkas rusak saat transfer. Pengiriman dibatalkan.')
        recvStateRef.current = null
        setReceiving(null)
        return
      }

      const url = URL.createObjectURL(blob)
      if (import.meta.env.DEV) console.log('[file] download ready:', state.name, 'url:', url)
      urlCacheRef.current.push(url)
      setReceivedFiles(prev => [...prev, { name: state.name, size: state.size, url, time: Date.now() }])
      setNotify({ type: 'success', message: `Berkas "${state.name}" diterima utuh tanpa kompresi` })
      setHistory(h => [{ name: state.name, size: state.size, peer: state.fromName, time: Date.now(), type: 'received' }, ...h].slice(0, 20))
      audioRef.current.play().catch(() => {})
      receiverCompleted = true

      setTimeout(() => {
        if (receiverPeerRef.current) {
          receiverPeerRef.current.destroy()
          receiverPeerRef.current = null
        }
        recvStateRef.current = null
        setReceiving(null)
      }, 1000)
    }

    shouldReconnectRef.current = true
    connect()

    return () => {
      shouldReconnectRef.current = false
      
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      
      if (backpressureTimerRef.current) {
        clearTimeout(backpressureTimerRef.current)
        backpressureTimerRef.current = null
      }
      
      if (senderPeerRef.current) {
        senderPeerRef.current.destroy()
        senderPeerRef.current = null
      }
      if (receiverPeerRef.current) {
        receiverPeerRef.current.destroy()
        receiverPeerRef.current = null
      }

      const ws = socketRef.current
      if (ws) {
        ws.onclose = null
        ws.onerror = null
        ws.onmessage = null
        ws.onopen = null
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
          ws.close()
        }
      }
      socketRef.current = null
      wsRef.current = null
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

    if (senderPeerRef.current) {
      senderPeerRef.current.destroy()
      senderPeerRef.current = null
    }

    const peer = new Peer({
      ...PEER_CONFIG,
      initiator: true
    })
    senderPeerRef.current = peer
    attachIceDiagnostics(peer)

    const transfer = { name: file.name, size: file.size, sent: 0, connected: false, startTime: Date.now(), speed: 0 }
    setSending(transfer)
    setError(null)

    let connectTimeout
    let settled = false
    let transferDone = false
    const finish = (success) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimeout)
      if (backpressureTimerRef.current) {
        clearTimeout(backpressureTimerRef.current)
        backpressureTimerRef.current = null
      }
      if (senderPeerRef.current === peer) {
        peer.destroy()
        senderPeerRef.current = null
      }
      setSending(null)
      resolve(success)
    }

    peer.on('signal', (signal) => {
      if (senderPeerRef.current !== peer || peer.destroyed) return
      if (import.meta.env.DEV) console.log('[peer] offering, type:', signal?.type)
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: signal.type === 'candidate' ? 'ice-candidate' : (signal.type || 'ice-candidate'), target: recipient.id, data: signal }))
      }
    })

    peer.on('connect', async () => {
      if (senderPeerRef.current !== peer || peer.destroyed) return
      if (import.meta.env.DEV) console.log('[peer] connected, waiting for channel ready...')
      clearTimeout(connectTimeout)
      setSending(s => s ? { ...s, connected: true } : s)

      try {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
        const checksum = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
        const meta = JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mime: file.type, checksum })
        if (import.meta.env.DEV) console.log('[file] sending meta:', { name: file.name, size: file.size, mime: file.type })
        peer.send(meta)

        await new Promise(r => setTimeout(r, 100))

        const chunkSize = 16 * 1024
        const maxBufferedAmount = 256 * 1024
        const PROGRESS_UPDATE_BYTES = 1024 * 1024
        let offset = 0
        let chunkCount = 0
        let lastProgressUpdate = 0
        const startTime = Date.now()

        const send = async () => {
          if (!peer.connected) {
            finish(false)
            return
          }

          const bufferedAmount = peer.bufferSize
          if (bufferedAmount > maxBufferedAmount) {
            if (backpressureTimerRef.current) {
              return
            }
            backpressureTimerRef.current = setTimeout(() => {
              backpressureTimerRef.current = null
              send()
            }, 20)
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

          if (chunkCount % 50 === 0 || offset === file.size) if (import.meta.env.DEV) console.log('[file] sent:', offset, '/', file.size)

          if (offset - lastProgressUpdate >= PROGRESS_UPDATE_BYTES || offset >= file.size) {
            const elapsed = (Date.now() - startTime) / 1000
            const speed = elapsed > 0 ? offset / elapsed : 0
            setSending(s => s ? { ...s, sent: offset, speed } : s)
            lastProgressUpdate = offset
          }

          if (offset < file.size) {
            setTimeout(send, 0)
            return
          }

          if (import.meta.env.DEV) console.log('[file] sending complete signal')
          peer.send(JSON.stringify({ type: 'file-end' }))
          transferDone = true
          setHistory(h => [{ name: file.name, size: file.size, peer: recipient.name, time: Date.now(), type: 'sent' }, ...h].slice(0, 20))
          setNotify({ type: 'success', message: `Berkas "${file.name}" terkirim ke ${recipient.name}` })
          setTimeout(() => finish(true), 2000)
        }
        send()
      } catch (err) {
        if (import.meta.env.DEV) console.error('[send] error:', err)
        setError('Gagal mengirim berkas.')
        finish(false)
      }
    })

    connectTimeout = setTimeout(() => {
      setError('Koneksi timeout. Pastikan penerima online dan refresh halaman.')
      finish(false)
    }, 40000)

    peer.on('error', (err) => {
      if (senderPeerRef.current !== peer) return
      if (transferDone) return
      if (import.meta.env.DEV) console.error('[peer] error:', err?.code || err?.name || 'unknown')
      setError('Gagal terhubung. Coba lagi.')
      finish(false)
    })


    peer.on('close', () => {
      if (senderPeerRef.current !== peer || settled) return
      if (import.meta.env.DEV) console.log('[peer] closed')
      finish(false)
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
    const s = socketRef.current
    if (s && s.readyState === WebSocket.OPEN) {
      s.send(JSON.stringify({ type: 'rename', name: newName }))
    } else {
      setRenameError('Belum terhubung ke server')
    }
  }

  const clearHistory = () => {
    if (window.confirm('Hapus semua riwayat transfer?')) {
      localStorage.removeItem('kirimin_transfer_history')
      setHistory([])
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
        <span className="connection-status">
          <span className={`dot ${wsState === 'connected' ? '' : 'pulse'}`} style={wsState !== 'connected' ? { background: '#e7a43c', boxShadow: '0 0 0 3px rgba(231,164,60,.14)' } : {}} />
          {wsState === 'connected' ? 'Terhubung' : wsState === 'connecting' || wsState === 'reconnecting' ? 'Menghubungkan...' : 'Terputus'}
        </span>
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
        <RefreshButton />
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
          <div className="sidebar-title"><span>Riwayat Transfer</span>{history.length > 0 && <button onClick={clearHistory} className="history-clear" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'none', letterSpacing: 'normal', padding: 0 }}>Hapus Riwayat</button>}</div>
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