/* Coup Online — client. Renders state pushed from the server and sends moves. */
const socket = io();

const ACTION_INFO = {
  income:      { name: 'Income',      desc: '+1 coin. Safe.', },
  foreign_aid: { name: 'Foreign Aid', desc: '+2 coins. Blockable by Duke.' },
  coup:        { name: 'Coup',        desc: 'Pay 7. Kill an influence.', cost: 7, target: true },
  tax:         { name: 'Tax',         desc: '+3 coins.', char: 'Duke' },
  assassinate: { name: 'Assassinate', desc: 'Pay 3. Kill an influence.', char: 'Assassin', cost: 3, target: true },
  steal:       { name: 'Steal',       desc: 'Take 2 coins.', char: 'Captain', target: true },
  exchange:    { name: 'Exchange',    desc: 'Swap cards with the deck.', char: 'Ambassador' },
};

const CARD_DESC = {
  Duke: 'Tax +3 · blocks Foreign Aid',
  Assassin: 'Assassinate (pay 3)',
  Captain: 'Steal 2 · blocks Steal',
  Ambassador: 'Exchange · blocks Steal',
  Inquisitor: 'Exchange 1 · Interrogate · blocks Steal',
  Contessa: 'Blocks Assassination',
};

// Characters that can block a given action (steal's 2nd blocker depends on mode).
function blockCharsFor(action) {
  const inq = state && state.options && state.options.inquisitor;
  return {
    foreign_aid: ['Duke'],
    assassinate: ['Contessa'],
    steal: ['Captain', inq ? 'Inquisitor' : 'Ambassador'],
  }[action] || [];
}

let state = null;
let myId = localStorage.getItem('coup_playerId');
let myCode = localStorage.getItem('coup_code');
let pendingTarget = null; // action awaiting a target pick
let exchangeSelection = [];

// ---------- element helpers ----------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------- home actions ----------
$('createBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  if (!name) return toast('Enter a name first');
  socket.emit('createRoom', { name });
};
$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return toast('Enter a name first');
  if (!code) return toast('Enter a room code');
  socket.emit('joinRoom', { name, code });
};
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('createBtn').click(); });

$('copyBtn').onclick = () => {
  navigator.clipboard.writeText(myCode).then(() => toast('Room code copied!'));
};
$('leaveBtn').onclick = () => {
  socket.emit('leaveRoom');
  localStorage.removeItem('coup_playerId');
  localStorage.removeItem('coup_code');
  location.reload();
};
$('startBtn').onclick = () => socket.emit('startGame');

// ---------- socket events ----------
socket.on('connect', () => {
  if (myId && myCode) socket.emit('rejoin', { code: myCode, playerId: myId });
});
socket.on('joined', ({ code, playerId }) => {
  myId = playerId; myCode = code;
  localStorage.setItem('coup_playerId', playerId);
  localStorage.setItem('coup_code', code);
  $('home').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('roomCode').textContent = code;
});
socket.on('rejoinFailed', () => {
  localStorage.removeItem('coup_playerId');
  localStorage.removeItem('coup_code');
});
socket.on('errorMsg', (msg) => toast(msg));
socket.on('state', (s) => { state = s; render(); });

// ---------- rendering ----------
function render() {
  if (!state) return;
  $('roomCode').textContent = state.code;

  if (state.phase === 'lobby') {
    $('lobbyView').classList.remove('hidden');
    $('gameView').classList.add('hidden');
    renderLobby();
  } else {
    $('lobbyView').classList.add('hidden');
    $('gameView').classList.remove('hidden');
    renderBoard();
    renderControls();
    renderLog();
  }
}

