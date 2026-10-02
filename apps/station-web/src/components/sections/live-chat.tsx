'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Mic, Radio, RotateCcw, SendHorizontal, Users } from 'lucide-react';

// ---------- types (standalone — no imports from station-types or other sections) ----------
type ChatUser = {
  id: string;
  username: string;
};

type ChatMessage = {
  id: string;
  username: string;
  content: string;
  timestamp: string | Date;
  type: 'user' | 'system';
};

type ConnectionState = 'connecting' | 'connected' | 'offline';

const MAX_MESSAGES = 200;
const TYPING_VISIBLE_MS = 3000;
const RATE_LIMIT_NOTICE_MS = 4000;
const TYPING_EMIT_STOP_MS = 2000;

// Connection is always via the Caddy gateway — NEVER put the port in the URL path itself.
// Exception: when the app itself is being served from the Next dev server on :3000
// (local dev / sandbox verification), the gateway query cannot be routed, so the
// relay is reached directly — the relay has CORS wide open for exactly this case.
function createChatSocket(): Socket {
  if (typeof window !== 'undefined' && window.location.port === '3000') {
    return io('http://localhost:3003', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 10000,
    });
  }
  return io('/?XTransformPort=3003', {
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    timeout: 10000,
  });
}

export function LiveChat() {
  const [connectionKey, setConnectionKey] = useState(0); // bump to recreate the socket (Retry)
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [joined, setJoined] = useState(false);
  const [myUsername, setMyUsername] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [typingUsers, setTypingUsers] = useState<Record<string, number>>({});
  const [rateLimitedNotice, setRateLimitedNotice] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const usernameRef = useRef<string>('');
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg].slice(-MAX_MESSAGES));
  }, []);

  // ---------- socket lifecycle ----------
  useEffect(() => {
    const socket = createChatSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnection('connected');
      // Re-register after a reconnect so the users list and system messages stay accurate
      if (usernameRef.current) {
        socket.emit('join', { username: usernameRef.current });
      }
    });

    socket.on('disconnect', () => {
      setConnection('connecting');
    });

    socket.on('connect_error', () => {
      setConnection((prev) => (prev === 'connected' ? 'connecting' : prev));
    });

    socket.on('reconnect_failed', () => {
      setConnection('offline');
    });

    socket.on('message-history', (data: { messages: ChatMessage[] }) => {
      setMessages(data.messages.slice(-MAX_MESSAGES));
    });

    socket.on('users-list', (data: { users: ChatUser[] }) => {
      setUsers(data.users);
    });

    socket.on('user-joined', (data: { user: ChatUser; message: ChatMessage }) => {
      appendMessage(data.message);
    });

    socket.on('user-left', (data: { user: ChatUser; message: ChatMessage }) => {
      appendMessage(data.message);
      setTypingUsers((prev) => {
        if (!prev[data.user.username]) return prev;
        const next = { ...prev };
        delete next[data.user.username];
        return next;
      });
    });

    socket.on('message', (msg: ChatMessage) => {
      appendMessage(msg);
    });

    socket.on('typing', (data: { username: string; isTyping: boolean }) => {
      setTypingUsers((prev) => {
        const next = { ...prev };
        if (data.isTyping) {
          next[data.username] = Date.now() + TYPING_VISIBLE_MS;
        } else {
          delete next[data.username];
        }
        return next;
      });
    });

    socket.on('rate-limited', (data: { message?: string }) => {
      setRateLimitedNotice(data?.message ?? 'Slow down — too many messages.');
      setTimeout(() => setRateLimitedNotice(null), RATE_LIMIT_NOTICE_MS);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [connectionKey, appendMessage]);

  // Expire stale typing indicators
  useEffect(() => {
    const interval = setInterval(() => {
      setTypingUsers((prev) => {
        const now = Date.now();
        const next: Record<string, number> = {};
        let changed = false;
        for (const [username, expiry] of Object.entries(prev)) {
          if (expiry > now) next[username] = expiry;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll to the latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, typingUsers]);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  // ---------- actions ----------
  const handleJoin = () => {
    const username = nameInput.trim().slice(0, 24);
    if (!username || !socketRef.current || connection !== 'connected') return;
    usernameRef.current = username;
    socketRef.current.emit('join', { username });
    setMyUsername(username);
    setJoined(true);
  };

  const emitTypingStop = useCallback(() => {
    if (!socketRef.current || !isTypingRef.current) return;
    isTypingRef.current = false;
    socketRef.current.emit('typing', { isTyping: false });
  }, []);

  const handleMessageInputChange = (value: string) => {
    setMessageInput(value);
    if (!socketRef.current || !usernameRef.current) return;
    if (!isTypingRef.current && value.trim().length > 0) {
      isTypingRef.current = true;
      socketRef.current.emit('typing', { isTyping: true });
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (value.trim().length > 0) {
      typingTimerRef.current = setTimeout(emitTypingStop, TYPING_EMIT_STOP_MS);
    } else {
      emitTypingStop();
    }
  };

  const sendMessage = () => {
    const content = messageInput.trim().slice(0, 500);
    if (!socketRef.current || !usernameRef.current || content.length === 0) return;
    socketRef.current.emit('message', {
      username: usernameRef.current,
      content,
    });
    setMessageInput('');
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    emitTypingStop();
  };

  const handleRetry = () => {
    setConnection('connecting');
    setConnectionKey((k) => k + 1);
  };

  // ---------- derived ----------
  const typingNames = Object.keys(typingUsers);
  const typingLabel =
    typingNames.length === 0
      ? ''
      : typingNames.length === 1
        ? `${typingNames[0]} is typing…`
        : typingNames.length === 2
          ? `${typingNames[0]} and ${typingNames[1]} are typing…`
          : 'Several listeners are typing…';

  const renderTimestamp = (ts: string | Date) =>
    new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const connectionBadge = (
    <Badge
      variant="outline"
      aria-live="polite"
      className="border-border gap-1.5 bg-background/60 py-1"
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          connection === 'connected'
            ? 'bg-amber-400 animate-pulse'
            : connection === 'offline'
              ? 'bg-red-500'
              : 'bg-amber-400/40 animate-pulse'
        }`}
      />
      <span className="text-xs font-medium text-foreground/80">
        {connection === 'connected' ? 'Connected' : connection === 'offline' ? 'Offline' : 'Connecting…'}
      </span>
    </Badge>
  );

  return (
    <Card
      id="studio-line"
      className="bg-card border-border overflow-hidden"
      aria-label="Studio Line live listener chat"
    >
      <CardHeader className="border-b border-border bg-background/40">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 border border-primary/30">
              <Radio className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
            </div>
            <div>
              <CardTitle className="flex items-center gap-2 text-base font-semibold tracking-wide text-foreground uppercase">
                Studio Line
                <span className="inline-flex items-center gap-1 rounded-sm bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-400">
                  <Mic className="h-2.5 w-2.5" aria-hidden="true" />
                  LIVE
                </span>
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground">
                Call in text-only — talk to the studio and fellow listeners.
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="border-border gap-1.5 bg-background/60 py-1">
              <Users className="h-3 w-3 text-primary" aria-hidden="true" />
              <span className="text-xs font-medium text-foreground/80">
                {users.length} online
              </span>
            </Badge>
            {connectionBadge}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 sm:p-6">
        {connection === 'offline' ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border bg-background/40 py-12 text-center">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">
              Chat relay offline — try again soon
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              className="border-border text-primary hover:bg-primary/10 hover:text-primary"
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : !joined ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              handleJoin();
            }}
          >
            <p className="text-sm text-muted-foreground">
              Pick an on-air name and jump on the line. Be cool — the studio can read this.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Your on-air name…"
                maxLength={24}
                aria-label="Display name"
                disabled={connection !== 'connected'}
                className="flex-1 border-border bg-background/60 focus-visible:ring-primary/40"
              />
              <Button
                type="submit"
                disabled={connection !== 'connected' || nameInput.trim().length === 0}
                className="bg-primary font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Join the Studio Line
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <ScrollArea className="max-h-96 overflow-y-auto scrollbar-thin rounded-md border border-border bg-background/40">
              <div className="space-y-1 p-4" role="log" aria-live="polite" aria-label="Chat messages">
                {messages.length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    The line is quiet… say something first.
                  </p>
                )}
                {messages.map((msg) =>
                  msg.type === 'system' ? (
                    <div key={msg.id} className="flex items-baseline justify-between gap-3 px-1 py-1">
                      <p className="text-xs italic text-muted-foreground">{msg.content}</p>
                      <span className="shrink-0 text-[10px] text-muted-foreground/70">
                        {renderTimestamp(msg.timestamp)}
                      </span>
                    </div>
                  ) : (
                    <div key={msg.id} className="rounded-sm px-1 py-1.5 transition-colors hover:bg-primary/5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium text-primary">
                          {msg.username}
                          {myUsername === msg.username && (
                            <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                              (you)
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {renderTimestamp(msg.timestamp)}
                        </span>
                      </div>
                      <p className="break-words text-sm text-foreground">{msg.content}</p>
                    </div>
                  )
                )}
                <div ref={bottomRef} aria-hidden="true" />
              </div>
            </ScrollArea>

            <div className="h-4 px-1" aria-live="polite">
              {typingLabel && (
                <p className="text-xs italic text-muted-foreground">{typingLabel}</p>
              )}
            </div>

            {rateLimitedNotice && (
              <p className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-400" role="alert">
                {rateLimitedNotice}
              </p>
            )}

            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage();
              }}
            >
              <Input
                value={messageInput}
                onChange={(e) => handleMessageInputChange(e.target.value)}
                placeholder="Type a message to the studio…"
                maxLength={500}
                aria-label="Chat message"
                disabled={connection !== 'connected'}
                className="flex-1 border-border bg-background/60 focus-visible:ring-primary/40"
              />
              <Button
                type="submit"
                size="icon"
                aria-label="Send message"
                disabled={connection !== 'connected' || messageInput.trim().length === 0}
                className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <SendHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </form>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
