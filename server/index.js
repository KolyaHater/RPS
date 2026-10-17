const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5e6 // чтобы фото проходили
});

const rooms = {};

io.on('connection', (socket) => {
  console.log('Игрок подключился:', socket.id);

  // Создать комнату
  socket.on('create-room', () => {
    const roomId = Math.random().toString(36).substring(2, 8);
    rooms[roomId] = {
      players: [socket.id],
      ready: {},
      choices: {},
      scores: { [socket.id]: 0 },
      status: 'waiting' // waiting | choosing | revealing
    };
    socket.join(roomId);
    socket.emit('room-created', roomId);
    console.log(`Комната создана: ${roomId}`);
  });

  // Присоединиться
  socket.on('join-room', (roomId) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error', 'Комната не найдена');
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', 'Комната уже полная');
      return;
    }

    room.players.push(socket.id);
    room.scores[socket.id] = 0;
    room.ready[socket.id] = false;
    socket.join(roomId);

    io.to(roomId).emit('player-joined', {
      players: room.players,
      scores: room.scores
    });

    console.log(`Игрок ${socket.id} зашёл в ${roomId}`);
  });

  // Игрок нажал "Готов"
  socket.on('player-ready', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    room.ready[socket.id] = true;

    // Проверяем, оба ли готовы
    const bothReady = room.players.every(id => room.ready[id]);

    if (bothReady && room.players.length === 2) {
      room.status = 'choosing';
      room.choices = {};
      // Сбрасываем ready для следующего раунда
      room.players.forEach(id => room.ready[id] = false);

      io.to(roomId).emit('start-choosing', { duration: 5 }); // 5 секунд
      console.log(`Комната ${roomId}: начало выбора`);
    } else {
      // Сообщаем остальным, что кто-то готов
      io.to(roomId).emit('player-ready-update', {
        ready: room.ready
      });
    }
  });

  // Игрок отправил жест + фото
  socket.on('submit-choice', ({ roomId, gesture, photo }) => {
  console.log('>>> Получен выбор от', socket.id, 'жест:', gesture, 'комната:', roomId);

  const room = rooms[roomId];
  if (!room) {
    console.log('!!! Комната не найдена');
    return;
  }

  room.choices[socket.id] = { gesture, photo };
  console.log('Сейчас выборов в комнате:', Object.keys(room.choices).length);
  console.log('Игроки в комнате:', room.players);

  if (Object.keys(room.choices).length === 2) {
    const [p1, p2] = room.players;
    const c1 = room.choices[p1];
    const c2 = room.choices[p2];

    console.log('Оба выбора есть, считаем победителя...');

    let winner = 'draw';
    if (c1.gesture !== c2.gesture) {
      if (
        (c1.gesture === 'rock' && c2.gesture === 'scissors') ||
        (c1.gesture === 'scissors' && c2.gesture === 'paper') ||
        (c1.gesture === 'paper' && c2.gesture === 'rock')
      ) {
        winner = p1;
        room.scores[p1]++;
      } else {
        winner = p2;
        room.scores[p2]++;
      }
    }

    room.status = 'revealing';

    io.to(roomId).emit('round-result', {
      choices: room.choices,
      winner,
      scores: room.scores
    });

    console.log('>>> Результат отправлен в комнату', roomId);
  }
});

  // Новый раунд
  socket.on('next-round', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    room.choices = {};
    room.status = 'waiting';
    room.players.forEach(id => room.ready[id] = false);

    io.to(roomId).emit('reset-round');
  });

  socket.on('disconnect', () => {
    console.log('Игрок отключился:', socket.id);
    // Можно добавить очистку комнат при желании
  });
});

server.listen(3001, () => {
  console.log('Сервер запущен на http://localhost:3001');
});