function renderLobby() {
  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  state.players.forEach((p, i) => {
    const li = el('li', '', `<span class="dot"></span> ${escapeHtml(p.name)}`);
    if (i === 0) li.appendChild(el('span', 'host-tag', 'HOST'));
    if (p.id === state.you) li.appendChild(el('span', 'you-badge', 'YOU'));
    ul.appendChild(li);
  });
  // Game options (host can toggle; everyone sees the current setting).
  const opts = $('lobbyOptions');
  opts.innerHTML = '';
  const inqOn = state.options && state.options.inquisitor;
  const row = el('div', 'option-row');
  row.innerHTML = `<div class="opt-text"><strong>Inquisitor mode</strong>` +
    `<span>Replaces Ambassador — 1-card exchange, blocks steal, adds Interrogate.</span></div>`;
  if (state.isHost) {
    const toggle = el('button', `toggle ${inqOn ? 'on' : ''}`, `<span class="knob"></span>`);
    toggle.onclick = () => socket.emit('setOption', { key: 'inquisitor', value: !inqOn });
    row.appendChild(toggle);
  } else {
    row.appendChild(el('span', `status-pill ${inqOn ? 'on' : ''}`, inqOn ? 'ON' : 'OFF'));
  }
  opts.appendChild(row);

  // Turn timer option (+ duration picker when on).
  const timerOn = state.options && state.options.timer;
  const secs = state.options ? state.options.turnSeconds : 30;
  const row2 = el('div', 'option-row');
  row2.innerHTML = `<div class="opt-text"><strong>Turn timer</strong>` +
    `<span>Auto-acts if someone stalls — Income on your turn, Pass on prompts.</span></div>`;
  if (state.isHost) {
    if (timerOn) {
      const seg = el('div', 'seg');
      [20, 30, 45].forEach(s => {
        const b = el('button', `seg-btn ${secs === s ? 'active' : ''}`, s + 's');
        b.onclick = () => socket.emit('setOption', { key: 'turnSeconds', value: s });
        seg.appendChild(b);
      });
      row2.appendChild(seg);
    }
    const toggle = el('button', `toggle ${timerOn ? 'on' : ''}`, `<span class="knob"></span>`);
    toggle.onclick = () => socket.emit('setOption', { key: 'timer', value: !timerOn });
    row2.appendChild(toggle);
  } else {
    row2.appendChild(el('span', `status-pill ${timerOn ? 'on' : ''}`, timerOn ? `${secs}s` : 'OFF'));
  }
  opts.appendChild(row2);

  const startBtn = $('startBtn');
  if (state.isHost) {
    startBtn.classList.remove('hidden');
    startBtn.disabled = state.players.length < 2;
    $('lobbyHint').textContent = state.players.length < 2
      ? 'Need at least 2 players to start.'
      : `${state.players.length} players ready. Start when everyone's in!`;
  } else {
    startBtn.classList.add('hidden');
    $('lobbyHint').textContent = 'Waiting for the host to start the game…';
  }
}

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  for (const p of state.players) {
    const wrap = el('div', 'player');
    if (p.isCurrent) wrap.classList.add('current');
    if (p.id === state.you) wrap.classList.add('you');
    if (!p.alive) wrap.classList.add('dead');

    const top = el('div', 'player-top');
    const nameEl = el('div', 'player-name',
      `<span class="dot ${p.connected ? '' : 'off'}"></span>${escapeHtml(p.name)}`);
    if (p.id === state.you) nameEl.appendChild(el('span', 'you-badge', 'YOU'));
    if (p.isCurrent) nameEl.appendChild(el('span', 'turn-badge', 'TURN'));
    top.appendChild(nameEl);
    top.appendChild(el('span', 'coins', String(p.coins)));
    wrap.appendChild(top);

    const hand = el('div', 'hand');
    // Own hidden cards (visible only to you).
    if (p.cards) {
      p.cards.forEach(c => hand.appendChild(cardEl(c, false)));
    } else {
      for (let i = 0; i < p.influenceCount; i++) hand.appendChild(cardEl(null, false));
    }
    // Revealed (dead) cards, shown to everyone.
    p.revealed.forEach(c => hand.appendChild(cardEl(c, true)));
    wrap.appendChild(hand);
    board.appendChild(wrap);
  }
}

