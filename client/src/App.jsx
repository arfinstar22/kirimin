import { useEffect, useRef, useState, useCallback } from 'react'
import Peer from 'simple-peer-light'
import './index.css'
import { saveReceivedFile, getAllReceivedFiles, getReceivedFile, markDownloaded, deleteReceivedFile } from './storage/fileStore'

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
const MAX_PEER_RETRIES = 1
const PEER_CONNECT_TIMEOUT = 40000

async function logIceStats(peer, label) {
  if (!import.meta.env.DEV) return
  const pc = peer?._pc
  if (!pc) return
  try {
    const stats = await pc.getStats()
    let pairFound = false
    stats.forEach(report => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        pairFound = true
        const local = stats.get(report.localCandidateId)
        const remote = stats.get(report.remoteCandidateId)
        console.log(`[ICE STATS] ${label}: pair state=${report.state} protocol=${report.protocol || 'udp'} local=${local?.candidateType || 'unknown'} remote=${remote?.candidateType || 'unknown'}`)
      }
    })
    if (!pairFound) {
      console.log(`[ICE STATS] ${label}: no successful candidate pair found`)
    }
  } catch(e) {
    console.error(`[ICE STATS] ${label}: failed to get stats`, e)
  }
}

function attachIceDiagnostics(peer, role) {
  if (!import.meta.env.DEV) return
  try {
    const pc = peer._pc
    if (!pc) return
    pc.addEventListener('icegatheringstatechange', () => {
      console.log(`[ICE] ${role} gathering: ${pc.iceGatheringState}`)
    })
    pc.addEventListener('iceconnectionstatechange', () => {
      console.log(`[ICE] ${role} connection: ${pc.iceConnectionState}`)
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        logIceStats(peer, role)
      }
    })
    if (typeof pc.connectionState === 'string') {
      pc.addEventListener('connectionstatechange', () => {
        console.log(`[ICE] ${role} connection-state: ${pc.connectionState}`)
        if (pc.connectionState === 'connected' || pc.connectionState === 'completed') {
          logIceStats(peer, role)
        }
      })
    }
    pc.addEventListener('icecandidateerror', (e) => {
      console.log(`[ICE] ${role} candidate-error: host=${e.hostCandidate ?? ''} url=${e.url ?? ''} code=${e.errorCode ?? ''} text=${e.errorText ?? ''}`)
    })
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) return
      const type = e.candidate.type === 'srflx' ? 'srflx' : e.candidate.type === 'relay' ? 'relay' : (e.candidate.address?.includes('.local') ? 'mdns/host' : e.candidate.type || 'host')
      console.log(`[ICE] ${role} candidate: ${type}`)
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
function IconRefresh() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M23 4v6h-6M1 20v-6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
function IconBell() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width="20" height="20">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
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
function initials(value) {
  return value.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()
}
function formatTime(time) {
  return new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(time)
}
function formatRelativeTime(epoch) {
  const now = Date.now()
  const diff = now - epoch
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'Baru diterima'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} menit lalu`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} jam lalu`
  const d = Math.floor(h / 24)
  return `${d} hari lalu`
}

