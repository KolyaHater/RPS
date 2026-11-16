import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './App.css';


const socket = io();

const OPPONENT_HINT = 'Сделай максимально тупую рожу';

const MEDIAPIPE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe';
const HISTORY_SIZE = 15;
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const scriptPromises = {};
function loadScript(src) {
  if (!scriptPromises[src]) {
    scriptPromises[src] = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => {
        delete scriptPromises[src];
        reject(new Error('Не удалось загрузить ' + src));
      };
      document.body.appendChild(script);
    });
  }
  return scriptPromises[src];
}

// ===== Камера + микрофон =====
async function getLocalStream() {
  const video = { width: 640, height: 480, facingMode: 'user' };
  try {
    return await navigator.mediaDevices.getUserMedia({
      video,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    console.warn('Камера вместе с микрофоном не получилась, пробуем только камеру:', err);
    return navigator.mediaDevices.getUserMedia({ video, audio: false });
  }
}

// ===== Определение жеста =====
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function detectGesture(landmarks) {
  const WRIST = 0;
  const fingers = [
    [8, 6], // указательный: кончик, сустав
    [12, 10], // средний
    [16, 14], // безымянный
    [20, 18], // мизинец
  ];
  const open = fingers.map(
    ([tip, pip]) => dist(landmarks[tip], landmarks[WRIST]) > dist(landmarks[pip], landmarks[WRIST])
  );
  const [index, middle, ring, pinky] = open;
  const count = open.filter(Boolean).length;

  if (count === 0) return 'rock';
  if (index && middle && !ring && !pinky) return 'scissors';
  if (count >= 3) return 'paper';
  return 'unknown';
}

// Самый частый жест среди последних кадров 
function majorityGesture(history) {
  const counts = {};
  history.forEach((g) => {
    if (g !== 'unknown') counts[g] = (counts[g] || 0) + 1;
  });
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'unknown';
}

function formatGesture(g) {
  if (g === 'rock') return 'Камень';
  if (g === 'scissors') return 'Ножницы';
  if (g === 'paper') return 'Бумага';
  return 'Жест не показан';
}

function App() {
  // ===== Состояния  =====
  const [connected, setConnected] = useState(socket.connected);
  const [myId, setMyId] = useState(socket.id || '');
  const [status, setStatus] = useState('menu');
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
  const [cameraReady, setCameraReady] = useState(false);
  const [info, setInfo] = useState('');
  const [remoteStream, setRemoteStream] = useState(null);
  const [peerState, setPeerState] = useState('idle');
  const [hasMic, setHasMic] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [audioBlocked, setAudioBlocked] = useState(false);

  // ===== Refs =====
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const handsRef = useRef(null);
  const localStreamRef = useRef(null);
  const pcRef = useRef(null);
  const pendingOfferRef = useRef(null);
  const pendingIceRef = useRef([]);
  const historyRef = useRef([]);
  const timerRef = useRef(null);
  const submittedRef = useRef(false);
  const initiatorRef = useRef(false);
  const statusRef = useRef('menu');

  const inRoom = status === 'lobby' || status === 'choosing' || status === 'revealing';

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // ===== Таймер =====
  function clearTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function startTimer(seconds) {
    clearTimer();
    let left = seconds;
    setTimer(left);
    timerRef.current = setInterval(() => {
      left -= 1;
      setTimer(left);
      if (left <= 0) {
        clearTimer();
        captureAndSubmit(); // время вышло — фиксируем жест и фото
      }
    }, 1000);
  }

  function captureAndSubmit() {
    if (submittedRef.current) return; // второй раз не отправляем
    submittedRef.current = true;

    const gesture = majorityGesture(historyRef.current);
    const canvas = canvasRef.current;
    const photo = canvas ? canvas.toDataURL('image/jpeg', 0.55) : null;

    setMyGesture(gesture);
    setCurrentDetected(formatGesture(gesture) + ' (зафиксировано)');
    socket.emit('submit-choice', { gesture, photo });
  }

  function handleResults(results) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

    let gesture = 'unknown';
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      const landmarks = results.multiHandLandmarks[0];
      window.drawConnectors(ctx, landmarks, window.HAND_CONNECTIONS, {
        color: '#00FF00',
        lineWidth: 3,
      });
      window.drawLandmarks(ctx, landmarks, { color: '#FF0000', lineWidth: 1, radius: 4 });
      gesture = detectGesture(landmarks);
      if (!submittedRef.current) setCurrentDetected(formatGesture(gesture));
    } else if (!submittedRef.current) {
      setCurrentDetected('Рука не найдена');
    }
    ctx.restore();

    const history = historyRef.current;
    history.push(gesture);
    if (history.length > HISTORY_SIZE) history.shift();
  }

  // ===== WebRTC =====

  function createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('webrtc-ice', { candidate: e.candidate });
    };
    pc.ontrack = (e) => setRemoteStream(e.streams[0]);
    pc.onconnectionstatechange = () => setPeerState(pc.connectionState);

    pcRef.current = pc;
    return pc;
  }

  function addLocalTracks(pc) {
    const stream = localStreamRef.current;
    if (!stream) return;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  }

  async function flushPendingIce(pc) {
    const list = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const candidate of list) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('ICE error:', err);
      }
    }
  }

  async function startPeerAsInitiator() {
    const pc = createPeerConnection();
    addLocalTracks(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { offer: pc.localDescription });
  }

  async function answerOffer(offer) {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    const pc = createPeerConnection();
    await pc.setRemoteDescription(offer);
    addLocalTracks(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { answer: pc.localDescription });
    await flushPendingIce(pc);
  }

  async function handleOffer(offer) {
    if (!localStreamRef.current) {
      pendingOfferRef.current = offer;
      return;
    }
    await answerOffer(offer);
  }

  async function handleAnswer(answer) {
    const pc = pcRef.current;
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    await pc.setRemoteDescription(answer);
    await flushPendingIce(pc);
  }

  async function handleIce(candidate) {
    if (!candidate) return;
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) {
      pendingIceRef.current.push(candidate);     
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('ICE error:', err);
    }
  }

  function closePeerConnection() {
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    pendingOfferRef.current = null;
    pendingIceRef.current = [];
    setRemoteStream(null);
    setPeerState('idle');
  }

  // ===== События от сервера =====
  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      setMyId(socket.id);
    };

    const onDisconnect = () => {
      clearTimer();
      setConnected(false);
      setRoomId('');
      setPlayers([]);
      setStatus('menu');
      setInfo('Связь с сервером потеряна');
    };

    const onRoomCreated = (id) => {
      setRoomId(id);
      setInfo('');
      setStatus('waiting');
    };

    const onPlayerJoined = (data) => {
      initiatorRef.current = data.initiatorId === socket.id; 
      submittedRef.current = false;
      setRoomId(data.roomId);
      setPlayers(data.players);
      setScores(data.scores || {});
      setIsReady(false);
      setReadyState({});
      setInfo('');
      setStatus('lobby');
    };

    const onReadyUpdate = (data) => setReadyState(data.ready);

    const onStartChoosing = ({ duration }) => {
      submittedRef.current = false;
      historyRef.current = [];
      setMyGesture(null);
      setResult(null);
      setStatus('choosing');
      startTimer(duration);
    };

    const onRoundResult = (data) => {
      clearTimer();
      setResult(data);
      setScores(data.scores);
      setStatus('revealing');
    };

    const onResetRound = () => {
      submittedRef.current = false;
      setStatus('lobby');
      setIsReady(false);
      setReadyState({});
      setMyGesture(null);
      setResult(null);
      setCurrentDetected('Покажи руку...');
    };

    const onOpponentLeft = (data) => {
      clearTimer();
      submittedRef.current = false;
      setRoomId(data.roomId);
      setPlayers(data.players);
      setScores(data.scores || {});
      setIsReady(false);
      setReadyState({});
      setMyGesture(null);
      setResult(null);
      setInfo('Соперник вышел. Можно позвать нового игрока с тем же кодом.');
      setStatus('waiting');
    };

    const onRoomError = (msg) => alert(msg);

    const onOffer = ({ offer }) => handleOffer(offer).catch((e) => console.error('offer:', e));
    const onAnswer = ({ answer }) => handleAnswer(answer).catch((e) => console.error('answer:', e));
    const onIce = ({ candidate }) => handleIce(candidate);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room-created', onRoomCreated);
    socket.on('player-joined', onPlayerJoined);
    socket.on('player-ready-update', onReadyUpdate);
    socket.on('start-choosing', onStartChoosing);
    socket.on('round-result', onRoundResult);
    socket.on('reset-round', onResetRound);
    socket.on('opponent-left', onOpponentLeft);
    socket.on('room-error', onRoomError);
    socket.on('webrtc-offer', onOffer);
    socket.on('webrtc-answer', onAnswer);
    socket.on('webrtc-ice', onIce);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room-created', onRoomCreated);
      socket.off('player-joined', onPlayerJoined);
      socket.off('player-ready-update', onReadyUpdate);
      socket.off('start-choosing', onStartChoosing);
      socket.off('round-result', onRoundResult);
      socket.off('reset-round', onResetRound);
      socket.off('opponent-left', onOpponentLeft);
      socket.off('room-error', onRoomError);
      socket.off('webrtc-offer', onOffer);
      socket.off('webrtc-answer', onAnswer);
      socket.off('webrtc-ice', onIce);
      clearTimer();
    };
  }, []);