// Build a card tile. Tries /images/<char>.png; falls back to a colored tile.
function cardEl(character, dead) {
  if (!character) {
    const c = el('div', 'mini-card hidden-card');
    return c;
  }
  const c = el('div', `mini-card card-${character}${dead ? ' dead' : ''}`);
  c.title = CARD_DESC[character] || character;
  const label = el('span', 'lbl', character);
  c.appendChild(label);
  // Attempt to load a custom image; keep the colored fallback (with label) if it fails.
  // Card art already includes the name, so hide the overlay label once it loads.
  const img = new Image();
  img.onload = () => {
    c.style.backgroundImage = `url(images/${character.toLowerCase()}.png)`;
    c.classList.add('has-img');
    label.style.display = 'none';
  };
  img.src = `images/${character.toLowerCase()}.png`;
  return c;
}

let timerRAF = null;
function renderTimer(container) {
  cancelAnimationFrame(timerRAF);
  if (!state.timer) return;
  const total = state.timer.total;
  const endAt = Date.now() + state.timer.msLeft;
  const wrap = el('div', 'timer-wrap');
  const num = el('div', 'timer-num');
  const bar = el('div', 'timer-bar');
  const fill = el('div', 'timer-fill');
  bar.appendChild(fill);
  wrap.appendChild(num);
  wrap.appendChild(bar);
  container.appendChild(wrap);
  const tick = () => {
    const left = Math.max(0, endAt - Date.now());
    const pct = total ? (left / total) * 100 : 0;
    fill.style.width = pct + '%';
    num.textContent = Math.ceil(left / 1000) + 's';
    fill.classList.toggle('low', left <= 6000);
    if (left > 0) timerRAF = requestAnimationFrame(tick);
  };
  tick();
}

function renderControls() {
  const c = $('controls');
  c.innerHTML = '';
  renderTimer(c);

  if (state.phase === 'game_over') {
    const go = el('div', 'gameover');
    go.appendChild(el('h3', '', 'Game over'));
    go.appendChild(el('div', 'winner', state.winner ? `🏆 ${escapeHtml(state.winner.name)} wins!` : 'No winner'));
    if (state.isHost) {
      const again = el('button', 'btn primary small', 'Back to lobby');
      again.onclick = () => location.reload();
      go.appendChild(again);
    } else {
      go.appendChild(el('p', 'hint', 'Waiting for a new game…'));
    }
    c.appendChild(go);
    return;
  }

  // You must reveal/lose a card.
  if (state.phase === 'lose_influence' && state.lose && state.lose.playerId === state.you) {
    c.appendChild(el('h3', '', 'You lost an influence — choose a card to reveal'));
    const me = state.players.find(p => p.id === state.you);
    const grid = el('div', 'target-picker');
    me.cards.forEach((card, i) => {
      const b = el('button', 'btn block small', card);
      b.onclick = () => socket.emit('loseCard', { index: i });
      grid.appendChild(b);
    });
    c.appendChild(grid);
    return;
  }
  if (state.phase === 'lose_influence') {
    const who = state.players.find(p => p.id === state.lose.playerId);
    c.appendChild(el('p', 'waiting-note', `Waiting for ${who ? who.name : 'a player'} to reveal a card…`));
    return;
  }

  // Exchange (Ambassador).
  if (state.phase === 'exchange') {
    if (state.exchange && state.exchange.cards) return renderExchange(c);
    const who = state.players.find(p => p.id === state.exchange.playerId);
    c.appendChild(el('p', 'waiting-note', `Waiting for ${who ? who.name : 'a player'} to exchange…`));
    return;
  }

  // Interrogation (Inquisitor).
  if (state.phase === 'interrogate') return renderInterrogate(c);

  // A response is being collected.
  if (state.phase === 'response') return renderResponse(c);

  // Normal action phase.
  if (state.phase === 'action') {
    if (state.currentPlayerId === state.you) return renderActions(c);
    const cur = state.players.find(p => p.id === state.currentPlayerId);
    c.appendChild(el('p', 'waiting-note', `Waiting for ${cur ? cur.name : 'the current player'} to act…`));
  }
}

