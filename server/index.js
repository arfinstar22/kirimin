const express = require('express')
const http = require('http')
const { Server } = require('socket.io')

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
})
const users = new Map()

app.get('/health', (_req, res) => res.json({ ok: true }))

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id)

  socket.on('join', (name) => {
    const cleanName = String(name || 'Guest').trim().slice(0, 32) || 'Guest'
    console.log('User joined:', socket.id, cleanName)
    users.set(socket.id, cleanName)
    io.emit('users', [...users].map(([id, userName]) => ({ id, name: userName })))
  })

  socket.on('signal', ({ to, signal }) => io.to(to).emit('signal', { from: socket.id, signal }))

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id)
    users.delete(socket.id)
    io.emit('users', [...users].map(([id, name]) => ({ id, name })))
  })
})

server.listen(process.env.PORT || 3002, () => console.log('Signaling server ready'))
