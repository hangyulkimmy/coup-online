// Coup online — Express + Socket.IO server. Serves the client and relays
// game moves. All game rules live in game.js.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { CoupGame } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();          // code -> CoupGame
const socketToPlayer = new Map(); // socket.id -> { code, playerId }

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no easily-confused chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Push each player their personalized view of the game.
function broadcast(game) {
  for (const p of game.players) {
    const sockets = [...socketToPlayer.entries()]
      .filter(([, v]) => v.code === game.code && v.playerId === p.id)
      .map(([sid]) => sid);
    for (const sid of sockets) io.to(sid).emit('state', game.stateFor(p.id));
  }
}

// Re-arm the decision timer, then broadcast (so the new deadline is included).
function update(game) {
  game.armTimer();
  broadcast(game);
}

io.on('connection', (socket) => {
  // Wrap a game mutation: run it, broadcast, or report the error.
  const act = (fn) => {
    try {
      const info = socketToPlayer.get(socket.id);
      if (!info) throw new Error('You are not in a room');
      const game = rooms.get(info.code);
      if (!game) throw new Error('Room no longer exists');
      fn(game, info.playerId);
      update(game);
    } catch (err) {
      socket.emit('errorMsg', err.message);
    }
  };

  socket.on('createRoom', ({ name }) => {
    try {
      name = (name || '').trim();
      if (!name) throw new Error('Enter a name');
      const code = makeCode();
      const game = new CoupGame(code);
      game.onChange = () => update(game); // re-broadcast when a timeout fires
      const playerId = crypto.randomUUID();
      game.addPlayer(playerId, name);
      rooms.set(code, game);
      socket.join(code);
      socketToPlayer.set(socket.id, { code, playerId });
      socket.emit('joined', { code, playerId });
      broadcast(game);
    } catch (err) { socket.emit('errorMsg', err.message); }
  });

  socket.on('joinRoom', ({ code, name }) => {
    try {
      code = (code || '').trim().toUpperCase();
      name = (name || '').trim();
      if (!name) throw new Error('Enter a name');
      const game = rooms.get(code);
      if (!game) throw new Error('No room with that code');
      const playerId = crypto.randomUUID();
      game.addPlayer(playerId, name);
      socket.join(code);
      socketToPlayer.set(socket.id, { code, playerId });
      socket.emit('joined', { code, playerId });
      broadcast(game);
    } catch (err) { socket.emit('errorMsg', err.message); }
  });

  // Reattach after a refresh/reconnect using the stored playerId.
  socket.on('rejoin', ({ code, playerId }) => {
    code = (code || '').trim().toUpperCase();
    const game = rooms.get(code);
    if (!game) return socket.emit('rejoinFailed');
    const player = game.get(playerId);
    if (!player) return socket.emit('rejoinFailed');
    player.connected = true;
    socket.join(code);
    socketToPlayer.set(socket.id, { code, playerId });
    socket.emit('joined', { code, playerId });
    broadcast(game);
  });

  socket.on('setOption', ({ key, value }) => act((g, pid) => g.setOption(pid, key, value)));
  socket.on('kickPlayer', ({ targetId }) => act((g, pid) => g.kickPlayer(pid, targetId)));
  socket.on('startGame', () => act((g, pid) => g.start(pid)));
  socket.on('action', ({ action, target }) => act((g, pid) => g.doAction(pid, action, target)));
  socket.on('respond', ({ type, character }) => act((g, pid) => g.respond(pid, type, character)));
  socket.on('loseCard', ({ index }) => act((g, pid) => g.loseCard(pid, index)));
  socket.on('exchange', ({ indices }) => act((g, pid) => g.exchangeSelect(pid, indices)));
  socket.on('interrogateShow', ({ index }) => act((g, pid) => g.interrogateShow(pid, index)));
  socket.on('interrogateDecide', ({ forceSwap }) => act((g, pid) => g.interrogateDecide(pid, forceSwap)));

  socket.on('leaveRoom', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const game = rooms.get(info.code);
    if (game) { game.removePlayer(info.playerId); cleanup(game); broadcast(game); }
    socketToPlayer.delete(socket.id);
  });

  socket.on('disconnect', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;
    const game = rooms.get(info.code);
    if (game) {
      const player = game.get(info.playerId);
      if (game.phase === 'lobby') {
        game.removePlayer(info.playerId);
      } else if (player) {
        player.connected = false; // keep their seat; they can rejoin
      }
      cleanup(game);
      broadcast(game);
    }
    socketToPlayer.delete(socket.id);
  });
});

// Drop empty rooms so codes get recycled.
function cleanup(game) {
  if (game.players.length === 0) {
    game.clearTimer();
    rooms.delete(game.code);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Coup running on http://localhost:${PORT}`));