// The actions available this turn, adjusted for Inquisitor mode.
function availableActions() {
  const inq = state.options && state.options.inquisitor;
  const list = { ...ACTION_INFO };
  if (inq) {
    list.exchange = { name: 'Exchange', desc: 'Swap 1 card with the deck.', char: 'Inquisitor' };
    list.interrogate = { name: 'Interrogate', desc: 'Peek a card; maybe force a swap.', char: 'Inquisitor', target: true };
  }
  return list;
}

function renderActions(c) {
  const me = state.players.find(p => p.id === state.you);
  const actions = availableActions();

  if (pendingTarget) {
    const info = actions[pendingTarget];
    c.appendChild(el('h3', '', `${info.name} — choose a target`));
    const grid = el('div', 'target-picker');
    state.players.filter(p => p.alive && p.id !== state.you).forEach(p => {
      const b = el('button', 'btn small', escapeHtml(p.name));
      b.onclick = () => { socket.emit('action', { action: pendingTarget, target: p.id }); pendingTarget = null; };
      grid.appendChild(b);
    });
    const cancel = el('button', 'btn small pass', 'Cancel');
    cancel.onclick = () => { pendingTarget = null; render(); };
    grid.appendChild(cancel);
    c.appendChild(grid);
    return;
  }

  c.appendChild(el('h3', '', 'Your turn — choose an action'));
  const mustCoup = me.coins >= 10;
  if (mustCoup) c.appendChild(el('p', 'prompt', 'You have 10+ coins — you must Coup.'));
  const grid = el('div', 'action-grid');

  for (const [key, info] of Object.entries(actions)) {
    const btn = el('button', 'act');
    btn.innerHTML = `<span class="a-name">${info.name}</span>` +
      (info.char ? `<span class="a-char">claim ${info.char}</span>` : '') +
      `<span class="a-desc">${info.desc}</span>`;
    let disabled = false;
    if (info.cost && me.coins < info.cost) disabled = true;
    if (mustCoup && key !== 'coup') disabled = true;
    btn.disabled = disabled;
    btn.onclick = () => {
      if (info.target) { pendingTarget = key; render(); }
      else socket.emit('action', { action: key });
    };
    grid.appendChild(btn);
  }
  c.appendChild(grid);
}

function renderResponse(c) {
  const p = state.pending;
  const actor = state.players.find(x => x.id === p.actorId);
  const target = p.targetId ? state.players.find(x => x.id === p.targetId) : null;
  const amResponder = p.waitingOn.includes(state.you);

  // Describe what's happening.
  let headline = '';
  if (p.window === 'challenge') {
    headline = `${actor.name} claims ${p.character}` + (target ? ` on ${target.name}` : '') + '. Challenge it?';
  } else if (p.window === 'block') {
    headline = `${actor.name} is doing ${ACTION_INFO[p.action].name}` + (target ? ` on ${target.name}` : '') + '. Block it?';
  } else if (p.window === 'block_challenge') {
    const blocker = state.players.find(x => x.id === p.blockerId);
    headline = `${blocker.name} claims ${p.blockCharacter} to block. Challenge the block?`;
  }
  c.appendChild(el('h3', '', headline));

  if (!amResponder) {
    const names = p.waitingOn.map(id => (state.players.find(x => x.id === id) || {}).name).filter(Boolean);
    c.appendChild(el('p', 'waiting-note',
      names.length ? `Waiting on: ${names.join(', ')}` : 'Resolving…'));
    return;
  }

  const btns = el('div', 'resp-btns');

  // Challenge option.
  if (p.window === 'challenge' || p.window === 'block_challenge') {
    const b = el('button', 'btn challenge', 'Challenge');
    b.onclick = () => socket.emit('respond', { type: 'challenge' });
    btns.appendChild(b);
  }

  // Block option (choose a valid blocking character).
  if (p.window === 'block') {
    blockCharsFor(p.action).forEach(ch => {
      const b = el('button', 'btn block', `Block (${ch})`);
      b.onclick = () => socket.emit('respond', { type: 'block', character: ch });
      btns.appendChild(b);
    });
  }

  const pass = el('button', 'btn pass', p.window === 'block' ? 'Allow' : 'Pass');
  pass.onclick = () => socket.emit('respond', { type: 'pass' });
  btns.appendChild(pass);

  c.appendChild(btns);
}

