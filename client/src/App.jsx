import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './App.css';

const socket = io('http://127.0.0.1:3001');

function App() {
  // ===== Состояния =====
  const [status, setStatus] = useState('menu'); // menu | waiting | lobby | choosing | revealing
  const [roomId, setRoomId] = useState('');
  const [inputRoom, setInputRoom] = useState('');
  const [players, setPlayers] = useState([]);
  const [scores, setScores] = useState({});
  const [isReady, setIsReady] = useState(false);
  const [readyState, setReadyState] = useState({});
  const [timer, setTimer] = useState(0);
  const [myGesture, setMyGesture] = useState(null);
  const [result, setResult] = useState(null);
  const [currentDetected, setCurrentDetected] = useState('Покажи руку...');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  // ===== Refs =====
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const handsRef = useRef(null);
  const cameraRef = useRef(null);
  const detectedGestureRef = useRef('unknown');
  const timerIntervalRef = useRef(null);
  const roomIdRef = useRef('');

  // ===== Socket listeners =====
  useEffect(() => {
    socket.on('room-created', (id) => {
      setRoomId(id);
      roomIdRef.current = id;
      setStatus('waiting');
    });

    socket.on('player-joined', (data) => {
      setPlayers(data.players);
      setScores(data.scores || {});
      setStatus('lobby');
    });

    socket.on('player-ready-update', (data) => {
      setReadyState(data.ready);
    });

    socket.on('start-choosing', ({ duration }) => {
      console.log('Получил start-choosing');
      setHasSubmitted(false);          // ← сброс
      setStatus('choosing');
      setTimer(duration);
      setMyGesture(null);
      setResult(null);
      startCameraAndDetection();
      startTimer(duration);
});

    socket.on('round-result', (data) => {
      setResult(data);
      setScores(data.scores);
      setStatus('revealing');
      stopCamera();
    });

    socket.on('reset-round', () => {
      setHasSubmitted(false);          // ← сброс
      setStatus('lobby');
      setIsReady(false);
      setReadyState({});
      setMyGesture(null);
      setResult(null);
      setCurrentDetected('Покажи руку...');
    });

    socket.on('error', (msg) => {
      alert(msg);
    });

    return () => {
      socket.off('room-created');
      socket.off('player-joined');
      socket.off('player-ready-update');
      socket.off('start-choosing');
      socket.off('round-result');
      socket.off('reset-round');
      socket.off('error');
    };
  }, []);

  // ===== Таймер =====
  function startTimer(seconds) {
    setTimer(seconds);
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);

    timerIntervalRef.current = setInterval(() => {
      setTimer((prev) => {
        if (prev <= 1) {
          clearInterval(timerIntervalRef.current);
          // Время вышло — фиксируем жест и фото
          captureAndSubmit();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  // ===== Камера + MediaPipe =====
  function startCameraAndDetection() {
    // Загружаем скрипты если ещё не загружены
    const loadScript = (src) => {
      return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) {
          resolve();
          return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.body.appendChild(script);
      });
    };

    async function init() {
      try {
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js');
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');

        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas) return;

        const hands = new window.Hands({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });

        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.7,
          minTrackingConfidence: 0.7,
        });

        hands.onResults((results) => {
          const ctx = canvas.getContext('2d');
          ctx.save();
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

          if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const landmarks = results.multiHandLandmarks[0];

            window.drawConnectors(ctx, landmarks, window.HAND_CONNECTIONS, {
              color: '#00FF00',
              lineWidth: 3,
            });
            window.drawLandmarks(ctx, landmarks, {
              color: '#FF0000',
              lineWidth: 1,
              radius: 4,
            });

            const g = detectGesture(landmarks);
            detectedGestureRef.current = g;
            setCurrentDetected(formatGesture(g));
          } else {
            detectedGestureRef.current = 'unknown';
            setCurrentDetected('Рука не найдена');
          }
          ctx.restore();
        });

        handsRef.current = hands;

        const camera = new window.Camera(video, {
          onFrame: async () => {
            if (handsRef.current) {
              await handsRef.current.send({ image: video });
            }
          },
          width: 640,
          height: 480,
        });

        cameraRef.current = camera;
        await camera.start();
      } catch (err) {
        console.error('Ошибка камеры/MediaPipe:', err);
        setCurrentDetected('Ошибка камеры');
      }
    }

    init();
  }

  function stopCamera() {
    if (cameraRef.current) {
      cameraRef.current.stop();
      cameraRef.current = null;
    }
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
    }
  }

  // ===== Определение жеста =====
  function detectGesture(landmarks) {
    const tips = [8, 12, 16, 20];
    const pips = [6, 10, 14, 18];

    let openFingers = 0;
    for (let i = 0; i < 4; i++) {
      if (landmarks[tips[i]].y < landmarks[pips[i]].y) {
        openFingers++;
      }
    }

    if (openFingers === 0) return 'rock';
    if (openFingers === 2) return 'scissors';
    if (openFingers >= 4) return 'paper';
    return 'unknown';
  }

  function formatGesture(g) {
    if (g === 'rock') return '✊ Камень';
    if (g === 'scissors') return '✌️ Ножницы';
    if (g === 'paper') return '✋ Бумага';
    return 'Непонятно';
  }

  // ===== Захват фото + отправка =====
  function captureAndSubmit() {
  if (hasSubmitted) {
    console.log('Уже отправлял, пропускаю');
    return;
  }

  const canvas = canvasRef.current;
  if (!canvas) {
    console.log('Нет canvas');
    return;
  }

  const photo = canvas.toDataURL('image/jpeg', 0.55);
  const gesture = detectedGestureRef.current || 'unknown';
  const currentRoomId = roomIdRef.current || roomId;

  console.log('===== ОТПРАВЛЯЮ ВЫБОР =====');
  console.log('roomId:', currentRoomId);
  console.log('gesture:', gesture);

  if (!currentRoomId) {
    console.error('roomId пустой');
    return;
  }

  setHasSubmitted(true);
  setMyGesture(gesture);
  setCurrentDetected(formatGesture(gesture) + ' (зафиксировано)');

  socket.emit('submit-choice', {
    roomId: currentRoomId,
    gesture,
    photo
  });
}
  // ===== Действия =====
  const createRoom = () => socket.emit('create-room');
  const joinRoom = () => {
    if (inputRoom.trim()) {
      socket.emit('join-room', inputRoom.trim());
      setRoomId(inputRoom.trim());
      roomIdRef.current = id;
    }
  };

  const handleReady = () => {
    setIsReady(true);
    socket.emit('player-ready', roomId);
  };

  const nextRound = () => {
    socket.emit('next-round', roomId);
  };

  // ===== Рендер =====
  if (status === 'menu') {
    return (
      <div className="container">
        <h1>Камень-Ножницы-Бумага</h1>
        <p className="subtitle">с распознаванием жестов</p>
        <button className="btn" onClick={createRoom}>Создать комнату</button>
        <div className="join-block">
          <input
            placeholder="Код комнаты"
            value={inputRoom}
            onChange={(e) => setInputRoom(e.target.value)}
          />
          <button className="btn" onClick={joinRoom}>Войти</button>
        </div>
      </div>
    );
  }

  if (status === 'waiting') {
    return (
      <div className="container">
        <h2>Комната создана</h2>
        <p className="room-code">Код: <b>{roomId}</b></p>
        <p>Отправь код другу и жди...</p>
      </div>
    );
  }

  // Lobby / Choosing / Revealing
  return (
    <div className="container">
      <h2>Комната: {roomId}</h2>
      <p>Игроков: {players.length}/2</p>

      {/* Счёт */}
      <div className="scores">
        {players.map((id, i) => (
          <span key={id}>
            Игрок {i + 1}: {scores[id] || 0}
            {i === 0 ? ' — ' : ''}
          </span>
        ))}
      </div>

      {/* LOBBY */}
      {status === 'lobby' && (
        <div className="lobby">
          <p>Нажми «Готов», когда будешь готов показать жест</p>
          <button
            className="btn ready-btn"
            onClick={handleReady}
            disabled={isReady}
          >
            {isReady ? 'Ожидаем второго игрока...' : 'Готов!'}
          </button>
        </div>
      )}

      {/* CHOOSING */}
      {status === 'choosing' && (
        <div className="choosing">
          <div className="timer">Таймер: {timer}</div>
          <div className="video-wrapper">
            <video ref={videoRef} style={{ display: 'none' }} playsInline muted></video>
            <canvas ref={canvasRef} width="640" height="480"></canvas>
          </div>
          <div className="detected">
            Сейчас вижу: <b>{currentDetected}</b>
          </div>
          {myGesture && <p className="fixed">Жест зафиксирован! Ждём соперника...</p>}
        </div>
      )}

      {/* REVEALING */}
      {status === 'revealing' && result && (
        <div className="revealing">
          <h3>Результат раунда</h3>

          <div className="photos">
            {players.map((id, index) => {
              const choice = result.choices[id];
              if (!choice) return null;
              return (
                <div key={id} className="player-result">
                  <h4>Игрок {index + 1}</h4>
                  <img src={choice.photo} alt="gesture" className="photo" />
                  <p className="gesture-label">{formatGesture(choice.gesture)}</p>
                </div>
              );
            })}
          </div>

          <div className="winner">
            {result.winner === 'draw' ? (
              <p>Ничья!</p>
            ) : (
              <p>Победитель: Игрок {players.indexOf(result.winner) + 1}</p>
            )}
          </div>

          <button className="btn" onClick={nextRound}>Следующий раунд</button>
        </div>
      )}
    </div>
  );
}

export default App;