.
  useEffect(() => {
    if (!inRoom) return;
    let cancelled = false;
    setCameraReady(false);
    setCurrentDetected('Включаю камеру...');

    async function init() {
      try {
        if (!navigator.mediaDevices) {
          throw new Error('камера работает только на localhost или по HTTPS');
        }

        const stream = await getLocalStream();
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        setHasMic(stream.getAudioTracks().length > 0);
        setMicOn(true);

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        try {
          if (initiatorRef.current) {
            await startPeerAsInitiator();
          } else if (pendingOfferRef.current) {
            const offer = pendingOfferRef.current;
            pendingOfferRef.current = null;
            await answerOffer(offer);
          }
        } catch (err) {
          console.error('Ошибка WebRTC (игра продолжится без видео соперника):', err);
          setPeerState('failed');
        }
        if (cancelled) return;

        setCurrentDetected('Загружаю модель руки...');
        await loadScript(`${MEDIAPIPE_CDN}/drawing_utils/drawing_utils.js`);
        await loadScript(`${MEDIAPIPE_CDN}/hands/hands.js`);
        if (cancelled) return;

        if (!handsRef.current) {
          const hands = new window.Hands({
            locateFile: (file) => `${MEDIAPIPE_CDN}/hands/${file}`,
          });
          hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 1,
            minDetectionConfidence: 0.7,
            minTrackingConfidence: 0.7,
          });
          hands.onResults(handleResults);
          await hands.initialize();
          handsRef.current = hands;
        }
        if (cancelled) return;

        const sendFrame = async () => {
          if (cancelled) return;
          if (statusRef.current !== 'revealing' && video.readyState >= 2) {
            try {
              await handsRef.current.send({ image: video });
            } catch (err) {
              console.warn('MediaPipe:', err);
            }
          }
          if (!cancelled) requestAnimationFrame(sendFrame);
        };
        sendFrame();

        setCameraReady(true);
        setCurrentDetected('Покажи руку...');
      } catch (err) {
        console.error('Ошибка камеры/MediaPipe:', err);
        if (!cancelled) {
          setCurrentDetected(
            'Ошибка камеры: ' + (err.message || err.name) + '. Проверь доступ и обнови страницу (F5).'
          );
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      closePeerConnection();
    };
  }, [inRoom]);

  useEffect(() => {
    const el = remoteVideoRef.current;
    if (!el || !remoteStream) return;
    if (el.srcObject !== remoteStream) el.srcObject = remoteStream;
    el.play()
      .then(() => setAudioBlocked(false))
      .catch(() => setAudioBlocked(true));
  }, [remoteStream, inRoom]);

  // ===== Действия игрока =====
  const createRoom = () => socket.emit('create-room');

  const joinRoom = () => {
    const code = inputRoom.trim().toUpperCase();
    if (code) socket.emit('join-room', code);
  };

  const handleReady = () => {
    setIsReady(true);
    socket.emit('player-ready');
  };

  const nextRound = () => socket.emit('next-round');

  const toggleMic = () => {
    const next = !micOn;
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = next));
    }
    setMicOn(next);
  };

  const enableRemoteMedia = () => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.play().then(() => setAudioBlocked(false)).catch(() => {});
    }
  };

  const who = (id) => (id === myId ? 'Ты' : 'Соперник');
  const opponentReady = Object.entries(readyState).some(([id, ready]) => id !== myId && ready);

  // ===== Рендер =====
  if (status === 'menu') {
    return (
      <div className="container">
        <h1>Камень-Ножницы-Бумага</h1>
        <p className="subtitle">с распознаванием жестов</p>
        {info && <p className="info">{info}</p>}
        {!connected && <p className="info">Подключаюсь к серверу...</p>}
        <button className="btn" onClick={createRoom} disabled={!connected}>
          Создать комнату
        </button>
        <div className="join-block">
          <input
            placeholder="Код комнаты"
            value={inputRoom}
            onChange={(e) => setInputRoom(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && joinRoom()}
          />
          <button className="btn" onClick={joinRoom} disabled={!connected}>
            Войти
          </button>
        </div>
      </div>
    );
  }

  if (status === 'waiting') {
    return (
      <div className="container">
        <h2>Комната создана</h2>
        <p className="room-code">
          Код: <b>{roomId}</b>
        </p>
        {info && <p className="info">{info}</p>}
        <p>Отправь код другу и жди...</p>
      </div>
    );
  }

  const hideOpponent = status === 'choosing';
  const isRevealing = status === 'revealing';
  const remoteMessage =
    peerState === 'failed'
      ? 'Видео соперника не подключилось (игра работает и без него)'
      : 'Ожидаем видео соперника...';

  return (
    <div className="container">
      <h2>Комната: {roomId}</h2>
      <p>Игроков: {players.length}/2</p>

      <div className="scores">
        {players.map((id, i) => (
          <span key={id}>
            {who(id)}: {scores[id] || 0}
            {i === 0 ? ' — ' : ''}
          </span>
        ))}
      </div>

      <div className={'cameras' + (isRevealing ? ' compact' : '')}>
        <div className="camera-box">
          <div className="camera-label">Ты</div>
          <div className="video-wrapper">
            <video
              ref={videoRef}
              className="local-video"
              style={{ display: isRevealing ? 'block' : 'none' }}
              playsInline
              muted
              autoPlay
            ></video>
            <canvas
              ref={canvasRef}
              width="640"
              height="480"
              style={{ display: isRevealing ? 'none' : 'block' }}
            ></canvas>
          </div>
          {!isRevealing && (
            <div className="detected">
              Сейчас вижу: <b>{currentDetected}</b>
            </div>
          )}
          {hasMic && (
            <button className="btn mic-btn" onClick={toggleMic}>
              {micOn ? 'Микрофон включён' : 'Микрофон выключен'}
            </button>
          )}
        </div>

        <div className="camera-box">
          <div className="camera-label">Соперник</div>
          <div className={'video-wrapper' + (hideOpponent ? ' remote-hidden' : '')}>
            <video
              ref={remoteVideoRef}
              className="remote-video"
              style={{ display: remoteStream ? 'block' : 'none' }}
              autoPlay
              playsInline
            ></video>
            {!remoteStream && <div className="no-remote">{remoteMessage}</div>}
            {hideOpponent && (
              <div className="remote-cover">
                <span>{OPPONENT_HINT}</span>
              </div>
            )}
          </div>
          {audioBlocked && remoteStream && (
            <button className="btn mic-btn" onClick={enableRemoteMedia}>
              Включить звук соперника
            </button>
          )}
        </div>
      </div>

      {status === 'lobby' && (
        <div className="lobby">
          <p>Нажми «Готов», когда будешь готов показать жест</p>
          {opponentReady && !isReady && <p className="info">Соперник уже готов!</p>}
          <button
            className="btn ready-btn"
            onClick={handleReady}
            disabled={isReady || !cameraReady}
          >
            {isReady
              ? 'Ожидаем второго игрока...'
              : cameraReady
              ? 'Готов!'
              : 'Загружаю камеру...'}
          </button>
        </div>
      )}

      {status === 'choosing' && (
        <div className="choosing">
          <div className="timer">Таймер: {timer}</div>
          {myGesture && <p className="fixed">Жест зафиксирован! Ждём соперника...</p>}
        </div>
      )}

      {status === 'revealing' && result && (
        <div className="revealing">
          <h3>Результат раунда</h3>

          <div className="photos">
            {players.map((id) => {
              const choice = result.choices[id];
              if (!choice) return null;
              return (
                <div key={id} className="player-result">
                  <h4>{who(id)}</h4>
                  {choice.photo ? (
                    <img src={choice.photo} alt="gesture" className="photo" />
                  ) : (
                    <div className="photo no-photo">Нет фото</div>
                  )}
                  <p className="gesture-label">{formatGesture(choice.gesture)}</p>
                </div>
              );
            })}
          </div>

          <div className="winner">
            {result.winner === 'draw' ? (
              <p>Ничья!</p>
            ) : result.winner === myId ? (
              <p>🎉 Ты победил!</p>
            ) : (
              <p>Победил соперник</p>
            )}
          </div>

          <p className="info">Камеры и звук включены, можно обсудить раунд</p>

          <button className="btn" onClick={nextRound}>
            Следующий раунд
          </button>
        </div>
      )}
    </div>
  );
}

export default App;