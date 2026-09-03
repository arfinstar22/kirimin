const PIN = '0808'

const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=UTF-8', ...extraHeaders }
})

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true })
    }

    if (request.method === 'POST' && url.pathname === '/login') {
      try {
        const body = await request.json()
        if (body.pin === PIN) {
          return json({ ok: true }, 200, corsHeaders)
        } else {
          return json({ ok: false, error: 'Invalid PIN' }, 401, corsHeaders)
        }
      } catch {
        return json({ error: 'Invalid request' }, 400, corsHeaders)
      }
    }

    if (url.pathname === '/reset') {
      if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405)
      }
      const id = env.SIGNALING.idFromName('default')
      return env.SIGNALING.get(id).fetch(request)
    }

    if (url.pathname === '/ws') {
      if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: 'WebSocket upgrade required' }, 426)
      }

      const id = env.SIGNALING.idFromName('default')
      return env.SIGNALING.get(id).fetch(request)
    }

    return json({ error: 'Not found' }, 404)
  }
}

export class SignalingRoom {
  constructor() {
    this.users = new Map()
    this.sockets = new Map()
  }

  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/reset') {
      if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405)
      }
      for (const [, user] of this.sockets) {
        try {
          if (user.socket.readyState === WebSocket.OPEN) {
            user.socket.send(JSON.stringify({ type: 'force_logout', reason: 'admin_reset' }))
            user.socket.close(4001, 'Force logout by admin reset')
          } else if (user.socket.readyState === WebSocket.CONNECTING) {
            user.socket.close(4001, 'Force logout by admin reset')
          }
        } catch {
          // socket already closed; ignore safely
        }
      }
      this.users = new Map()
      this.sockets = new Map()
      this.broadcastUsers()
      return json({ ok: true, reset: true })
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()

    const user = { socket: server, id: crypto.randomUUID(), name: null }
    this.sockets.set(server, user)

    server.addEventListener('message', (event) => this.handleMessage(user, event.data))
    server.addEventListener('close', () => this.disconnect(user))
    server.addEventListener('error', () => this.disconnect(user))

    return new Response(null, { status: 101, webSocket: client })
  }

  handleMessage(user, raw) {
    if (typeof raw !== 'string') {
      this.sendError(user, 'Binary messages are not supported')
      return
    }

    if (raw.length > 1024 * 1024) {
      this.sendError(user, 'Message too large')
      return
    }

    let message
    try {
      message = JSON.parse(raw)
    } catch {
      this.sendError(user, 'Invalid JSON')
      return
    }

    if (!message || typeof message.type !== 'string') {
      this.sendError(user, 'Message type is required')
      return
    }

    if (message.type === 'register') {
      this.register(user, message.name)
      return
    }

    if (message.type === 'rename') {
      this.rename(user, message.name)
      return
    }

    if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
      this.forwardSignal(user, message)
      return
    }

    if (message.type === 'chat') {
      this.forwardChat(user, message)
      return
    }

    if (message.type === 'typing') {
      if (typeof message.to !== 'string' || typeof message.isTyping !== 'boolean') {
        this.sendError(user, 'Invalid typing payload')
        return
      }
      const recipient = this.users.get(message.to)
      if (recipient) {
        this.send(recipient, {
          type: 'typing',
          from: user.id,
          fromName: user.name,
          isTyping: message.isTyping
        })
      }
      return
    }

    this.sendError(user, 'Unknown message type')
  }

  register(user, name) {
    if (typeof name !== 'string') {
      this.sendError(user, 'Username is required')
      return
    }

    const cleanName = name.trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 32)
    if (!cleanName) {
      this.sendError(user, 'Username cannot be empty')
      return
    }

    if (user.name) this.users.delete(user.id)
    user.name = cleanName
    this.users.set(user.id, user)
    this.send(user, { type: 'registered', id: user.id })
    this.broadcastUsers()
  }

  forwardSignal(user, message) {
    if (!user.name) {
      this.sendError(user, 'Register before sending signals')
      return
    }

    if (typeof message.target !== 'string' || !message.target) {
      this.sendError(user, 'Target is required')
      return
    }

    if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)) {
      this.sendError(user, 'Invalid signal payload')
      return
    }

    const target = this.users.get(message.target)
    if (!target) {
      this.sendError(user, 'Target user not found')
      return
    }

    this.send(target, { type: message.type, from: user.id, data: message.data })
  }

  broadcastUsers() {
    const users = [...this.users.values()].map(({ id, name }) => ({ id, name }))
    for (const user of this.users.values()) this.send(user, { type: 'users', users })
  }

  disconnect(user) {
    if (!this.sockets.has(user.socket)) return
    this.sockets.delete(user.socket)
    if (user.name) {
      this.users.delete(user.id)
      this.broadcastUsers()
    }
  }

  send(user, message) {
    try {
      user.socket.send(JSON.stringify(message))
    } catch {
      this.disconnect(user)
    }
  }

  sendError(user, message) {
    this.send(user, { type: 'error', message })
  }

  rename(user, name) {
    if (!user.name) {
      this.sendError(user, 'Register before renaming')
      return
    }

    const cleanName = name.trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 30)
    if (!cleanName) {
      this.sendError(user, 'Username cannot be empty')
      return
    }

    user.name = cleanName
    this.send(user, { type: 'renamed', name: cleanName })
    this.broadcastUsers()
  }

  forwardChat(user, message) {
    if (!user.name) {
      this.sendError(user, 'Register before sending chat')
      return
    }

    if (typeof message.to !== 'string' || !message.to) {
      return
    }

    if (typeof message.message !== 'string' || !message.message.trim()) {
      return
    }

    const cleanMessage = message.message.trim().slice(0, 2000)
    const recipient = this.users.get(message.to)
    if (!recipient) {
      return
    }

    this.send(recipient, {
      type: 'chat',
      from: user.id,
      fromName: user.name,
      message: cleanMessage,
      timestamp: Date.now()
    })
  }
}
