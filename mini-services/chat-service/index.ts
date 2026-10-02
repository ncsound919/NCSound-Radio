import { createServer } from 'http'
import { Server } from 'socket.io'

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

interface User {
  id: string
  username: string
}

interface ChatMessage {
  id: string
  username: string
  content: string
  timestamp: string
  type: 'user' | 'system'
}

// ---------- state ----------
const users = new Map<string, User>()

// Server-side ring buffer: last 30 messages replayed to every new connection
const HISTORY_LIMIT = 30
const history: ChatMessage[] = []

// Rate limiting: max 5 messages per 10s per socket
const RATE_LIMIT_MAX = 5
const RATE_WINDOW_MS = 10_000
const sendTimestamps = new Map<string, number[]>()

// ---------- helpers ----------
const generateMessageId = () => Math.random().toString(36).slice(2, 11)
const nowIso = () => new Date().toISOString()

const createSystemMessage = (content: string): ChatMessage => ({
  id: generateMessageId(),
  username: 'System',
  content,
  timestamp: nowIso(),
  type: 'system'
})

const createUserMessage = (username: string, content: string): ChatMessage => ({
  id: generateMessageId(),
  username,
  content,
  timestamp: nowIso(),
  type: 'user'
})

function pushToHistory(message: ChatMessage) {
  history.push(message)
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT)
  }
}

function currentUsersList(): User[] {
  return Array.from(users.values())
}

function broadcastUsersList() {
  io.emit('users-list', { users: currentUsersList() })
}

function isRateLimited(socketId: string): boolean {
  const nowMs = Date.now()
  const recent = (sendTimestamps.get(socketId) ?? []).filter(
    (t) => nowMs - t < RATE_WINDOW_MS
  )
  if (recent.length >= RATE_LIMIT_MAX) {
    sendTimestamps.set(socketId, recent)
    return true
  }
  recent.push(nowMs)
  sendTimestamps.set(socketId, recent)
  return false
}

// ---------- connection handling ----------
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`)

  // Initial payload: current users + last 30 messages
  socket.emit('users-list', { users: currentUsersList() })
  socket.emit('message-history', { messages: history })

  socket.on('join', (data: { username?: unknown }) => {
    const username =
      typeof data?.username === 'string' ? data.username.trim().slice(0, 24) : ''
    if (!username) return

    const user: User = { id: socket.id, username }
    users.set(socket.id, user)

    const joinMessage = createSystemMessage(`${username} joined the studio line`)
    pushToHistory(joinMessage)
    io.emit('user-joined', { user, message: joinMessage })
    broadcastUsersList()

    console.log(`${username} joined the studio line (online: ${users.size})`)
  })

  socket.on('message', (data: { username?: unknown; content?: unknown }) => {
    const user = users.get(socket.id)
    if (!user) return

    const content =
      typeof data?.content === 'string' ? data.content.trim() : ''
    // Validate: 1..500 chars after trimming
    if (content.length < 1 || content.length > 500) return

    if (isRateLimited(socket.id)) {
      socket.emit('rate-limited', {
        message: 'Easy on the fader — max 5 messages every 10 seconds.'
      })
      return
    }

    const message = createUserMessage(user.username, content)
    pushToHistory(message)
    io.emit('message', message)
    console.log(`${user.username}: ${content}`)
  })

  // Typing relay: broadcast start/stop to everyone else
  socket.on('typing', (data: { isTyping?: unknown }) => {
    const user = users.get(socket.id)
    if (!user) return
    socket.broadcast.emit('typing', {
      username: user.username,
      isTyping: Boolean(data?.isTyping)
    })
  })

  socket.on('disconnect', () => {
    const user = users.get(socket.id)
    sendTimestamps.delete(socket.id)

    if (user) {
      users.delete(socket.id)
      const leaveMessage = createSystemMessage(`${user.username} left the studio line`)
      pushToHistory(leaveMessage)
      io.emit('user-left', {
        user: { id: socket.id, username: user.username },
        message: leaveMessage
      })
      broadcastUsersList()
      console.log(`${user.username} left the studio line (online: ${users.size})`)
    } else {
      console.log(`User disconnected: ${socket.id}`)
    }
  })

  socket.on('error', (error) => {
    console.error(`Socket error (${socket.id}):`, error)
  })
})

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal, shutting down server...')
  httpServer.close(() => {
    console.log('WebSocket server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('Received SIGINT signal, shutting down server...')
  httpServer.close(() => {
    console.log('WebSocket server closed')
    process.exit(0)
  })
})
