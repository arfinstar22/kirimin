const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=UTF-8' }
})


export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true })
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

    if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
      this.forwardSignal(user, message)
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
}
