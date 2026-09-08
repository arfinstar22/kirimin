import { useEffect, useRef, useState, useCallback } from 'react'
import Peer from 'simple-peer-light'
import { sha256Hex } from './sha256'
import './index.css'
import { saveReceivedFile, getAllReceivedFiles, getReceivedFile, markDownloaded, deleteReceivedFile } from './storage/fileStore'

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'wss://kirimin-signaling.darfinstar.workers.dev/ws'

const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
const formatSpeed = (bps) => `${formatSize(bps)}/s`

const generateId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

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

const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
]

const MAX_PEER_RETRIES = 2
const PEER_CONNECT_TIMEOUT = 25000
const WS_CHUNK_SIZE = 32 * 1024
const WS_TRANSFER_TIMEOUT = 180000

async function logIceStats(peer, label) {
  const pc = peer?._pc
  if (!pc) return
  try {
    const stats = await pc.getStats()
    let pairFound = false
    stats.forEach(report => {
      if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.selected || report.nominated)) {
        pairFound = true
        const local = stats.get(report.localCandidateId)
        const remote = stats.get(report.remoteCandidateId)
        const localType = local?.candidateType || local?.type || 'unknown'
        const remoteType = remote?.candidateType || remote?.type || 'unknown'
        console.log(`[ICE] selected candidate pair (${label}): state=${report.state} protocol=${report.protocol || 'udp'} local=${localType} remote=${remoteType}`)
        if (localType === 'relay' || remoteType === 'relay') {
          console.log(`[ICE] TURN relay active (${label})`)
        } else {
          console.log(`[ICE] direct P2P active (${label}: ${localType} <-> ${remoteType})`)
        }
      }
    })
    if (!pairFound) {
      console.log(`[ICE] no active candidate pair yet (${label})`)
    }
  } catch (e) {
    console.warn(`[ICE] failed to get stats (${label}):`, e?.message || e)
  }
}

