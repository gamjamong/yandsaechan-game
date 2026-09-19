// server.js
// 몽골 초원 테마 실시간 멀티플레이 "내 머리 속 제시어" 게임 서버
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const MIN_PLAYERS_TO_START = 2;
const WORD_PHASE_SECONDS = 30;

// 제시어를 아무도 입력하지 않았을 때를 대비한 예비 단어 풀
const FALLBACK_WORDS = [
  '호랑이', '독수리', '피아노', '스마트폰', '무지개',
  '자전거', '고구마', '우주비행사', '마라탕', '탬버린',
];

app.use(express.static(path.join(__dirname, 'public')));

// roomCode(string) -> room object
const rooms = new Map();

function createRoom(code) {
  return {
    code,
    phase: 'lobby', // 'lobby' | 'wordInput' | 'reveal'
    players: new Map(), // socketId -> player
    timer: null,
    timeLeft: WORD_PHASE_SECONDS,
  };
}

function getPublicPlayers(room) {
  // 클라이언트 목록/로비 렌더링용 - 제시어 내용은 노출하지 않음
  return Array.from(room.players.values()).map((p) => ({
    id: p.id,
    nickname: p.nickname,
    ready: p.ready,
    submitted: !!p.word,
  }));
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', {
    code: room.code,
    phase: room.phase,
    players: getPublicPlayers(room),
    timeLeft: room.timeLeft,
    minPlayers: MIN_PLAYERS_TO_START,
    maxPlayers: MAX_PLAYERS,
  });
}

// Sattolo's algorithm: n>=2 일 때 "고정점이 하나도 없는" 단일 순환 치환(교란순열)을 생성한다.
// 즉 반드시 idx[i] !== i 가 모든 i에 대해 성립하므로, 자기 자신의 제시어를 받는 경우가 원천 차단된다.
function sattoloDerangementIndices(n) {
  const arr = [...Array(n).keys()];
  if (n < 2) return arr;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * i); // j는 [0, i-1] 범위 (i 자신은 제외 - Fisher-Yates와의 차이점)
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startWordPhase(room) {
  room.phase = 'wordInput';
  room.timeLeft = WORD_PHASE_SECONDS;
  room.players.forEach((p) => {
    p.word = null;
    p.assignedWord = null;
  });
  broadcastRoom(room);
  io.to(room.code).emit('word_phase_start', { duration: WORD_PHASE_SECONDS });

  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    io.to(room.code).emit('timer_update', { timeLeft: room.timeLeft });

    const allSubmitted =
      room.players.size > 0 &&
      Array.from(room.players.values()).every((p) => !!p.word);

    if (room.timeLeft <= 0 || allSubmitted) {
      clearInterval(room.timer);
      room.timer = null;
      finishWordPhase(room);
    }
  }, 1000);
}

function finishWordPhase(room) {
  if (room.phase !== 'wordInput') return; // 중복 호출 방지
  const players = Array.from(room.players.values());

  // 시간 초과로 제출하지 못한 플레이어는 예비 단어로 자동 채움
  players.forEach((p) => {
    if (!p.word) {
      p.word = FALLBACK_WORDS[Math.floor(Math.random() * FALLBACK_WORDS.length)];
    }
  });

  const n = players.length;
  const derangedIdx = sattoloDerangementIndices(n);

  players.forEach((p, i) => {
    p.assignedWord = players[derangedIdx[i]].word;
  });

  room.phase = 'reveal';
  broadcastRoom(room);

  // 플레이어별로 "본인 제시어만 숨긴" 개인화된 결과를 개별 전송
  players.forEach((p) => {
    const payload = {
      code: room.code,
      players: players.map((other) => ({
        id: other.id,
        nickname: other.nickname,
        isMe: other.id === p.id,
        // 본인의 제시어는 서버에서부터 null로 감춰서 전송 (클라이언트 위변조 방지)
        assignedWord: other.id === p.id ? null : other.assignedWord,
      })),
    };
    io.to(p.id).emit('game_start', payload);
  });
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ nickname, roomCode }, cb) => {
    nickname = (nickname || '').toString().trim().slice(0, 12);
    roomCode = (roomCode || '').toString().trim().toUpperCase().slice(0, 10);

    if (!nickname || !roomCode) {
      return cb && cb({ ok: false, message: '닉네임과 방 코드를 모두 입력해주세요.' });
    }

    let room = rooms.get(roomCode);
    if (!room) {
      room = createRoom(roomCode);
      rooms.set(roomCode, room);
    }

    if (room.phase !== 'lobby') {
      return cb && cb({ ok: false, message: '이미 게임이 진행중인 방입니다. 새 방 코드를 이용해주세요.' });
    }
    if (room.players.size >= MAX_PLAYERS) {
      return cb && cb({ ok: false, message: '방 인원이 가득 찼습니다. (최대 6명)' });
    }
    const isDuplicateNickname = Array.from(room.players.values()).some(
      (p) => p.nickname === nickname
    );
    if (isDuplicateNickname) {
      return cb && cb({ ok: false, message: '이미 사용중인 닉네임입니다.' });
    }

    socket.join(roomCode);
    room.players.set(socket.id, {
      id: socket.id,
      nickname,
      ready: false,
      word: null,
      assignedWord: null,
    });
    socket.data.roomCode = roomCode;
    socket.data.nickname = nickname;

    cb && cb({ ok: true, code: roomCode, myId: socket.id });
    broadcastRoom(room);
  });

  socket.on('toggle_ready', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p) return;

    p.ready = !p.ready;
    broadcastRoom(room);

    const allReady =
      room.players.size >= MIN_PLAYERS_TO_START &&
      Array.from(room.players.values()).every((pl) => pl.ready);

    if (allReady) {
      startWordPhase(room);
    }
  });

  socket.on('submit_word', ({ word }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'wordInput') return;
    const p = room.players.get(socket.id);
    if (!p || p.word) return;

    word = (word || '').toString().trim().slice(0, 20);
    if (!word) return;

    p.word = word;
    broadcastRoom(room);

    const allSubmitted = Array.from(room.players.values()).every((pl) => !!pl.word);
    if (allSubmitted) {
      if (room.timer) {
        clearInterval(room.timer);
        room.timer = null;
      }
      finishWordPhase(room);
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(roomCode);
      return;
    }
    broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  console.log(`서버가 http://localhost:${PORT} 에서 실행중입니다.`);
});
