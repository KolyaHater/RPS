const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6,
});

// ===== Настройки игры =====
const ROUND_SECONDS = 5;
const GRACE_MS = 3000;
const GESTURES = ['rock', 'scissors', 'paper'];
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
const MAX_PHOTO_LENGTH = 1_500_000;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = {};

function generateRoomId() {
  let id;
  do {
    id = Array.from({ length: 5 }, () =>
      ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]
    ).join('');
  } while (rooms[id]);
  return id;
}

function judge(g1, g2) {
  const ok1 = GESTURES.includes(g1);
  const ok2 = GESTURES.includes(g2);
  if (!ok1 && !ok2) return 'draw';
  if (ok1 && !ok2) return 'p1';
  if (!ok1 && ok2) return 'p2';
  if (g1 === g2) return 'draw';
  return BEATS[g1] === g2 ? 'p1' : 'p2';
}

function finishRound(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'choosing') return;
  clearTimeout(room.timeout);
  room.timeout = null;

  const [p1, p2] = room.players;
  const c1 = room.choices[p1] || { gesture: 'none', photo: null };
  const c2 = room.choices[p2] || { gesture: 'none', photo: null };

  const verdict = judge(c1.gesture, c2.gesture);
  let winner = 'draw';
  if (verdict === 'p1') {
    winner = p1;
    room.scores[p1]++;
  }
  if (verdict === 'p2') {
    winner = p2;
    room.scores[p2]++;
  }

  room.status = 'revealing';
  io.to(roomId).emit('round-result', {
    choices: { [p1]: c1, [p2]: c2 },
    winner,
    scores: room.scores,
  });
  console.log(`Комната ${roomId}: результат ->`, winner === 'draw' ? 'ничья' : winner);
}

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  socket.data.roomId = null;
  socket.leave(roomId);

  const room = rooms[roomId];
  if (!room) return;

  room.players = room.players.filter((id) => id !== socket.id);
  delete room.ready[socket.id];
  delete room.choices[socket.id];
  delete room.scores[socket.id];

  if (room.players.length === 0) {
    clearTimeout(room.timeout);
    delete rooms[roomId];
    console.log(`Комната ${roomId} удалена`);
    return;
  }

  clearTimeout(room.timeout);
  room.timeout = null;
  room.status = 'waiting';
  room.ready = {};
  room.choices = {};
  room.players.forEach((id) => (room.scores[id] = 0));
  io.to(roomId).emit('opponent-left', {
    roomId,
    players: room.players,
    scores: room.scores,
  });
}

io.on('connection', (socket) => {
  console.log('Игрок подключился:', socket.id);

  socket.on('create-room', () => {
    leaveRoom(socket);
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: [socket.id],
      ready: {},
      choices: {},
      scores: { [socket.id]: 0 },
      status: 'waiting',
      timeout: null,
    };
    socket.data.roomId = roomId;
    socket.join(roomId);
    socket.emit('room-created', roomId);
    console.log(`Комната создана: ${roomId}`);
  });

  socket.on('join-room', (rawId) => {
    const roomId = String(rawId || '').trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return socket.emit('room-error', 'Комната не найдена');
    if (room.players.includes(socket.id)) return socket.emit('room-error', 'Ты уже в этой комнате');
    if (room.players.length >= 2) return socket.emit('room-error', 'Комната уже полная');

    leaveRoom(socket);
    room.players.push(socket.id);
    room.scores[socket.id] = 0;
    room.ready[socket.id] = false;
    room.status = 'lobby';
    socket.data.roomId = roomId;
    socket.join(roomId);

    io.to(roomId).emit('player-joined', {
      roomId,
      players: room.players,
      scores: room.scores,
      initiatorId: room.players[0],
    });
    console.log(`Игрок ${socket.id} зашёл в ${roomId}`);
  });

  socket.on('player-ready', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.status !== 'lobby') return;

    room.ready[socket.id] = true;
    const bothReady = room.players.length === 2 && room.players.every((id) => room.ready[id]);

    if (bothReady) {
      room.status = 'choosing';
      room.choices = {};
      room.ready = {};
      io.to(roomId).emit('start-choosing', { duration: ROUND_SECONDS });
      room.timeout = setTimeout(() => finishRound(roomId), ROUND_SECONDS * 1000 + GRACE_MS);
      console.log(`Комната ${roomId}: начало выбора`);
    } else {
      io.to(roomId).emit('player-ready-update', { ready: room.ready });
    }
  });

  socket.on('submit-choice', ({ gesture, photo } = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.status !== 'choosing') return;
    if (!room.players.includes(socket.id)) return;
    if (room.choices[socket.id]) return;

    const cleanGesture = GESTURES.includes(gesture) ? gesture : 'none';
    const cleanPhoto =
      typeof photo === 'string' &&
      photo.startsWith('data:image/jpeg;base64,') &&
      photo.length <= MAX_PHOTO_LENGTH
        ? photo
        : null;

    room.choices[socket.id] = { gesture: cleanGesture, photo: cleanPhoto };

    if (Object.keys(room.choices).length === room.players.length) {
      finishRound(roomId);
    }
  });

  socket.on('next-round', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.status !== 'revealing') return;

    room.choices = {};
    room.ready = {};
    room.status = room.players.length === 2 ? 'lobby' : 'waiting';
    io.to(roomId).emit('reset-round');
  });

  socket.on('webrtc-offer', ({ offer }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('webrtc-offer', { offer, from: socket.id });
  });

  socket.on('webrtc-answer', ({ answer }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('webrtc-answer', { answer, from: socket.id });
  });

  socket.on('webrtc-ice', ({ candidate }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('webrtc-ice', { candidate, from: socket.id });
  });

  socket.on('disconnect', () => {
    console.log('Игрок отключился:', socket.id);
    leaveRoom(socket);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});