function attachIceDiagnostics(peer, role) {
  try {
    const pc = peer._pc
    if (!pc) return

    let hostFound = false
    let srflxFound = false
    let relayFound = false

    pc.addEventListener('icegatheringstatechange', () => {
      console.log(`[ICE] gathering state: ${pc.iceGatheringState} (${role})`)
      if (pc.iceGatheringState === 'complete') {
        console.log(`[ICE] gathering complete (${role}): host=${hostFound} srflx=${srflxFound} relay=${relayFound}`)
        if (relayFound) {
          console.log(`[ICE] relay candidate discovered (${role})`)
        }
        logIceStats(peer, role)
      }
    })

    pc.addEventListener('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState
      console.log(`[ICE] connection state: ${state} (${role})`)
      if (state === 'checking') {
        console.log(`[ICE] checking (${role})`)
      } else if (state === 'connected') {
        console.log(`[ICE] connected (${role})`)
        logIceStats(peer, role)
      } else if (state === 'completed') {
        console.log(`[ICE] completed (${role})`)
        logIceStats(peer, role)
      } else if (state === 'failed') {
        console.log(`[ICE] failed (${role})`)
      } else if (state === 'disconnected') {
        console.log(`[ICE] disconnected (${role})`)
      }
    })

    pc.addEventListener('signalingstatechange', () => {
      console.log(`[WEBRTC] signaling state: ${pc.signalingState} (${role})`)
    })

    if (typeof pc.connectionState === 'string') {
      pc.addEventListener('connectionstatechange', () => {
        console.log(`[WEBRTC] connection state: ${pc.connectionState} (${role})`)
        if (pc.connectionState === 'connected') {
          console.log(`[WEBRTC] peer connected (${role})`)
        } else if (pc.connectionState === 'disconnected') {
          console.log(`[WEBRTC] peer disconnected (${role})`)
        } else if (pc.connectionState === 'closed') {
          console.log(`[WEBRTC] peer closed (${role})`)
        } else if (pc.connectionState === 'failed') {
          console.log(`[WEBRTC] peer error (${role})`)
        }
      })
    }

    pc.addEventListener('icecandidateerror', (e) => {
      console.warn(`[ICE] candidate error (${role}): url=${e.url ?? 'none'} code=${e.errorCode ?? 'none'} text=${e.errorText ?? 'none'}`)
    })

    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) {
        console.log(`[ICE] gathering end (null candidate) (${role})`)
        return
      }
      const type = e.candidate.type || 'unknown'
      if (type === 'relay') relayFound = true
      else if (type === 'srflx') srflxFound = true
      else if (type === 'host') hostFound = true

      const proto = e.candidate.protocol || 'udp'
      console.log(`[ICE] candidate: type=${type} protocol=${proto} (${role})`)
    })

    // Safe addIceCandidate wrapper to protect simple-peer-light from ERR_ADD_ICE_CANDIDATE destruction
    const origAddIceCandidate = pc.addIceCandidate.bind(pc)
    pc.addIceCandidate = async function (candidate) {
      try {
        const res = await origAddIceCandidate(candidate)
        return res
      } catch (err) {
        console.warn(`[ICE] non-fatal candidate error ignored (${role}):`, err?.message || err)
        return Promise.resolve()
      }
    }
  } catch (err) {
    console.warn('[WEBRTC] diagnostics attachment failed:', err)
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

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

function formatDate(timestamp) {
  const date = new Date(timestamp)
  return date.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
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
  const [sendingFiles, setSendingFiles] = useState([])
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
  const [showFileManager, setShowFileManager] = useState(false)
  const [fileSearchQuery, setFileSearchQuery] = useState('')
  const senderPeerRef = useRef(null)
  const senderPeerTargetRef = useRef(null)
  const receiverPeerRef = useRef(null)
  const receiverPeerSourceRef = useRef(null)
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
  const [showDownloadPanel, setShowDownloadPanel] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState('')
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef(null)
  const shouldReconnectRef = useRef(true)
  const nameRef = useRef(name)
  const socketIdRef = useRef(socketId)
  const forceLogoutReceivedRef = useRef(false)
  const profileContainerRef = useRef(null)
  const notificationWrapRef = useRef(null)
  const [chatOpen, setChatOpen] = useState(null)
  const chatOpenRef = useRef(null)
  const [chatMessages, setChatMessages] = useState({})
  const [chatInput, setChatInput] = useState('')
  const [unreadCount, setUnreadCount] = useState({})
  const chatContainerRef = useRef(null)
  const chatFileInputRef = useRef(null)
  const [typingUsers, setTypingUsers] = useState({})
  const typingTimeoutsRef = useRef({})
  const typingTimerRef = useRef(null)
  const typingStateRef = useRef({ active: false, recipientId: null })
  const turnServersRef = useRef([])
  const pendingIceCandidatesRef = useRef({})
  const transferCancelRefs = useRef({})
  const wsTransferSessionsRef = useRef(new Map())
  const completedSessionsRef = useRef(new Set())

  const loadReceivedFiles = useCallback(async () => {
    try {
      const files = await getAllReceivedFiles()
      const sorted = [...files].sort((a, b) => b.receivedAt - a.receivedAt)
      setReceivedFiles(sorted)
    } catch (err) {
      if (import.meta.env.DEV) console.error('[store] failed to load received files:', err)
    }
  }, [])

  const addSystemMessage = useCallback((userId, type, fileName, fileSize) => {
    if (!userId) return
    setChatMessages(prev => {
      const userMessages = prev[userId] || []
      return {
        ...prev,
        [userId]: [...userMessages, {
          type: 'system',
          systemType: type,
          fileName,
          fileSize,
          timestamp: Date.now()
        }]
      }
    })
    if (chatOpenRef.current !== userId) {
      setUnreadCount(prev => ({
        ...prev,
        [userId]: (prev[userId] || 0) + 1
      }))
    }
  }, [])

  const handleFileAccept = useCallback((message) => {
    const sessionId = message.sessionId
    const session = wsTransferSessionsRef.current.get(sessionId)
    if (!session || session.type !== 'send') return

    if (import.meta.env.DEV) console.log('[ws-transfer] send accepted:', sessionId)
    session.accepted = true
  }, [])

  const handleFileChunk = useCallback((message) => {
    const sessionId = message.sessionId
    if (completedSessionsRef.current.has(sessionId)) return

    const session = wsTransferSessionsRef.current.get(sessionId)
    if (!session || session.type !== 'recv') return

    const elapsed = Date.now() - session.startTime
    if (elapsed > WS_TRANSFER_TIMEOUT) {
      if (import.meta.env.DEV) console.error('[ws-transfer] recv timeout')
      setError('Transfer timeout.')
      setReceiving(null)
      wsTransferSessionsRef.current.delete(sessionId)
      return
    }

    const chunk = Uint8Array.from(atob(message.chunk), c => c.charCodeAt(0))
    session.chunks.push(chunk)
    session.received += chunk.length

    if (session.chunks.length === 1 && import.meta.env.DEV) {
      console.log('[ws-transfer] first chunk received')
    }

    setReceiving(prev => prev ? { ...prev, received: session.received, fallback: true } : null)
  }, [])

  const handleFileComplete = useCallback(async (message) => {
    const sessionId = message.sessionId
    if (completedSessionsRef.current.has(sessionId)) return

    const session = wsTransferSessionsRef.current.get(sessionId)
    if (!session || session.type !== 'recv') return

    completedSessionsRef.current.add(sessionId)
    if (completedSessionsRef.current.size > 100) {
      const first = completedSessionsRef.current.values().next().value
      completedSessionsRef.current.delete(first)
    }

    if (import.meta.env.DEV) console.log('[ws-transfer] complete received:', sessionId)

    if (session.received !== session.fileSize) {
      if (import.meta.env.DEV) console.error('[ws-transfer] size mismatch:', session.received, '!==', session.fileSize)
      setError('Berkas tidak lengkap saat transfer via relay.')
      setReceiving(null)
      wsTransferSessionsRef.current.delete(sessionId)
      return
    }

    if (import.meta.env.DEV) console.log('[ws-transfer] size verified, computing checksum...')
    const blob = new Blob(session.chunks)
    const receivedChecksum = await sha256Hex(blob)

    if (session.checksum && receivedChecksum !== session.checksum) {
      if (import.meta.env.DEV) console.error('[ws-transfer] checksum mismatch')
      setError('Berkas rusak saat transfer via relay. Checksum tidak cocok.')
      setReceiving(null)
      wsTransferSessionsRef.current.delete(sessionId)
      return
    }

    if (import.meta.env.DEV) console.log('[ws-transfer] checksum verified, saving file...')
    try {
      const fromUser = usersRef.current.find(u => u.id === session.from)?.name || 'Seseorang'
      const savedRecord = await saveReceivedFile({
        name: session.fileName,
        size: session.fileSize,
        type: 'application/octet-stream',
        sender: fromUser,
        blob
      })

      setReceivedFiles(prev => [savedRecord, ...prev.filter(f => f.id !== savedRecord.id)])
      await loadReceivedFiles()
      setShowDownloadPanel(true)
      setNotify({ type: 'info', message: `Berkas "${session.fileName}" diterima via relay.` })
      setHistory(h => [{ name: session.fileName, size: session.fileSize, peer: fromUser, time: Date.now(), type: 'received' }, ...h].slice(0, 20))
      audioRef.current.play().catch(() => {})

      addSystemMessage(session.from, 'received', session.fileName, session.fileSize)
      if (import.meta.env.DEV) console.log('[ws-transfer] file saved successfully')
    } catch {
      setNotify({ type: 'error', message: `Gagal menyimpan berkas "${session.fileName}".` })
    }

    setReceiving(null)
    wsTransferSessionsRef.current.delete(sessionId)
  }, [addSystemMessage, loadReceivedFiles])

  const handleFileError = useCallback((message) => {
    const sessionId = message.sessionId
    const session = wsTransferSessionsRef.current.get(sessionId)
    if (!session) return

    if (import.meta.env.DEV) console.error('[ws-transfer] error:', message.error)

    if (session.type === 'recv') {
      setReceiving(null)
    } else if (session.type === 'send') {
      setSendingFiles(prev => prev.map(f =>
        f.id === session.fileId ? { ...f, status: 'failed', error: 'Transfer gagal' } : f
      ))
    }

    wsTransferSessionsRef.current.delete(sessionId)
  }, [])

  const handleFileOffer = useCallback((message) => {
    const sessionId = message.sessionId
    const from = message.from
    const fileName = message.fileName
    const fileSize = message.fileSize
    const checksum = message.checksum

    if (completedSessionsRef.current.has(sessionId)) {
      if (import.meta.env.DEV) console.log('[ws-transfer] ignoring duplicate offer for completed session:', sessionId)
      return
    }

    if (import.meta.env.DEV) console.log('[ws-transfer] offer received:', sessionId, fileName, fileSize, 'from:', from)

    wsTransferSessionsRef.current.set(sessionId, {
      type: 'recv',
      sessionId,
      from,
      fileName,
      fileSize,
      checksum,
      chunks: [],
      received: 0,
      startTime: Date.now()
    })

    setReceiving({
      name: fileName,
      size: fileSize,
      received: 0,
      connected: false,
      fallback: true
    })

    const s = socketRef.current
    if (s && s.readyState === WebSocket.OPEN) {
      if (import.meta.env.DEV) console.log('[ws-transfer] sending accept for:', sessionId)
      s.send(JSON.stringify({
        type: 'file-accept',
        target: from,
        sessionId
      }))
    }
  }, [])

  const sendFileViaWebSocket = useCallback(async (file, recipient, fileId) => {
    const sessionId = generateId()

    if (import.meta.env.DEV) console.log('[ws-transfer] starting via WebSocket relay:', file.name, 'sessionId:', sessionId)

    const checksum = await sha256Hex(file)

    wsTransferSessionsRef.current.set(sessionId, {
      type: 'send',
      sessionId,
      file,
      recipient,
      fileId,
      checksum,
      accepted: false,
      startTime: Date.now()
    })

    const s = socketRef.current
    if (!s || s.readyState !== WebSocket.OPEN) {
      wsTransferSessionsRef.current.delete(sessionId)
      throw new Error('WebSocket not connected')
    }

    if (import.meta.env.DEV) console.log('[ws-transfer] sending offer to:', recipient.id)
    s.send(JSON.stringify({
      type: 'file-offer',
      target: recipient.id,
      sessionId,
      fileName: file.name,
      fileSize: file.size,
      checksum
    }))

    if (import.meta.env.DEV) console.log('[ws-transfer] waiting for accept...')
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        wsTransferSessionsRef.current.delete(sessionId)
        reject(new Error('Timeout waiting for accept'))
      }, 10000)

      const checkAccept = () => {
        const session = wsTransferSessionsRef.current.get(sessionId)
        if (!session) {
          clearTimeout(timeout)
          reject(new Error('Session cancelled'))
          return
        }
        if (session.accepted) {
          clearTimeout(timeout)
          if (import.meta.env.DEV) console.log('[ws-transfer] accept received')
          resolve()
        } else {
          setTimeout(checkAccept, 100)
        }
      }
      checkAccept()
    })

    if (import.meta.env.DEV) console.log('[ws-transfer] accepted, streaming chunks')

    addSystemMessage(recipient.id, 'sent', file.name, file.size)

    const chunkSize = WS_CHUNK_SIZE
    let offset = 0
    const transferStartTime = Date.now()
    let chunksSent = 0

    while (offset < file.size) {
      const session = wsTransferSessionsRef.current.get(sessionId)
      if (!session) {
        throw new Error('Session cancelled during transfer')
      }

      const currentSocket = socketRef.current
      if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
        wsTransferSessionsRef.current.delete(sessionId)
        throw new Error('WebSocket disconnected during transfer')
      }

      const elapsed = Date.now() - session.startTime
      if (elapsed > WS_TRANSFER_TIMEOUT) {
        wsTransferSessionsRef.current.delete(sessionId)
        throw new Error('Transfer timeout')
      }

      // Backpressure: wait if WebSocket buffer is high
      const maxWsBuffered = 256 * 1024
      while (currentSocket.bufferedAmount > maxWsBuffered) {
        await new Promise(r => setTimeout(r, 20))
      }

      const chunk = file.slice(offset, offset + chunkSize)
      const buffer = await chunk.arrayBuffer()
      const uint8 = new Uint8Array(buffer)
      const base64 = btoa(String.fromCharCode(...uint8))

      currentSocket.send(JSON.stringify({
        type: 'file-chunk',
        target: recipient.id,
        sessionId,
        chunk: base64
      }))

      offset += buffer.byteLength
      chunksSent += 1

      if (chunksSent === 1 && import.meta.env.DEV) {
        console.log('[ws-transfer] first chunk sent')
      }

      const transferElapsed = (Date.now() - transferStartTime) / 1000
      const speed = transferElapsed > 0 ? offset / transferElapsed : 0

      setSendingFiles(prev => prev.map(f =>
        f.id === fileId ? { ...f, sent: offset, speed, status: 'sending', fallback: true } : f
      ))

      await new Promise(r => setTimeout(r, 10))
    }

    const finalSocket = socketRef.current
    if (!finalSocket || finalSocket.readyState !== WebSocket.OPEN) {
      wsTransferSessionsRef.current.delete(sessionId)
      throw new Error('WebSocket disconnected before complete')
    }

    if (import.meta.env.DEV) console.log('[ws-transfer] all chunks sent, sending complete')
    finalSocket.send(JSON.stringify({
      type: 'file-complete',
      target: recipient.id,
      sessionId
    }))

    setHistory(h => [{ name: file.name, size: file.size, peer: recipient.name, time: Date.now(), type: 'sent' }, ...h].slice(0, 20))
    setNotify({ type: 'success', message: `Berkas "${file.name}" terkirim via relay ke ${recipient.name}` })

    wsTransferSessionsRef.current.delete(sessionId)
    if (import.meta.env.DEV) console.log('[ws-transfer] transfer complete')
  }, [addSystemMessage])


  const fetchTurnServers = useCallback(async () => {
    try {
      const baseUrl = SIGNALING_URL.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://').replace(/\/ws\/?$/i, '')
      if (import.meta.env.DEV) console.log('[WebRTC] Fetching TURN credentials from:', `${baseUrl}/turn`)
      const res = await fetch(`${baseUrl}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      if (res.ok) {
        const data = await res.json()
        if (data && data.iceServers) {
          const raw = data.iceServers
          const list = Array.isArray(raw) ? raw.flat() : [raw]
          const valid = list.filter(s => s && (s.urls || s.url))
          if (valid.length > 0) {
            turnServersRef.current = valid
            if (import.meta.env.DEV) console.log('[WebRTC] TURN configuration loaded from server:', valid.length, 'servers')
          }
        }
      } else {
        if (import.meta.env.DEV) console.log('[WebRTC] Server /turn returned status:', res.status)
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[WebRTC] Server /turn endpoint unreachable:', err?.message || err)
    }

    if (import.meta.env.VITE_TURN_URL) {
      const rawUrls = import.meta.env.VITE_TURN_URL.split(',').map(u => u.trim()).filter(Boolean)
      const envServer = { urls: rawUrls }
      if (import.meta.env.VITE_TURN_USERNAME) envServer.username = import.meta.env.VITE_TURN_USERNAME
      if (import.meta.env.VITE_TURN_CREDENTIAL) envServer.credential = import.meta.env.VITE_TURN_CREDENTIAL
      turnServersRef.current = [...(turnServersRef.current || []), envServer]
      if (import.meta.env.DEV) console.log('[WebRTC] Loaded TURN from VITE env')
    }
  }, [])

  const getPeerConfig = useCallback((initiator = false) => {
    const rawTurn = turnServersRef.current || []
    const normalizedTurn = rawTurn.map(s => {
      if (!s) return null
      const urls = s.urls || s.url
      if (!urls) return null
      const item = { urls }
      if (s.username) item.username = s.username
      if (s.credential) item.credential = s.credential
      return item
    }).filter(Boolean)

    const iceServers = [...DEFAULT_STUN_SERVERS, ...normalizedTurn]
    return {
      initiator,
      trickle: true,
      config: {
        iceServers,
        iceCandidatePoolSize: 2
      }
    }
  }, [])

  const sendTypingEvent = useCallback((isTyping, recipientId = null) => {
    const targetId = recipientId || chatOpen
    if (!targetId) return
    const s = socketRef.current
    if (!s || s.readyState !== WebSocket.OPEN) return
    s.send(JSON.stringify({
      type: 'typing',
      to: targetId,
      isTyping
    }))
  }, [chatOpen])

  const handleFileOfferRef = useRef(handleFileOffer)
  const handleFileAcceptRef = useRef(handleFileAccept)
  const handleFileChunkRef = useRef(handleFileChunk)
  const handleFileCompleteRef = useRef(handleFileComplete)
  const handleFileErrorRef = useRef(handleFileError)
  const getPeerConfigRef = useRef(getPeerConfig)
  const addSystemMessageRef = useRef(addSystemMessage)
  const loadReceivedFilesRef = useRef(loadReceivedFiles)

  useEffect(() => {
    handleFileOfferRef.current = handleFileOffer
    handleFileAcceptRef.current = handleFileAccept
    handleFileChunkRef.current = handleFileChunk
    handleFileCompleteRef.current = handleFileComplete
    handleFileErrorRef.current = handleFileError
    getPeerConfigRef.current = getPeerConfig
    addSystemMessageRef.current = addSystemMessage
    loadReceivedFilesRef.current = loadReceivedFiles
  })

  const stopTyping = useCallback(() => {
    const state = typingStateRef.current
    if (!state.active) return
    const targetId = state.recipientId
    sendTypingEvent(false, targetId)
    state.active = false
    state.recipientId = null
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
    }
  }, [sendTypingEvent])

  const handleChatInput = useCallback((e) => {
    const value = e.target.value
    setChatInput(value)

    if (!value.trim()) {
      stopTyping()
      return
    }

    if (!typingStateRef.current.active) {
      typingStateRef.current.active = true
      typingStateRef.current.recipientId = chatOpen
      sendTypingEvent(true)
    }

    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    typingTimerRef.current = setTimeout(() => {
      stopTyping()
    }, 1500)
  }, [chatOpen, sendTypingEvent, stopTyping])

  const handleDownloadFile = useCallback(async (id) => {
    try {
      const file = await getReceivedFile(id)
      if (!file) return

      const url = URL.createObjectURL(file.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      await markDownloaded(id)
      await loadReceivedFiles()
    } catch (err) {
      if (import.meta.env.DEV) console.error('[files] download failed:', err)
    }
  }, [loadReceivedFiles])

  const handleDeleteFile = useCallback(async (id) => {
    if (!window.confirm('Hapus berkas ini secara permanen?')) return
    try {
      await deleteReceivedFile(id)
      await loadReceivedFiles()
    } catch (err) {
      if (import.meta.env.DEV) console.error('[files] delete failed:', err)
    }
  }, [loadReceivedFiles])

  useEffect(() => {
    let active = true
    getAllReceivedFiles()
      .then(files => {
        if (active) {
          const sorted = [...files].sort((a, b) => b.receivedAt - a.receivedAt)
          setReceivedFiles(sorted)
        }
      })
      .catch(err => {
        if (import.meta.env.DEV) console.error('[store] failed to load received files:', err)
      })
    return () => {
      active = false
    }
  }, [])

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
      if (chatContainerRef.current && !chatContainerRef.current.contains(event.target)) {
        setChatOpen(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    fetchTurnServers()
  }, [fetchTurnServers])

  useEffect(() => {
    const preventDragDefaults = (e) => {
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('dragenter', preventDragDefaults, false)
    window.addEventListener('dragover', preventDragDefaults, false)
    window.addEventListener('dragleave', preventDragDefaults, false)
    window.addEventListener('drop', preventDragDefaults, false)
    return () => {
      window.removeEventListener('dragenter', preventDragDefaults)
      window.removeEventListener('dragover', preventDragDefaults)
      window.removeEventListener('dragleave', preventDragDefaults)
      window.removeEventListener('drop', preventDragDefaults)
    }
  }, [])

  useEffect(() => {
    let timer = null
    let lastDate = new Date().toDateString()

    const checkDateAndClear = () => {
      const today = new Date().toDateString()
      if (today !== lastDate) {
        lastDate = today
        setChatMessages({})
      }
    }

    const scheduleMidnightCleanup = () => {
      const now = new Date()
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1)
      const delay = Math.max(1000, nextMidnight.getTime() - now.getTime())

      timer = setTimeout(() => {
        checkDateAndClear()
        scheduleMidnightCleanup()
      }, delay)
    }

    scheduleMidnightCleanup()

    const handleFocusOrVisibility = () => {
      checkDateAndClear()
    }

    window.addEventListener('focus', handleFocusOrVisibility)
    document.addEventListener('visibilitychange', handleFocusOrVisibility)

    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', handleFocusOrVisibility)
      document.removeEventListener('visibilitychange', handleFocusOrVisibility)
    }
  }, [])

  useEffect(() => {
    chatOpenRef.current = chatOpen
  }, [chatOpen])

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
    let receiverCompleted = false

    const clearReceiverConnectTimeout = () => {
      if (receiverConnectTimeout) {
        clearTimeout(receiverConnectTimeout)
        receiverConnectTimeout = null
      }
    }

    const scheduleReconnect = () => {
      if (!shouldReconnectRef.current || forceLogoutReceivedRef.current) return

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }

      const attempt = reconnectAttemptRef.current
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY)
      const jitter = Math.random() * 200
      const finalDelay = delay + jitter

      console.log(`[WS] reconnect scheduled: ${Math.round(finalDelay)}ms (attempt ${attempt + 1})`)
      setWsState('reconnecting')

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        reconnectAttemptRef.current += 1
        connect()
      }, finalDelay)
    }

    const handleSocketClosed = (ws, event) => {
      if (socketRef.current !== ws) return
      console.log('[WS] closed, cleaning up socket')

      socketRef.current = null
      wsRef.current = null

      if (event?.code === 4001 || event?.code === 4000) {
        setWsState('disconnected')
        return
      }

      if (shouldReconnectRef.current && !forceLogoutReceivedRef.current) {
        scheduleReconnect()
      } else {
        setWsState('disconnected')
      }
    }

    const connect = () => {
      if (!shouldReconnectRef.current || forceLogoutReceivedRef.current) return

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }

      const existing = socketRef.current
      if (existing) {
        if (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN) {
          return
        }
        existing.onopen = null
        existing.onmessage = null
        existing.onerror = null
        existing.onclose = null
        try { existing.close() } catch { /* ignore */ }
        socketRef.current = null
        wsRef.current = null
      }

      console.log('[WS] URL:', SIGNALING_URL)
      console.log('[WS] connecting')
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
        console.log('[WS] open')
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
          console.log('[WS] registered:', message.id)
          setSocketId(message.id)
        } else if (message.type === 'users') {
          const currentSocketId = socketIdRef.current
          const currentName = nameRef.current

          if (import.meta.env.DEV) console.log('[ws] users:', message.users.map(u => u.name))
          usersRef.current = message.users || []
          const myId = currentSocketId || message.users.find(u => u.name === currentName)?.id
          if (myId) setSocketId(myId)
          setUsers(message.users.filter((u) => u.id !== (myId || currentSocketId)))
        } else if (message.type === 'typing') {
          const fromId = message.from
          const fromName = message.fromName
          const isTyping = message.isTyping

          if (typingTimeoutsRef.current[fromId]) {
            clearTimeout(typingTimeoutsRef.current[fromId])
            delete typingTimeoutsRef.current[fromId]
          }

          if (isTyping) {
            setTypingUsers(prev => ({
              ...prev,
              [fromId]: {
                name: fromName,
                timestamp: Date.now()
              }
            }))

            typingTimeoutsRef.current[fromId] = setTimeout(() => {
              setTypingUsers(prev => {
                const next = { ...prev }
                delete next[fromId]
                return next
              })
              delete typingTimeoutsRef.current[fromId]
            }, 3000)
          } else {
            setTypingUsers(prev => {
              const next = { ...prev }
              delete next[fromId]
              return next
            })
          }

          return
        } else if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
          const from = message.from
          const signal = message.data
          const fromUser = usersRef.current.find(u => u.id === from)?.name || 'Seseorang'
          console.log(`[WEBRTC] signal received: ${message.type} from ${fromUser}`)

          try {
            if (message.type === 'answer') {
              if (senderPeerRef.current && !senderPeerRef.current.destroyed && senderPeerTargetRef.current === from) {
                console.log(`[WEBRTC] routing answer to sender peer`)
                senderPeerRef.current.signal(signal)
              }
              return
            }

            if (message.type === 'ice-candidate') {
              if (receiverPeerRef.current && !receiverPeerRef.current.destroyed && receiverPeerSourceRef.current === from) {
                console.log('[ICE] candidate received: routed to receiver peer')
                try { receiverPeerRef.current.signal(signal) } catch { /* ignore */ }
                return
              }
              if (senderPeerRef.current && !senderPeerRef.current.destroyed && senderPeerTargetRef.current === from) {
                console.log('[ICE] candidate received: routed to sender peer')
                try { senderPeerRef.current.signal(signal) } catch { /* ignore */ }
                return
              }
              if (from) {
                console.log('[ICE] candidate received: queued for', from)
                const queue = pendingIceCandidatesRef.current[from] || []
                queue.push(signal)
                pendingIceCandidatesRef.current[from] = queue
              }
              return
            }

            if (receiverPeerRef.current) {
              clearReceiverConnectTimeout()
              receiverPeerRef.current.destroy()
              receiverPeerRef.current = null
              receiverPeerSourceRef.current = null
            }

            console.log(`[WEBRTC] creating peer (receiver) for ${fromUser}`)
            console.log('[FILE] incoming transfer')
            console.log('[WEBRTC] peer connection created')
            const peer = new Peer(getPeerConfigRef.current(false))
            receiverPeerRef.current = peer
            receiverPeerSourceRef.current = from
            attachIceDiagnostics(peer, 'receiver')

            let receiverDisconnectTimer = null
            const clearReceiverDisconnectTimer = () => {
              if (receiverDisconnectTimer) {
                clearTimeout(receiverDisconnectTimer)
                receiverDisconnectTimer = null
              }
            }

            const failReceiverPeer = (reason) => {
              if (receiverPeerRef.current !== peer || peer.destroyed) return
              console.warn('[WEBRTC] receiver peer failed:', reason)
              clearReceiverConnectTimeout()
              clearReceiverDisconnectTimer()
              delete pendingIceCandidatesRef.current[from]
              receiverPeerRef.current = null
              receiverPeerSourceRef.current = null
              peer.destroy()
              if (!recvStateRef.current) {
                setError('Koneksi P2P langsung gagal. Perangkat mungkin berada di jaringan yang membatasi koneksi langsung.')
              }
            }

            let receiverConnected = false
            const onReceiverConnect = () => {
              if (receiverConnected || receiverPeerRef.current !== peer || peer.destroyed) return
              receiverConnected = true
              clearReceiverConnectTimeout()
              console.log('[WEBRTC] peer connected')
              console.log('[FILE] data channel OPEN')
              setReceiving(r => r ? { ...r, connected: true } : r)
              setError(null)
            }

            peer.on('connect', onReceiverConnect)

            const pcRecv = peer._pc
            if (pcRecv) {
              pcRecv.addEventListener('datachannel', (e) => {
                if (e.channel) {
                  if (e.channel.readyState === 'open') {
                    onReceiverConnect()
                  } else {
                    e.channel.addEventListener('open', onReceiverConnect, { once: true })
                  }
                }
              })

              pcRecv.addEventListener('iceconnectionstatechange', () => {
                const state = pcRecv.iceConnectionState
                if (receiverPeerRef.current !== peer || peer.destroyed) return
                if (state === 'connected' || state === 'completed') {
                  clearReceiverDisconnectTimer()
                  if (peer._channel?.readyState === 'open') {
                    onReceiverConnect()
                  }
                } else if (state === 'disconnected') {
                  console.log('[ICE] disconnected, waiting 7s grace period for recovery...')
                  clearReceiverDisconnectTimer()
                  receiverDisconnectTimer = setTimeout(() => {
                    if (receiverPeerRef.current === peer && !peer.destroyed && pcRecv.iceConnectionState === 'disconnected') {
                      console.log('[ICE] Disconnect grace period expired without recovery')
                      failReceiverPeer('ice-disconnected-timeout')
                    }
                  }, 7000)
                } else if (state === 'failed') {
                  clearReceiverDisconnectTimer()
                  failReceiverPeer('ice-failed')
                }
              })

              if (typeof pcRecv.connectionState === 'string') {
                pcRecv.addEventListener('connectionstatechange', () => {
                  if (pcRecv.connectionState === 'connected' && peer._channel?.readyState === 'open') {
                    onReceiverConnect()
                  }
                })
              }
            }

            peer.on('signal', (answer) => {
              if (receiverPeerRef.current !== peer || peer.destroyed) return
              const s = socketRef.current
              if (s && s.readyState === WebSocket.OPEN) {
                const type = answer.type === 'candidate' ? 'ice-candidate' : (answer.type || 'ice-candidate')
                console.log(`[WEBRTC] signal sent: ${type} to ${fromUser}`)
                if (type === 'ice-candidate') {
                  console.log(`[ICE] candidate sent: to ${fromUser}`)
                }
                s.send(JSON.stringify({ type, target: from, data: answer }))
              }
            })

              const handleReceiverData = (data) => {
              if (receiverPeerRef.current !== peer || peer.destroyed) return

              if (typeof data === 'string') {
                console.log('[FILE] data event type: string')
                try {
                  const msg = JSON.parse(data)
                  if (msg.type === 'file-meta') {
                    console.log('[FILE] metadata received')
                    const pending = recvStateRef.current?.pendingChunks || []
                    recvStateRef.current = {
                      name: msg.name,
                      size: msg.size,
                      mime: msg.mime || 'application/octet-stream',
                      checksum: msg.checksum,
                      fromName: msg.senderName || fromUser,
                      fromId: msg.senderId || from,
                      received: 0,
                      chunks: [...pending],
                      startTime: Date.now(),
                      speed: 0,
                      connected: true,
                      complete: false,
                      finalized: false
                    }
                    pending.forEach(chunk => {
                      recvStateRef.current.received += chunk.byteLength
                    })
                    setReceiving({ ...recvStateRef.current })
                    return
                  }
                  if (msg.type === 'file-end') {
                    console.log('[FILE] file-end received')
                    if (recvStateRef.current) {
                      recvStateRef.current.complete = true
                      if (recvStateRef.current.received >= recvStateRef.current.size) {
                        console.log('[FILE] all chunks received')
                        finalizeTransfer()
                      }
                    }
                    return
                  }
                } catch (err) {
                  console.warn('[FILE] error parsing text message:', err)
                }
                return
              }

              if (data instanceof ArrayBuffer || data instanceof Uint8Array || ArrayBuffer.isView(data)) {
                console.log('[FILE] data event type: binary')
                const chunk = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                if (!recvStateRef.current) {
                  recvStateRef.current = {
                    pendingChunks: [chunk],
                    name: null, size: null, mime: null, checksum: null,
                    fromName: fromUser, fromId: from, received: chunk.byteLength, chunks: [],
                    startTime: Date.now(), speed: 0, connected: true, complete: false, finalized: false
                  }
                  return
                }

                const state = recvStateRef.current
                state.chunks.push(chunk)
                state.received += chunk.byteLength

                const totalExpectedChunks = state.size ? Math.ceil(state.size / 16384) : '?'
                if (state.chunks.length === 1 || state.chunks.length % 25 === 0 || (state.size != null && state.received >= state.size)) {
                  console.log(`[FILE] chunk received: ${state.chunks.length}/${totalExpectedChunks}`)
                  console.log(`[FILE] received bytes: ${state.received}/${state.size ?? '?'}`)
                }

                const elapsed = (Date.now() - state.startTime) / 1000
                state.speed = elapsed > 0 ? state.received / elapsed : 0

                const RECEIVER_PROGRESS_UPDATE_BYTES = 512 * 1024
                const lastUpdate = state.lastProgressUpdate || 0
                if (state.received - lastUpdate >= RECEIVER_PROGRESS_UPDATE_BYTES || (state.size != null && state.received >= state.size) || state.complete) {
                  state.lastProgressUpdate = state.received
                  setReceiving({ ...state })
                }

                if (state.size != null && state.received >= state.size && state.complete) {
                  console.log('[FILE] all chunks received')
                  finalizeTransfer()
                }
              }
            }

            // Jalur utama simple-peer.
            // Jangan memasang native message listener pada peer._channel
            // karena simple-peer sudah membaca channel tersebut. Listener
            // tambahan akan membuat setiap chunk diproses dua kali.
            peer.on('data', handleReceiverData)

              peer.on('error', (err) => {
                const errCode = err?.code || err?.name || 'unknown'
                console.warn('[WEBRTC] peer error (receiver):', errCode)
                if (receiverCompleted || recvStateRef.current?.finalized) return
                clearReceiverConnectTimeout()
                delete pendingIceCandidatesRef.current[from]
                if (receiverPeerRef.current === peer) {
                  try { receiverPeerRef.current.destroy() } catch { /* ignore */ }
                  receiverPeerRef.current = null
                  receiverPeerSourceRef.current = null
                }
                if (recvStateRef.current && !recvStateRef.current.finalized) {
                  setError('Transfer terputus. Berkas mungkin tidak lengkap.')
                  recvStateRef.current = null
                  setReceiving(null)
                } else if (!receiverCompleted) {
                  setError('Koneksi P2P langsung gagal. Perangkat mungkin berada di jaringan yang membatasi koneksi langsung.')
                }
              })

              peer.on('close', () => {
                console.log('[WEBRTC] peer closed (receiver)')
                if (receiverCompleted || recvStateRef.current?.finalized) return
                if (receiverPeerRef.current !== peer) return
                delete pendingIceCandidatesRef.current[from]
                if (recvStateRef.current && !recvStateRef.current.finalized) {
                  setError('Transfer terputus. Berkas mungkin tidak lengkap.')
                  recvStateRef.current = null
                  setReceiving(null)
                }
                receiverPeerRef.current = null
                receiverPeerSourceRef.current = null
              })

              clearReceiverConnectTimeout()
              receiverConnectTimeout = setTimeout(() => {
                failReceiverPeer('timeout')
              }, PEER_CONNECT_TIMEOUT)

            if (receiverPeerRef.current && !receiverPeerRef.current.destroyed) {
              receiverPeerRef.current.signal(signal)
              const pending = pendingIceCandidatesRef.current[from]
              if (pending && pending.length > 0) {
                if (import.meta.env.DEV) console.log('[signal] flushing', pending.length, 'pending ICE candidates from', from, '→ receiver')
                pending.forEach(cand => {
                  try {
                    if (receiverPeerRef.current && !receiverPeerRef.current.destroyed) {
                      receiverPeerRef.current.signal(cand)
                    }
                  } catch { /* ignore */ }
                })
                delete pendingIceCandidatesRef.current[from]
              }
            } else if (!receiverPeerRef.current && !recvStateRef.current && !receiverCompleted) {
              // receiver not created yet (should not happen)
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
        } else if (message.type === 'chat') {
          if (import.meta.env.DEV) console.log('[chat] received from:', message.fromName)
          const senderId = message.from
          const senderName = message.fromName
          const text = message.message
          const timestamp = message.timestamp

          setChatMessages(prev => {
            const userMessages = prev[senderId] || []
            return {
              ...prev,
              [senderId]: [...userMessages, { from: senderName, text, timestamp, fromId: senderId }]
            }
          })

          if (chatOpenRef.current !== senderId) {
            setUnreadCount(prev => ({
              ...prev,
              [senderId]: (prev[senderId] || 0) + 1
            }))
          }
        } else if (message.type === 'file-offer') {
          if (import.meta.env.DEV) console.log('[ws-transfer] file-offer from:', message.from)
          handleFileOfferRef.current(message)
        } else if (message.type === 'file-accept') {
          if (import.meta.env.DEV) console.log('[ws-transfer] file-accept from:', message.from)
          handleFileAcceptRef.current(message)
        } else if (message.type === 'file-chunk') {
          handleFileChunkRef.current(message)
        } else if (message.type === 'file-complete') {
          if (import.meta.env.DEV) console.log('[ws-transfer] file-complete from:', message.from)
          handleFileCompleteRef.current(message)
        } else if (message.type === 'file-error') {
          if (import.meta.env.DEV) console.log('[ws-transfer] file-error from:', message.from)
          handleFileErrorRef.current(message)
        }
      }

      ws.onclose = (event) => {
        console.log('[WS] close code:', event?.code, 'reason:', event?.reason || 'none')
        handleSocketClosed(ws, event)
      }

      ws.onerror = (err) => {
        console.warn('[WS] error:', err?.message || 'WebSocket encountered an error')
      }
    }

    const finalizeTransfer = async () => {
      const state = recvStateRef.current
      if (!state || state.finalized) return
      state.finalized = true
      receiverCompleted = true
      console.log('[FILE] finalize started')
      if (import.meta.env.DEV) console.log('[file-recv] finalizing, total:', state.received, 'expected:', state.size)

      if (state.size != null && state.received !== state.size) {
        if (import.meta.env.DEV) console.error('[file-recv] size mismatch:', state.received, '!==', state.size)
        setError('Berkas tidak lengkap saat transfer. Pengiriman dibatalkan.')
        recvStateRef.current = null
        setReceiving(null)
        return
      }

      const blob = new Blob(state.chunks, { type: state.mime })
      state.chunks = []
      console.log('[FILE] blob created')
      const receivedChecksum = await sha256Hex(blob)
      if (import.meta.env.DEV) console.log('[file-recv] checksum match:', state.checksum ? receivedChecksum === state.checksum : 'no checksum')
      if (state.checksum && receivedChecksum !== state.checksum) {
        setError('Berkas rusak saat transfer. Checksum SHA-256 tidak cocok.')
        recvStateRef.current = null
        setReceiving(null)
        return
      }
      console.log('[FILE] checksum verified')

      try {
        const savedRecord = await saveReceivedFile({
          name: state.name,
          size: state.size,
          type: state.mime,
          sender: state.fromName,
          blob
        })
        setReceivedFiles(prev => {
          const next = [savedRecord, ...prev.filter(f => f.id !== savedRecord.id)]
          return next
        })
        await loadReceivedFilesRef.current()
        setShowDownloadPanel(true)
        console.log('[FILE] file saved')

        // Send ACK back to sender over DataChannel before cleanup
        if (receiverPeerRef.current && !receiverPeerRef.current.destroyed) {
          try {
            receiverPeerRef.current.send(JSON.stringify({ type: 'file-ack' }))
            console.log('[FILE] ACK sent')
          } catch { /* ignore */ }
        }

        console.log('[FILE] finalize completed')
        console.log('[FILE] transfer completed')
        setNotify({ type: 'info', message: `Berkas "${state.name}" diterima. Tersimpan di notifikasi.` })
        setHistory(h => [{ name: state.name, size: state.size, peer: state.fromName, time: Date.now(), type: 'received' }, ...h].slice(0, 20))
        audioRef.current.play().catch(() => {})

        const senderId = state.fromId || receiverPeerSourceRef.current
        if (senderId) {
          addSystemMessageRef.current(senderId, 'received', state.name, state.size)
        }
      } catch {
        setNotify({ type: 'error', message: `Gagal menyimpan berkas "${state.name}".` })
      }

      setReceiving(null)
      setTimeout(() => {
        if (receiverPeerRef.current) {
          try {
            receiverPeerRef.current.destroy()
          } catch { /* ignore */ }
          receiverPeerRef.current = null
          receiverPeerSourceRef.current = null
        }
        const finalSenderId = state.fromId
        if (finalSenderId) delete pendingIceCandidatesRef.current[finalSenderId]
        recvStateRef.current = null
      }, 1500)
    }

    const handleOnline = () => {
      if (shouldReconnectRef.current && (!socketRef.current || socketRef.current.readyState === WebSocket.CLOSED)) {
        console.log('[WS] online event detected, reconnecting immediately')
        reconnectAttemptRef.current = 0
        connect()
      }
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && shouldReconnectRef.current && (!socketRef.current || socketRef.current.readyState === WebSocket.CLOSED)) {
        console.log('[WS] tab became visible, checking connection')
        connect()
      }
    }

    window.addEventListener('online', handleOnline)
    document.addEventListener('visibilitychange', handleVisibility)

    shouldReconnectRef.current = true
    connect()

    return () => {
      shouldReconnectRef.current = false

      window.removeEventListener('online', handleOnline)
      document.removeEventListener('visibilitychange', handleVisibility)

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }

      clearReceiverConnectTimeout()

      if (senderPeerRef.current) {
        senderPeerRef.current.destroy()
        senderPeerRef.current = null
        senderPeerTargetRef.current = null
      }
      if (receiverPeerRef.current) {
        receiverPeerRef.current.destroy()
        receiverPeerRef.current = null
        receiverPeerSourceRef.current = null
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
    const urls = urlCacheRef.current
    return () => {
      urls.forEach(url => URL.revokeObjectURL(url))
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
    } catch {
      setLoginError('Tidak dapat terhubung ke server. Silakan coba lagi.')
      return
    }
    forceLogoutReceivedRef.current = false
    shouldReconnectRef.current = true
    nameRef.current = name.trim()
    sessionStorage.setItem('kirimin_username', name.trim())
    sessionStorage.setItem('kirimin_authenticated', 'true')
    setJoined(true)
  }

  const cancelFile = useCallback((fileId) => {
    const cancel = transferCancelRefs.current[fileId]
    if (cancel) {
      cancel()
      delete transferCancelRefs.current[fileId]
    }
    setSendingFiles(prev => prev.map(f =>
      f.id === fileId ? { ...f, status: 'cancelled' } : f
    ))
  }, [])

  const sendFile = useCallback((fileId, file, recipient) => new Promise((resolve) => {
    if (!file || !recipient || !fileId) {
      resolve()
      return
    }

    let settled = false

    transferCancelRefs.current[fileId] = () => {
      if (settled) return
      settled = true
      clearConnectTimeout()
      clearDisconnectTimer()
      clearRetryTimer()
      if (senderPeerRef.current) {
        senderPeerRef.current.destroy()
        senderPeerRef.current = null
        senderPeerTargetRef.current = null
      }
      resolve()
    }

    if (senderPeerRef.current) {
      senderPeerRef.current.destroy()
      senderPeerRef.current = null
      senderPeerTargetRef.current = null
    }

    setSendingFiles(prev => prev.map(f =>
      f.id === fileId ? { ...f, status: 'connecting', startTime: Date.now() } : f
    ))
    setError(null)

    let connectTimeout = null
    let retryCount = 0
    let activePeer = null
    let connected = false
    let transferDone = false
    let transferStarted = false
    let disconnectTimer = null
    let retryTimer = null
    let isRetrying = false

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }

    const clearDisconnectTimer = () => {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer)
        disconnectTimer = null
      }
    }

    const clearConnectTimeout = () => {
      if (connectTimeout) {
        clearTimeout(connectTimeout)
        connectTimeout = null
      }
    }

    const cleanupPeer = (peer) => {
      clearConnectTimeout()
      clearDisconnectTimer()
      clearRetryTimer()
      if (senderPeerRef.current === peer) {
        delete pendingIceCandidatesRef.current[recipient.id]
        senderPeerRef.current = null
        senderPeerTargetRef.current = null
      }
      if (peer && !peer.destroyed) peer.destroy()
    }

    const finish = (success) => {
      if (settled) return
      settled = true
      clearConnectTimeout()
      clearDisconnectTimer()
      clearRetryTimer()
      if (activePeer) cleanupPeer(activePeer)

      if (success) {
        setSendingFiles(prev => prev.map(f =>
          f.id === fileId ? { ...f, status: 'completed', sent: f.size } : f
        ))
        setTimeout(() => {
          setSendingFiles(prev => prev.filter(f => f.id !== fileId))
        }, 2000)
      } else {
        setSendingFiles(prev => prev.map(f =>
          f.id === fileId ? { ...f, status: 'failed', error: 'Transfer failed' } : f
        ))
      }

      resolve(success)
    }

    const failBeforeConnect = async (peer, reason) => {
      if (import.meta.env.DEV) console.log(`[WebRTC] failBeforeConnect (${reason}), attempt ${retryCount + 1}/${MAX_PEER_RETRIES + 1}`)
      
      if (senderPeerRef.current !== peer || settled || connected || transferStarted || isRetrying) {
        return
      }
      isRetrying = true

      cleanupPeer(peer)

      if (retryCount < MAX_PEER_RETRIES) {
        retryCount += 1
        if (import.meta.env.DEV) console.log(`[WebRTC] [sender] retry attempt ${retryCount + 1}/${MAX_PEER_RETRIES + 1} starting in 1000ms...`)
        setSendingFiles(prev => prev.map(f =>
          f.id === fileId ? { ...f, status: 'connecting', attempt: retryCount + 1 } : f
        ))
        clearRetryTimer()
        retryTimer = setTimeout(() => {
          retryTimer = null
          isRetrying = false
          if (!settled && !connected && !transferStarted) {
            createPeerWithTimeout()
          }
        }, 1000)
        return
      }
      
      isRetrying = false
      if (import.meta.env.DEV) console.log('[WebRTC] [sender] retry attempts exhausted, switching to fallback')
      setError(null)
      setSendingFiles(prev => prev.map(f =>
        f.id === fileId ? { ...f, status: 'sending', connected: false, fallback: true } : f
      ))
      try {
        const wsState = socketRef.current?.readyState
        const wsStateStr = wsState === WebSocket.OPEN ? 'OPEN' : wsState === WebSocket.CONNECTING ? 'CONNECTING' : wsState === WebSocket.CLOSING ? 'CLOSING' : wsState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN'
        if (import.meta.env.DEV) console.log(`[ws-transfer] fallback started, socket readyState: ${wsState} (${wsStateStr})`)
        
        await sendFileViaWebSocket(file, recipient, fileId)
        if (import.meta.env.DEV) console.log('[ws-transfer] fallback completed successfully')
        finish(true)
      } catch (err) {
        if (import.meta.env.DEV) console.error('[file-send] WebSocket fallback FAILED:', err.message || err)
        setError('Transfer gagal. Koneksi antar perangkat tidak dapat dibuat.')
        finish(false)
      }
    }

    const createPeerWithTimeout = () => {
      if (settled || connected || transferStarted) {
        return
      }
      isRetrying = false
      if (import.meta.env.DEV) console.log(`[WebRTC] attempt ${retryCount + 1}/${MAX_PEER_RETRIES + 1} for file ${file.name}`)
      console.log('[FILE] preparing transfer')
      console.log('[FILE] target:', recipient.name || recipient.id)
      
      const peer = new Peer(getPeerConfig(true))
      activePeer = peer
      senderPeerRef.current = peer
      senderPeerTargetRef.current = recipient.id
      
      console.log('[FILE] peer connection created')
      console.log('[FILE] data channel created')
      console.log('[FILE] data channel state:', peer._channel?.readyState || 'connecting')
      if (import.meta.env.DEV) console.log('[file-send] peer created, attaching diagnostics')
      attachIceDiagnostics(peer, 'sender')

      const pending = pendingIceCandidatesRef.current[recipient.id]
      if (pending && pending.length > 0) {
        if (import.meta.env.DEV) console.log('[signal] flushing', pending.length, 'pending ICE candidates for sender from', recipient.id)
        pending.forEach(cand => {
          try {
            if (senderPeerRef.current && !senderPeerRef.current.destroyed) {
              senderPeerRef.current.signal(cand)
            }
          } catch { /* ignore */ }
        })
        delete pendingIceCandidatesRef.current[recipient.id]
      }

      peer.on('signal', (signal) => {
        if (senderPeerRef.current !== peer || peer.destroyed) return
        if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
          const type = signal.type === 'candidate' ? 'ice-candidate' : (signal.type || 'ice-candidate')
          console.log(`[WEBRTC] signal sent: ${type} to ${recipient.name || recipient.id}`)
          if (type === 'ice-candidate') {
            console.log(`[ICE] candidate sent: to ${recipient.name || recipient.id}`)
          }
          socketRef.current.send(JSON.stringify({ type, target: recipient.id, data: signal }))
        }
      })

      let transferInitiated = false

      const startTransfer = async () => {
        if (transferInitiated || senderPeerRef.current !== peer || peer.destroyed || settled) return

        const channel = peer._channel
        const isChannelOpen = channel && channel.readyState === 'open'
        if (!isChannelOpen && !peer.connected) {
          return
        }

        transferInitiated = true
        connected = true
        clearConnectTimeout()

        console.log('[WEBRTC] peer connected')
        console.log('[FILE] data channel OPEN')
        console.log(`[FILE] data channel readyState: ${channel?.readyState || 'open'}`)
        setSendingFiles(prev => prev.map(f =>
          f.id === fileId ? { ...f, connected: true, status: 'sending' } : f
        ))

        try {
          if (import.meta.env.DEV) console.log('[file-send] computing checksum for:', file.name, file.size, 'bytes')
          const checksum = await sha256Hex(file)
          if (import.meta.env.DEV) console.log('[file-send] checksum ready, sending meta...')
          const meta = JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mime: file.type, checksum, senderName: nameRef.current, senderId: socketIdRef.current })
          peer.send(meta)
          console.log('[FILE] metadata sent')
          transferStarted = true
          if (import.meta.env.DEV) console.log('[file-send] meta sent, starting chunk loop...')

          addSystemMessage(recipient.id, 'sent', file.name, file.size)

          await new Promise(r => setTimeout(r, 100))

          const chunkSize = 64 * 1024
          const maxBufferedAmount = 1024 * 1024
          const lowThreshold = 256 * 1024
          const totalChunks = Math.ceil(file.size / chunkSize) || 1
          const PROGRESS_UPDATE_BYTES = 512 * 1024
          let offset = 0
          let chunkCount = 0
          let lastProgressUpdate = 0
          const startTime = Date.now()

          peer.on('data', (data) => {
            if (typeof data === 'string') {
              try {
                const msg = JSON.parse(data)
                if (msg.type === 'file-ack') {
                  console.log('[FILE] receiver ACK received, transfer finalized successfully')
                  finish(true)
                }
              } catch { /* ignore */ }
            }
          })

          const sendLoop = async () => {
            const currentChan = peer._channel
            if (currentChan && typeof currentChan.bufferedAmountLowThreshold === 'number') {
              currentChan.bufferedAmountLowThreshold = lowThreshold
            }

            const waitForDrain = () => new Promise((resolve) => {
              if (!peer || peer.destroyed || !peer.connected) {
                resolve()
                return
              }
              const activeChan = peer._channel
              const currentBuf = (activeChan && activeChan.bufferedAmount) ?? peer.bufferSize ?? 0
              if (currentBuf <= maxBufferedAmount) {
                resolve()
                return
              }

              console.log(`[FILE] buffered amount: ${currentBuf}`)
              console.log('[FILE] flow control paused')

              let resolved = false
              let pollTimer = null

              const onLow = () => {
                if (resolved) return
                resolved = true
                if (activeChan) activeChan.removeEventListener('bufferedamountlow', onLow)
                if (pollTimer) clearInterval(pollTimer)
                console.log('[FILE] flow control resumed')
                resolve()
              }

              if (activeChan) {
                activeChan.addEventListener('bufferedamountlow', onLow, { once: true })
              }

              pollTimer = setInterval(() => {
                if (!peer || peer.destroyed || !peer.connected) {
                  if (pollTimer) clearInterval(pollTimer)
                  if (activeChan) activeChan.removeEventListener('bufferedamountlow', onLow)
                  resolve()
                  return
                }
                const buf = (activeChan && activeChan.bufferedAmount) ?? peer.bufferSize ?? 0
                if (buf <= lowThreshold) {
                  onLow()
                }
              }, 10)
            })

            while (offset < file.size) {
              if (senderPeerRef.current !== peer || settled) return
              if (!peer.connected && peer._channel?.readyState !== 'open') {
                if (import.meta.env.DEV) console.log('[file-send] peer disconnected during transfer')
                finish(false)
                return
              }

              await waitForDrain()
              if (senderPeerRef.current !== peer || settled) return

              const chunk = file.slice(offset, offset + chunkSize)
              const buffer = await chunk.arrayBuffer()
              if (senderPeerRef.current !== peer || settled) return

              peer.send(buffer)
              offset += buffer.byteLength
              chunkCount += 1

              if (chunkCount === 1 || chunkCount % 25 === 0 || offset >= file.size) {
                console.log(`[FILE] chunk sent: ${chunkCount}/${totalChunks}`)
                console.log(`[FILE] buffered amount: ${(peer._channel && peer._channel.bufferedAmount) ?? peer.bufferSize}`)
              }

              if (offset - lastProgressUpdate >= PROGRESS_UPDATE_BYTES || offset >= file.size) {
                const elapsed = (Date.now() - startTime) / 1000
                const speed = elapsed > 0 ? offset / elapsed : 0
                setSendingFiles(prev => prev.map(f =>
                  f.id === fileId ? { ...f, sent: offset, speed } : f
                ))
                lastProgressUpdate = offset
              }
            }

            console.log('[FILE] all chunks queued')

            const waitForZeroDrain = () => new Promise((resolve) => {
              const check = () => {
                if (senderPeerRef.current !== peer || settled) {
                  resolve()
                  return
                }
                const currentBuf = (peer._channel && peer._channel.bufferedAmount) ?? peer.bufferSize ?? 0
                if (currentBuf === 0) {
                  resolve()
                } else {
                  setTimeout(check, 15)
                }
              }
              check()
            })

            await waitForZeroDrain()
            if (senderPeerRef.current !== peer || settled) return

            console.log('[FILE] buffer drained')
            console.log('[FILE] file-end sent')
            peer.send(JSON.stringify({ type: 'file-end' }))
            transferDone = true

            setHistory(h => [{ name: file.name, size: file.size, peer: recipient.name, time: Date.now(), type: 'sent' }, ...h].slice(0, 20))
            setNotify({ type: 'success', message: `Berkas "${file.name}" terkirim ke ${recipient.name}` })

            setTimeout(() => {
              if (!settled) {
                console.log('[FILE] transfer completed (fallback timeout)')
                finish(true)
              }
            }, 10000)
          }

          await sendLoop()
        } catch (err) {
          if (import.meta.env.DEV) console.error('[send] error:', err)
          setError('Gagal mengirim berkas.')
          finish(false)
        }
      }

      peer.on('connect', startTransfer)

      const chan = peer._channel
      if (chan) {
        if (chan.readyState === 'open') {
          startTransfer()
        } else {
          chan.addEventListener('open', startTransfer, { once: true })
        }
      }

      const pc = peer._pc
      if (pc) {
        pc.addEventListener('iceconnectionstatechange', () => {
          const state = pc.iceConnectionState
          if (import.meta.env.DEV) console.log(`[file-send] iceConnectionState: ${state}`)
          if (senderPeerRef.current !== peer || peer.destroyed) return

          if (state === 'connected' || state === 'completed') {
            clearDisconnectTimer()
            if (peer._channel?.readyState === 'open') {
              startTransfer()
            }
          } else if (state === 'disconnected') {
            if (import.meta.env.DEV) console.log('[file-send] ICE disconnected, waiting 7s grace period for mobile recovery...')
            clearDisconnectTimer()
            disconnectTimer = setTimeout(() => {
              if (senderPeerRef.current === peer && !peer.destroyed && pc.iceConnectionState === 'disconnected') {
                if (import.meta.env.DEV) console.log('[file-send] Disconnect grace period expired without recovery')
                if (!connected && !transferStarted && !settled) {
                  failBeforeConnect(peer, 'ice-disconnected-timeout')
                }
              }
            }, 7000)
          } else if (state === 'failed') {
            clearDisconnectTimer()
            if (import.meta.env.DEV) console.log(`[file-send] ICE FAILED - checking conditions: connected=${connected} transferStarted=${transferStarted} settled=${settled}`)
            if (!connected && !transferStarted && !settled) {
              if (import.meta.env.DEV) console.log('[file-send] *** ICE failed detected, calling failBeforeConnect ***')
              failBeforeConnect(peer, 'ice-failed')
            } else {
              if (import.meta.env.DEV) console.log('[file-send] ICE failed but blocked by flags')
            }
          }
        })

        if (typeof pc.connectionState === 'string') {
          pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'connected' && peer._channel?.readyState === 'open') {
              startTransfer()
            }
          })
        }
      }

      peer.on('error', (err) => {
        console.warn('[WEBRTC] peer error (sender):', err?.code || err?.name || 'unknown')
        
        if (senderPeerRef.current !== peer || settled || transferDone) {
          return
        }
        
        if (!connected && !transferStarted) {
          failBeforeConnect(peer, 'error')
          return
        }
        setError('Koneksi P2P langsung gagal. Perangkat mungkin berada di jaringan yang membatasi koneksi langsung.')
        finish(false)
      })

      peer.on('close', () => {
        console.log('[WEBRTC] peer closed (sender)')
        
        if (senderPeerRef.current !== peer || settled || transferDone) {
          return
        }
        
        if (!connected && !transferStarted) {
          failBeforeConnect(peer, 'close')
          return
        }
        finish(false)
      })

      connectTimeout = setTimeout(() => {
        if (import.meta.env.DEV) console.log('[peer] connect timeout reached')
        failBeforeConnect(peer, 'timeout')
      }, PEER_CONNECT_TIMEOUT)
    }

    createPeerWithTimeout()
  }), [addSystemMessage, getPeerConfig, sendFileViaWebSocket])

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
    // Stop typing before logout
    stopTyping()

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
      await sendFile(item.id, item.file, item.recipient)
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    isSendingRef.current = false
  }, [sendFile])

  const handleFiles = useCallback((files, targetRecipient = null) => {
    const recipient = targetRecipient || selected
    if (!recipient) {
      setNotify({ type: 'info', message: 'Pilih pengguna online terlebih dahulu sebelum mengirim berkas.' })
      return
    }
    if (!files || files.length === 0) return
    const newFiles = Array.from(files).map(file => ({
      id: generateId(),
      file,
      recipient,
      name: file.name,
      size: file.size,
      sent: 0,
      connected: false,
      status: 'queued',
      startTime: null,
      speed: 0,
      error: null
    }))

    fileQueueRef.current.push(...newFiles)
    setSendingFiles(prev => [...prev, ...newFiles])
    processFileQueue()
  }, [processFileQueue, selected])

  const handleMainFileSelect = useCallback((event) => {
    const files = event.target.files
    if (!selected) {
      setNotify({
        type: 'info',
        message: 'Pilih pengguna online terlebih dahulu.'
      })
      event.target.value = ''
      return
    }

    if (files && files.length) {
      handleFiles(files, selected)
    }

    event.target.value = ''
  }, [selected, handleFiles])

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
    } catch {
      setNotify({ type: 'error', message: 'Gagal mengunduh berkas.' })
    }
  }

  const deleteFile = async (file) => {
    if (!window.confirm(`Hapus "${file.name}" dari notifikasi?`)) return
    try {
      await deleteReceivedFile(file.id)
      loadReceivedFiles()
    } catch {
      setNotify({ type: 'error', message: 'Gagal menghapus berkas.' })
    }
  }

  const undownloadedCount = receivedFiles.filter(f => !f.downloaded).length


  const openChat = (user) => {
    if (!user || user.id === socketId) return

    const prevChatId = chatOpen
    if (prevChatId) {
      stopTyping()
    }

    setSelected(user)
    setChatOpen(user.id)
    setUnreadCount(prev => ({ ...prev, [user.id]: 0 }))
  }

  const sendChatMessage = () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    stopTyping()

    const text = chatInput.trim()
    if (!text || !chatOpen) return

    const s = socketRef.current
    if (!s || s.readyState !== WebSocket.OPEN) return

    const recipient = users.find(u => u.id === chatOpen)
    if (!recipient) return

    s.send(JSON.stringify({
      type: 'chat',
      to: chatOpen,
      message: text
    }))

    setChatMessages(prev => {
      const userMessages = prev[chatOpen] || []
      return {
        ...prev,
        [chatOpen]: [...userMessages, { from: nameRef.current, text, timestamp: Date.now(), fromId: socketIdRef.current }]
      }
    })

    setChatInput('')
  }

  const MAX_VISIBLE_PROGRESS = 10
  const activeFiles = sendingFiles.filter(f => ['connecting', 'sending', 'completed'].includes(f.status))
  const queuedFiles = sendingFiles.filter(f => f.status === 'queued')
  const visibleProgress = activeFiles.slice(0, MAX_VISIBLE_PROGRESS)
  const queuedCount = queuedFiles.length

  const chatUser = users.find(u => u.id === chatOpen)
  const currentChatMessages = chatOpen ? (chatMessages[chatOpen] || []) : []

  const handleChatFileSelect = useCallback((event) => {
    const files = event.target.files
    if (!files || files.length === 0) return

    if (!chatUser) {
      setNotify({
        type: 'error',
        message: 'Penerima chat tidak tersedia.'
      })
      event.target.value = ''
      return
    }

    handleFiles(files, chatUser)
    event.target.value = ''
  }, [chatUser, handleFiles])

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

  const recvPercent = receiving ? Math.min(100, Math.round((receiving.received / receiving.size) * 100)) : 0
  const recvSpeed = receiving ? formatSpeed(receiving.speed || 0) : ''
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
          {showNotifications && (
            <div className="notification-dropdown">
              <div className="notification-header">
                <b>Notifikasi</b>
                <div className="notification-header-actions">
                  <span className="notification-count">{receivedFiles.length} berkas</span>
                  <button className="notif-close-btn" onClick={() => setShowNotifications(false)} aria-label="Tutup notifikasi">×</button>
                </div>
              </div>
              {receivedFiles.length === 0 ? (
                <div className="notification-empty">Belum ada berkas diterima</div>
              ) : (
                receivedFiles.map((file) => (
                  <div key={file.id} className="notification-item">
                    <div className="notification-file">
                      <span className="notif-file-icon">{file.downloaded ? '🟢' : '🔵'}</span>
                      <div className="notification-file-info">
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
                ))
              )}
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
          <div className="sidebar-title">
            <span>Berkas Diterima</span>
            <button
              onClick={() => setShowFileManager(true)}
              className="file-manager-btn"
              style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--primary)', textTransform: 'normal', letterSpacing: 'normal', padding: 0 }}
            >
              Kelola ({receivedFiles.length})
            </button>
          </div>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-title"><span>Pengguna Online</span><b>{users.length}</b></div>
          {users.length === 0 && <p className="empty-hint">Menunggu pengguna lain bergabung…</p>}
          {users.map((u) => (
            <button key={u.id} className={`user-card ${selected?.id === u.id ? 'active' : ''}`} onClick={() => setSelected(u)}>
              <span className="avatar">{initials(u.name)}</span><span className="user-details"><b>{u.name}</b><small><span className="dot" /> Online</small></span>
              {unreadCount[u.id] > 0 && <span className="chat-unread-badge">{unreadCount[u.id] > 9 ? '9+' : unreadCount[u.id]}</span>}
              <span className="chat-btn" role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); openChat(u); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openChat(u); } }}>💬</span>
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
        <label
          htmlFor="main-file-input"
          className={`dropzone ${!selected ? 'disabled' : ''}`}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onClick={(e) => {
            if (!selected) {
              e.preventDefault()
              setNotify({ type: 'info', message: 'Pilih pengguna online terlebih dahulu sebelum memilih berkas.' })
            }
          }}
        >
          <input
            id="main-file-input"
            type="file"
            multiple
            disabled={!selected}
            className="main-file-input"
            onChange={handleMainFileSelect}
          />
          <div className="drop-icon"><IconArrow /></div>
          <div className="drop-content">
            <b>{selected ? 'Tarik berkas ke sini' : 'Pilih penerima terlebih dahulu'}</b>
            <span>{selected ? 'atau pilih berkas dari perangkat' : 'Daftar pengguna online ada di samping'}</span>
            <small>Transfer langsung antar perangkat · Ukuran bebas</small>
          </div>
        </label>
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError(null)} aria-label="Tutup pesan kesalahan">×</button></div>}
        {visibleProgress.length > 0 && (
          <div className="progress-list">
            {visibleProgress.map(transfer => {
              const percent = transfer.size > 0 ? Math.min(100, Math.round((transfer.sent / transfer.size) * 100)) : 0
              const speed = transfer.speed > 0 ? formatSpeed(transfer.speed) : ''
              const eta = transfer.speed > 0 && transfer.sent < transfer.size
                ? Math.ceil((transfer.size - transfer.sent) / transfer.speed) + 's'
                : ''

              return (
                <div key={transfer.id} className={`progress-card status-${transfer.status}`}>
                  <div className="progress-head">
                    <div className="progress-label">
                      <span className={`dot ${transfer.connected ? 'ok' : 'pulse'}`} />
                      <div>
                        <span>
                          {transfer.status === 'queued' && 'Menunggu'}
                          {transfer.status === 'connecting' && (transfer.attempt > 1 ? `Mencoba ulang koneksi (${transfer.attempt}/3)...` : 'Menghubungkan')}
                          {transfer.status === 'sending' && (transfer.fallback ? 'Mengirim via Relay' : 'Mengirim berkas')}
                          {transfer.status === 'completed' && '✓ Selesai'}
                          {transfer.status === 'failed' && '✗ Gagal'}
                        </span>
                        <b>{transfer.name}</b>
                      </div>
                    </div>
                    {transfer.status === 'sending' && <strong>{percent}%</strong>}
                    {transfer.status === 'completed' && <strong>100%</strong>}
                    {['connecting', 'sending'].includes(transfer.status) && (
                      <button
                        onClick={() => cancelFile(transfer.id)}
                        className="cancel-btn"
                        style={{ fontSize: 10, padding: '2px 6px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}
                      >
                        Batal
                      </button>
                    )}
                  </div>
                  {(transfer.status === 'sending' || transfer.status === 'completed') && (
                    <>
                      <div className="track"><div style={{ width: `${percent}%` }} /></div>
                      <div className="progress-meta">
                        <span>{formatSize(transfer.sent)} dari {formatSize(transfer.size)}</span>
                        {speed && <span>{speed}</span>}
                        {eta && <span className="eta">Sisa {eta}</span>}
                        {transfer.connected && <span className="conn ok">Terhubung langsung</span>}
                        {transfer.fallback && <span className="conn pulse">Koneksi Relay</span>}
                      </div>
                    </>
                  )}
                  {transfer.status === 'failed' && transfer.error && (
                    <div className="progress-error">{transfer.error}</div>
                  )}
                </div>
              )
            })}
            {queuedCount > 0 && visibleProgress.length >= MAX_VISIBLE_PROGRESS && (
              <div className="queue-indicator">+ {queuedCount} file dalam antrean</div>
            )}
          </div>
        )}
        {receiving && (
          <div className="progress-card">
            <div className="progress-head"><div className="progress-label"><span className={`dot ${receiving?.connected ? 'ok' : 'pulse'}`} /><div><span>{receiving?.connected ? 'Menerima berkas' : receiving?.fallback ? 'Menerima via Relay' : 'Menunggu koneksi'}</span><b>{receiving?.name || 'Menyiapkan transfer'}</b></div></div><strong>{recvPercent}%</strong></div>
            <div className="track"><div style={{ width: `${recvPercent}%` }} /></div>
            <div className="progress-meta"><span>{formatSize(receiving.received)} dari {formatSize(receiving.size)}</span><span>{recvSpeed}</span>{recvETA && <span className="eta">Sisa {recvETA}</span>}<span className={`conn ${receiving?.connected ? 'ok' : 'pulse'}`}>{receiving?.connected ? 'Terhubung langsung' : receiving?.fallback ? 'Koneksi Relay' : 'Menghubungkan…'}</span></div>
          </div>
        )}
      </article>
    </section>
    <footer className="site-footer"><span>Kirimin — Berbagi Berkas Langsung</span></footer>
    {notify && <div className={`toast ${notify.type}`} onClick={() => setNotify(null)}><span><IconCheck /></span>{notify.message}</div>}
    {chatOpen && chatUser && (
      <div className="chat-window" ref={chatContainerRef}>
        <div className="chat-header">
          <div className="chat-user-info">
            <span className="avatar-small">{initials(chatUser.name)}</span>
            <div>
              <b>{chatUser.name}</b>
              <small><span className="dot" /> Online</small>
            </div>
          </div>
          <button onClick={() => setChatOpen(null)} className="chat-close">×</button>
        </div>
        <div className="chat-messages">
          {currentChatMessages.length === 0 && (
            <div className="chat-empty">Mulai percakapan dengan {chatUser.name}</div>
          )}
          {currentChatMessages.map((msg, i) => {
            if (msg.type === 'system') {
              return (
                <div key={i} className="chat-message system">
                  <div className="chat-message-content">
                    <div className="system-icon">{msg.systemType === 'sent' ? '📎' : '📥'}</div>
                    <div className="system-text">
                      <b>{msg.systemType === 'sent' ? 'File dikirim' : 'File diterima'}</b>
                      <span>{msg.fileName} · {formatSize(msg.fileSize)}</span>
                    </div>
                    <small className="chat-time">{formatTime(msg.timestamp)}</small>
                  </div>
                </div>
              )
            }
            return (
              <div key={i} className={`chat-message ${msg.fromId === socketId ? 'sent' : 'received'}`}>
                <div className="chat-message-content">
                  <small className="chat-sender">{msg.from}</small>
                  <p>{msg.text}</p>
                  <small className="chat-time">{formatTime(msg.timestamp)}</small>
                </div>
              </div>
            )
          })}
          {chatOpen && typingUsers[chatOpen] && (
            <div className="typing-indicator">
              <span className="typing-dot"></span>
              <span className="typing-dot"></span>
              <span className="typing-dot"></span>
              <span className="typing-text">{typingUsers[chatOpen].name} sedang mengetik.</span>
            </div>
          )}
        </div>
        <div className="chat-input-container">
          <label
            htmlFor="chat-file-input"
            className="chat-attach-btn"
            aria-label="Kirim berkas"
            title="Kirim berkas"
          >
            📎
          </label>
          <input
            id="chat-file-input"
            ref={chatFileInputRef}
            type="file"
            multiple
            className="chat-file-input"
            onChange={handleChatFileSelect}
          />
          <input
            type="text"
            placeholder="Tulis pesan..."
            value={chatInput}
            onChange={handleChatInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendChatMessage()
              }
            }}
            autoFocus
          />
          <button onClick={sendChatMessage} disabled={!chatInput.trim()} className="chat-send-btn">Kirim</button>
        </div>
      </div>
    )}
    {showDownloadPanel && receivedFiles.length > 0 && (
      <div className="download-panel">
        <div className="download-panel-header"><div><span className="received-check"><IconCheck /></span><div><b>Berkas berhasil diterima</b><small>{receivedFiles.length} berkas tersedia di notifikasi</small></div></div><button onClick={() => { setShowDownloadPanel(false); }} aria-label="Tutup panel">×</button></div>
        {receivedFiles.map((file) => (
          <div key={file.id} className="download-item">
            <div className="download-info"><b>{file.name}</b><small>{formatSize(file.size)} · Dari: {file.sender}</small></div>
            <button className="download-btn" onClick={() => downloadFile(file)}>Download <IconDownload /></button>
          </div>
        ))}
        <div className="download-panel-hint">Berkas sudah tersimpan dan bisa kamu lihat kembali di notifikasi.</div>
      </div>
    )}
    {showFileManager && (
      <div className="modal-overlay" onClick={() => setShowFileManager(false)}>
        <div className="modal-content file-manager-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h3 className="file-manager-title">Kelola Berkas</h3>
              <small className="file-manager-meta">
                {receivedFiles.length} berkas · {formatBytes(receivedFiles.reduce((acc, f) => acc + (f.size || 0), 0))}
              </small>
            </div>
            <button onClick={() => setShowFileManager(false)} aria-label="Tutup kelola berkas">×</button>
          </div>
          <div className="file-manager-search-wrap">
            <input
              type="text"
              placeholder="Cari berkas..."
              value={fileSearchQuery}
              onChange={(e) => setFileSearchQuery(e.target.value)}
              className="file-manager-search-input"
            />
          </div>
          <div className="modal-body file-manager-body">
            {(() => {
              const filtered = receivedFiles.filter(f =>
                f.name.toLowerCase().includes(fileSearchQuery.toLowerCase())
              )

              if (filtered.length === 0) {
                return (
                  <div className="file-manager-empty">
                    {receivedFiles.length === 0 ? 'Belum ada file tersimpan' : 'Tidak ada berkas yang cocok'}
                  </div>
                )
              }

              return (
                <div className="file-manager-list">
                  {filtered.map((file) => (
                    <div key={file.id} className="file-manager-item">
                      <div className="file-manager-info">
                        <b>{file.name}</b>
                        <small>
                          {formatBytes(file.size)} · {formatDate(file.receivedAt)} · Dari: {file.sender}
                        </small>
                      </div>
                      <div className="file-manager-actions">
                        <button
                          onClick={() => handleDownloadFile(file.id)}
                          className="file-manager-download-btn"
                        >
                          Download
                        </button>
                        <button
                          onClick={() => handleDeleteFile(file.id)}
                          className="file-manager-delete-btn"
                        >
                          Hapus
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            })()}
          </div>
        </div>
      </div>
    )}
  </main>
}