export default function App() {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  const [dark, setDark] = useState(prefersDark)
  const savedName = typeof window !== 'undefined' ? sessionStorage.getItem('kirimin_username') : null
  const isAuthenticated = typeof window !== 'undefined' ? sessionStorage.getItem('kirimin_authenticated') === 'true' : false
  const [name, setName] = useState(savedName || '')
  const [pin, setPin] = useState('')
  const [loginError, setLoginError] = useState('')
  const [joined, setJoined] = useState(isAuthenticated && !!savedName)
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
  const [showNotifications, setShowNotifications] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState('')
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef(null)
  const shouldReconnectRef = useRef(true)
  const nameRef = useRef(name)
  const socketIdRef = useRef(socketId)
  const backpressureTimerRef = useRef(null)
  const turnServersRef = useRef([])
  const forceLogoutReceivedRef = useRef(false)
  const profileContainerRef = useRef(null)
  const notificationWrapRef = useRef(null)

  const loadReceivedFiles = useCallback(async () => {
    try {
      const files = await getAllReceivedFiles()
      const sorted = [...files].sort((a, b) => b.receivedAt - a.receivedAt)
      setReceivedFiles(sorted)
    } catch (err) {
      if (import.meta.env.DEV) console.error('[store] failed to load received files:', err)
    }
  }, [])

  useEffect(() => {
    loadReceivedFiles()
  }, [loadReceivedFiles])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (profileContainerRef.current && !profileContainerRef.current.contains(event.target)) {
        setShowProfile(false)
      }
      if (notificationWrapRef.current && !notificationWrapRef.current.contains(event.target)) {
        setShowNotifications(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!joined) return

    const fetchTurn = async () => {
      try {
        const turnUrl = SIGNALING_URL.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/ws$/, '')
        const turnRes = await fetch(`${turnUrl}/turn`, { method: 'POST' })
        if (turnRes.ok) {
          const data = await turnRes.json()
          if (data && data.iceServers) turnServersRef.current = [data.iceServers]
        }
        // 501 / failure: TURN unavailable — app stays online, STUN/direct P2P used
      } catch (err) {
        if (import.meta.env.DEV) console.error('[turn] TURN tidak tersedia, fallback ke STUN/direct:', err)
      }
    }
    fetchTurn()
  }, [joined])

  useEffect(() => {
    nameRef.current = name
  }, [name])

  useEffect(() => {
    socketIdRef.current = socketId
  }, [socketId])

  useEffect(() => {
    if (!joined) return

    const MAX_RECONNECT_DELAY = 30000
    const BASE_DELAY = 1000
    let receiverConnectTimeout = null
    let receiverRetryCount = 0

    const clearReceiverConnectTimeout = () => {
      if (receiverConnectTimeout) {
        clearTimeout(receiverConnectTimeout)
        receiverConnectTimeout = null
      }
    }

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

      if (forceLogoutReceivedRef.current) return

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
        if (forceLogoutReceivedRef.current) {
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
              const peer = new Peer({
                ...PEER_CONFIG,
                config: {
                  ...PEER_CONFIG.config,
                  iceServers: [...PEER_CONFIG.config.iceServers, ...turnServersRef.current]
                }
              })
              receiverPeerRef.current = peer
              attachIceDiagnostics(peer, 'receiver')
              const failReceiverPeer = (reason) => {
                if (receiverPeerRef.current !== peer || peer.destroyed) return
                clearReceiverConnectTimeout()
                receiverPeerRef.current = null
                peer.destroy()
                if (receiverRetryCount < MAX_PEER_RETRIES && !recvStateRef.current) {
                  receiverRetryCount += 1
                  if (import.meta.env.DEV) console.warn(`[peer] receiver retry ${receiverRetryCount}:`, reason)
                  return
                }
                setError('Koneksi perangkat gagal. Silakan coba lagi.')
                if (recvStateRef.current?.fromName === fromUser) {
                  recvStateRef.current = null
                  setReceiving(null)
                }
              }

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
                clearReceiverConnectTimeout()
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
                if (!recvStateRef.current) {
                  failReceiverPeer(errCode)
                  return
                }
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
                if (!recvStateRef.current) {
                  failReceiverPeer('close')
                  return
                }
                receiverPeerRef.current = null
                if (recvStateRef.current?.fromName === fromUser) {
                  recvStateRef.current = null
                  setReceiving(null)
                }
              })

              clearReceiverConnectTimeout()
              receiverConnectTimeout = setTimeout(() => {
                failReceiverPeer('timeout')
              }, PEER_CONNECT_TIMEOUT)
            }
            if (receiverPeerRef.current && !receiverPeerRef.current.destroyed) {
              receiverPeerRef.current.signal(signal)
            } else if (!receiverPeerRef.current && !recvStateRef.current && !receiverCompleted) {
              receiverRetryCount = 0
            }
          } catch (err) {
            if (import.meta.env.DEV) console.error('[signal] error:', err)
          }
        } else if (message.type === 'error') {
          if (import.meta.env.DEV) console.error('[ws] error:', message.message)
          setError(message.message)
        } else if (message.type === 'force_logout') {
          if (import.meta.env.DEV) console.log('[ws] force logout by admin')
          forceLogoutReceivedRef.current = true
          shouldReconnectRef.current = false
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current)
            reconnectTimerRef.current = null
          }
          sessionStorage.removeItem('kirimin_username')
          sessionStorage.removeItem('kirimin_authenticated')
          setName('')
          setJoined(false)
          setWsState('disconnected')
          setUsers([])
          setSocketId(null)
          if (wsRef.current) {
            wsRef.current.close(4001, 'Force logout')
          }
        } else if (message.type === 'renamed') {
          if (import.meta.env.DEV) console.log('[ws] renamed to:', message.name)
          setName(message.name)
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

      try {
        await saveReceivedFile({
          name: state.name,
          size: state.size,
          type: state.mime,
          sender: state.fromName,
          blob
        })
        setReceivedFiles(prev => {
          const list = [...prev]
          return list
        })
        loadReceivedFiles()
        setNotify({ type: 'info', message: `Berkas "${state.name}" diterima. Tersimpan di notifikasi.` })
        setHistory(h => [{ name: state.name, size: state.size, peer: state.fromName, time: Date.now(), type: 'received' }, ...h].slice(0, 20))
        audioRef.current.play().catch(() => {})
        receiverCompleted = true
      } catch (err) {
        if (import.meta.env.DEV) console.error('[file] failed to save to store:', err)
        setNotify({ type: 'error', message: `Gagal menyimpan berkas "${state.name}".` })
      }

      setReceiving(null)
      if (receiverPeerRef.current) {
        receiverPeerRef.current.destroy()
        receiverPeerRef.current = null
      }
      recvStateRef.current = null
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

      clearReceiverConnectTimeout()

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

  const join = async (e) => {
    e.preventDefault()
    if (!name.trim()) return
    if (!pin.trim()) {
      setLoginError('PIN harus diisi.')
      return
    }
    setLoginError('')
    try {
      const baseUrl = SIGNALING_URL.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/ws$/, '')
      const loginRes = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin.trim() })
      })
      const loginData = await loginRes.json().catch(() => null)
      if (!loginRes.ok || !loginData?.ok) {
        setLoginError('PIN salah. Silakan coba lagi.')
        return
      }
    } catch (err) {
      setLoginError('Tidak dapat terhubung ke server. Silakan coba lagi.')
      return
    }
    forceLogoutReceivedRef.current = false
    shouldReconnectRef.current = true
    sessionStorage.setItem('kirimin_username', name.trim())
    sessionStorage.setItem('kirimin_authenticated', 'true')
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

    const transfer = { name: file.name, size: file.size, sent: 0, connected: false, startTime: Date.now(), speed: 0 }
    setSending(transfer)
    setError(null)

    let connectTimeout = null
    let retryCount = 0
    let activePeer = null
    let settled = false
    let connected = false
    let transferDone = false
    let transferStarted = false

    const clearConnectTimeout = () => {
      if (connectTimeout) {
        clearTimeout(connectTimeout)
        connectTimeout = null
      }
    }

    const cleanupPeer = (peer) => {
      clearConnectTimeout()
      if (senderPeerRef.current === peer) senderPeerRef.current = null
      if (peer && !peer.destroyed) peer.destroy()
    }

    const finish = (success) => {
      if (settled) return
      settled = true
      clearConnectTimeout()
      if (backpressureTimerRef.current) {
        clearTimeout(backpressureTimerRef.current)
        backpressureTimerRef.current = null
      }
      if (activePeer) cleanupPeer(activePeer)
      setSending(null)
      resolve(success)
    }

    const failBeforeConnect = (peer, message) => {
      if (senderPeerRef.current !== peer || settled || connected || transferStarted) return
      cleanupPeer(peer)
      if (retryCount < MAX_PEER_RETRIES) {
        retryCount += 1
        if (import.meta.env.DEV) console.warn(`[peer] sender retry ${retryCount}:`, message)
        createPeerWithTimeout()
        return
      }
      setError('Koneksi perangkat gagal. Silakan coba lagi.')
      finish(false)
    }

    const createPeerWithTimeout = () => {
      if (settled) return
      const peer = new Peer({
        ...PEER_CONFIG,
        initiator: true,
        config: {
          ...PEER_CONFIG.config,
          iceServers: [...PEER_CONFIG.config.iceServers, ...turnServersRef.current]
        }
      })
      activePeer = peer
      senderPeerRef.current = peer
      attachIceDiagnostics(peer, 'sender')

      peer.on('signal', (signal) => {
        if (senderPeerRef.current !== peer || peer.destroyed) return
        if (import.meta.env.DEV) console.log('[peer] offering, type:', signal?.type)
        if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({ type: signal.type === 'candidate' ? 'ice-candidate' : (signal.type || 'ice-candidate'), target: recipient.id, data: signal }))
        }
      })

      peer.on('connect', async () => {
        if (senderPeerRef.current !== peer || peer.destroyed || settled) return
        connected = true
        clearConnectTimeout()
        if (import.meta.env.DEV) console.log('[peer] connected, waiting for channel ready...')
        setSending(s => s ? { ...s, connected: true } : s)

        try {
          const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
          const checksum = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
          const meta = JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mime: file.type, checksum })
          if (import.meta.env.DEV) console.log('[file] sending meta:', { name: file.name, size: file.size, mime: file.type })
          peer.send(meta)
          transferStarted = true

          await new Promise(r => setTimeout(r, 100))

          const chunkSize = 16 * 1024
          const maxBufferedAmount = 256 * 1024
          const PROGRESS_UPDATE_BYTES = 1024 * 1024
          let offset = 0
          let chunkCount = 0
          let lastProgressUpdate = 0
          const startTime = Date.now()

          const send = async () => {
            if (senderPeerRef.current !== peer || settled) return
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
            if (senderPeerRef.current !== peer || settled) return
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

      peer.on('error', (err) => {
        if (senderPeerRef.current !== peer || settled || transferDone) return
        if (import.meta.env.DEV) console.error('[peer] error:', err?.code || err?.name || 'unknown')
        if (!connected && !transferStarted) {
          failBeforeConnect(peer, 'error')
          return
        }
        setError('Gagal terhubung. Coba lagi.')
        finish(false)
      })

      peer.on('close', () => {
        if (senderPeerRef.current !== peer || settled || transferDone) return
        if (import.meta.env.DEV) console.log('[peer] closed')
        if (!connected && !transferStarted) {
          failBeforeConnect(peer, 'close')
          return
        }
        finish(false)
      })

      connectTimeout = setTimeout(() => {
        failBeforeConnect(peer, 'timeout')
      }, PEER_CONNECT_TIMEOUT)
    }

    createPeerWithTimeout()
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

  const handleLogout = () => {
    // Stop reconnection attempts
    shouldReconnectRef.current = false
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    // Close WebSocket safely
    if (wsRef.current) {
      wsRef.current.close(4000, 'Manual logout')
    }
    // Clear session storage
    sessionStorage.removeItem('kirimin_username')
    sessionStorage.removeItem('kirimin_authenticated')
    // Reset UI and login state
    setName('')
    setPin('')
    setLoginError('')
    setJoined(false)
    setWsState('disconnected')
    setUsers([])
    setSocketId(null)
    setShowProfile(false)
    setShowNotifications(false)
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

  const downloadFile = async (file) => {
    try {
      const record = await getReceivedFile(file.id)
      if (!record || !record.blob) {
        setNotify({ type: 'error', message: 'Berkas tidak ditemukan.' })
        return
      }
      const url = URL.createObjectURL(record.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = record.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      await markDownloaded(record.id)
      loadReceivedFiles()
    } catch (err) {
      if (import.meta.env.DEV) console.error('[file] download failed:', err)
      setNotify({ type: 'error', message: 'Gagal mengunduh berkas.' })
    }
  }

  const deleteFile = async (file) => {
    if (!window.confirm(`Hapus "${file.name}" dari notifikasi?`)) return
    try {
      await deleteReceivedFile(file.id)
      loadReceivedFiles()
    } catch (err) {
      if (import.meta.env.DEV) console.error('[file] delete failed:', err)
      setNotify({ type: 'error', message: 'Gagal menghapus berkas.' })
    }
  }

  const undownloadedCount = receivedFiles.filter(f => !f.downloaded).length

  if (!joined) return <main className={`login ${dark ? 'dark' : ''}`}>
    <header className="login-header"><div className="brand-group"><Logo dark={dark} /></div><ThemeToggle dark={dark} onClick={() => setDark(d => !d)} /></header>
    <div className="login-shell">
      <div className="login-kicker"><span className="kicker-dot" /> Berbagi langsung, lebih sederhana</div>
      <h1>Kirim berkas<br /><em>tanpa perantara.</em></h1>
      <p>Transfer file langsung dari browser ke browser. Cepat, aman, tanpa menyimpan file di server.</p>
      <form onSubmit={join}>
        <label htmlFor="display-name">Nama Anda</label>
        <input id="display-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Masukkan nama Anda" maxLength="32" autoComplete="off" />
        <label htmlFor="display-pin">PIN</label>
        <input id="display-pin" type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="Masukkan PIN" maxLength="8" autoComplete="off" />
        {loginError && <div className="login-error">{loginError}</div>}
        <button type="submit">Mulai Berbagi <span>→</span></button>
      </form>
      <div className="trust-row"><span><IconCheck /> P2P langsung</span><span><IconCheck /> Tanpa upload server</span><span><IconCheck /> Gratis digunakan</span></div>
    </div>
    <div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" />
    <footer className="site-footer"><span>Kirimin — Berbagi Berkas Langsung</span></footer>
  </main>

  const sentPercent = sending ? Math.min(100, Math.round((sending.sent / sending.size) * 100)) : 0
  const recvPercent = receiving ? Math.min(100, Math.round((receiving.received / receiving.size) * 100)) : 0
  const sendSpeed = sending ? formatSpeed(sending.speed || 0) : ''
  const recvSpeed = receiving ? formatSpeed(receiving.speed || 0) : ''
  const sendETA = (sending && sending.speed > 0 && sending.sent < sending.size) ? Math.ceil((sending.size - sending.sent) / sending.speed) + 's' : ''
  const recvETA = (receiving && receiving.speed > 0 && receiving.received < receiving.size) ? Math.ceil((receiving.size - receiving.received) / receiving.speed) + 's' : ''

  return <main className={`app ${dark ? 'dark' : ''}`}>
    <header>
       <div className="brand-wrap"><Logo dark={dark} /></div>
      <div className="profile">
        <span className="connection-status">
          <span className={`dot ${wsState === 'connected' ? '' : 'pulse'}`} style={wsState !== 'connected' ? { background: '#e7a43c', boxShadow: '0 0 0 3px rgba(231,164,60,.14)' } : {}} />
          {wsState === 'connected' ? 'Terhubung' : wsState === 'connecting' || wsState === 'reconnecting' ? 'Menghubungkan...' : 'Terputus'}
        </span>
        <div className="profile-container" ref={profileContainerRef}>
          <button className="profile-trigger" onClick={() => { setShowProfile(!showProfile); setShowNotifications(false); }}>
            <span className="name-badge">{initials(name)} <b>{name}</b></span>
          </button>
          {showProfile && (
            <div className="profile-dropdown">
              <div className="dropdown-info"><b>{name}</b><small><span className="dot" /> Online</small></div>
              <button className="dropdown-item" onClick={() => { setShowRename(true); setRenameValue(name); setShowProfile(false); }}><span>✏️</span> Ganti Nama</button>
              <button className="dropdown-item" onClick={handleLogout}><span>🚪</span> Logout</button>
            </div>
          )}
        </div>
        <div className="notification-wrap" ref={notificationWrapRef}>
          <button className="notification-trigger" onClick={() => { setShowNotifications(!showNotifications); setShowProfile(false); }} aria-label="Notifikasi" title="Notifikasi">
            <IconBell hasNew={undownloadedCount > 0} />
            {undownloadedCount > 0 && <span className="notification-badge">{undownloadedCount > 9 ? '9+' : undownloadedCount}</span>}
          </button>
          {showNotifications && receivedFiles.length > 0 && (
            <div className="notification-dropdown">
              <div className="notification-header"><b>Notifikasi</b><span className="notification-count">{receivedFiles.length} berkas</span></div>
              {receivedFiles.map((file) => (
                <div key={file.id} className="notification-item">
                  <div className="notification-file">
                    <span className="notif-file-icon">{file.downloaded ? '🟢' : '🔵'}</span>
                    <div>
                      <b>{file.name}</b>
                      <small>Dari: {file.sender}</small>
                      <small>{formatSize(file.size)} • {formatRelativeTime(file.receivedAt)} • {file.downloaded ? 'Sudah diunduh' : 'Belum diunduh'}</small>
                    </div>
                  </div>
                  <div className="notification-actions">
                    <button className="notif-btn download-btn" onClick={() => downloadFile(file)}>Download</button>
                    <button className="notif-btn delete-btn" onClick={() => deleteFile(file)}>Hapus</button>
                  </div>
                </div>
              ))}
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
          <div className="sidebar-title"><span>Riwayat Transfer</span>{history.length > 0 && <button onClick={clearHistory} className="history-clear" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'normal', letterSpacing: 'normal', padding: 0 }}>Hapus Riwayat</button>}</div>
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
    <footer className="site-footer"><span>Kirimin — Berbagi Berkas Langsung</span></footer>
    {notify && <div className={`toast ${notify.type}`} onClick={() => setNotify(null)}><span><IconCheck /></span>{notify.message}</div>}
    {receivedFiles.length > 0 && (
      <div className="download-panel">
        <div className="download-panel-header"><div><span className="received-check"><IconCheck /></span><div><b>Berkas berhasil diterima</b><small>{receivedFiles.length} berkas tersedia di notifikasi</small></div></div><button onClick={() => { setShowNotifications(false); }} aria-label="Tutup panel">×</button></div>
        {receivedFiles.map((file) => (
          <div key={file.id} className="download-item">
            <div className="download-info"><b>{file.name}</b><small>{formatSize(file.size)} · Dari: {file.sender}</small></div>
            <button className="download-btn" onClick={() => downloadFile(file)}>Download <IconDownload /></button>
          </div>
        ))}
        <div className="download-panel-hint">Panel ini akan hilang saat halaman dimuat ulang. Berkas tetap tersimpan di IndexedDB.</div>
      </div>
    )}
  </main>
}