function renderInterrogate(c) {
  const it = state.interrogate;
  const inq = state.players.find(p => p.id === it.inquisitorId);
  const tgt = state.players.find(p => p.id === it.targetId);

  // Target must choose a card to show the Inquisitor.
  if (it.stage === 'show') {
    if (it.targetId === state.you) {
      c.appendChild(el('h3', '', `${inq.name} is interrogating you — choose a card to show`));
      const me = state.players.find(p => p.id === state.you);
      const grid = el('div', 'target-picker');
      me.cards.forEach((card, i) => {
        const b = el('button', 'btn block small', card);
        b.onclick = () => socket.emit('interrogateShow', { index: i });
        grid.appendChild(b);
      });
      c.appendChild(grid);
    } else {
      c.appendChild(el('p', 'waiting-note', `${tgt.name} is choosing a card to show ${inq.name}…`));
    }
    return;
  }

  // Inquisitor decides whether to force a swap.
  if (it.stage === 'decide') {
    if (it.inquisitorId === state.you) {
      c.appendChild(el('h3', '', `${tgt.name} showed you: ${it.shownCard}`));
      c.appendChild(el('p', 'prompt', 'Let them keep it, or force them to shuffle it away and draw a new card.'));
      const btns = el('div', 'resp-btns');
      const keep = el('button', 'btn pass', 'Let them keep it');
      keep.onclick = () => socket.emit('interrogateDecide', { forceSwap: false });
      const swap = el('button', 'btn challenge', 'Force a swap');
      swap.onclick = () => socket.emit('interrogateDecide', { forceSwap: true });
      btns.appendChild(keep); btns.appendChild(swap);
      c.appendChild(btns);
    } else {
      c.appendChild(el('p', 'waiting-note', `${inq.name} is deciding what to do with ${tgt.name}'s card…`));
    }
    return;
  }
}

function renderExchange(c) {
  const ex = state.exchange;
  c.appendChild(el('h3', '', `Exchange — keep ${ex.keep} card${ex.keep > 1 ? 's' : ''}`));
  c.appendChild(el('p', 'prompt', 'Click cards to keep them, then confirm.'));
  const grid = el('div', 'target-picker');
  ex.cards.forEach((card, i) => {
    const selected = exchangeSelection.includes(i);
    const b = el('button', `btn small ${selected ? 'block' : 'pass'}`, `${selected ? '✓ ' : ''}${card}`);
    b.onclick = () => {
      if (selected) exchangeSelection = exchangeSelection.filter(x => x !== i);
      else if (exchangeSelection.length < ex.keep) exchangeSelection.push(i);
      else return toast(`Only keep ${ex.keep}`);
      renderControls();
    };
    grid.appendChild(b);
  });
  c.appendChild(grid);
  const confirm = el('button', 'btn primary small', `Confirm (${exchangeSelection.length}/${ex.keep})`);
  confirm.disabled = exchangeSelection.length !== ex.keep;
  confirm.onclick = () => { socket.emit('exchange', { indices: exchangeSelection }); exchangeSelection = []; };
  c.appendChild(confirm);
}

function renderLog() {
  const log = $('log');
  log.innerHTML = '';
  state.log.forEach(line => log.appendChild(el('div', '', escapeHtml(line))));
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}
