// Coup game engine — pure state machine, no networking here.
// Handles the tricky part of Coup: claims, challenges, blocks, and bluffing.

const CHARACTERS = ['Duke', 'Assassin', 'Captain', 'Ambassador', 'Contessa'];

// Config for every action a player can declare on their turn.
const ACTIONS = {
  income:      { targeted: false, challengeable: false, blockable: false },
  foreign_aid: { targeted: false, challengeable: false, blockable: true,  blockedBy: ['Duke'] },
  coup:        { targeted: true,  challengeable: false, blockable: false, cost: 7 },
  tax:         { targeted: false, challengeable: true,  blockable: false, character: 'Duke' },
  assassinate: { targeted: true,  challengeable: true,  blockable: true,  character: 'Assassin', blockedBy: ['Contessa'], cost: 3 },
  steal:       { targeted: true,  challengeable: true,  blockable: true,  character: 'Captain',   blockedBy: ['Captain', 'Ambassador'] },
  exchange:    { targeted: false, challengeable: true,  blockable: false, character: 'Ambassador' },
  interrogate: { targeted: true,  challengeable: true,  blockable: false, character: 'Inquisitor' },
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class CoupGame {
  constructor(code) {
    this.code = code;
    this.players = [];        // { id, name, coins, influence:[card], revealed:[card], connected }
    this.deck = [];
    this.phase = 'lobby';     // lobby | action | response | lose_influence | exchange | game_over
    this.turnIndex = 0;
    this.pending = null;      // active action awaiting responses
    this.loseState = null;    // { playerId, next }
    this.exchangeState = null;// { playerId, cards, keep }
    this.interrogateState = null; // { inquisitorId, targetId, stage, shownCard }
    this.options = { inquisitor: false, timer: true, turnSeconds: 30 };
    this.timer = null;            // Node timeout handle for the active countdown
    this.deadline = null;         // epoch ms when the current decision expires
    this.onChange = null;         // server sets this to re-broadcast after a timeout
    this.winner = null;
    this.log = [];
  }

  // ---- players / lobby ----------------------------------------------------

  addPlayer(id, name) {
    if (this.phase !== 'lobby') throw new Error('Game already started');
    if (this.players.length >= 6) throw new Error('Room is full (max 6)');
    if (this.players.some(p => p.name.toLowerCase() === name.toLowerCase()))
      throw new Error('That name is taken in this room');
    const player = { id, name, coins: 0, influence: [], revealed: [], connected: true };
    this.players.push(player);
    this.pushLog(`${name} joined the room`);
    return player;
  }

  removePlayer(id) {
    if (this.phase === 'lobby') {
      this.players = this.players.filter(p => p.id !== id);
    }
  }

  // Host removes a player. In the lobby they're dropped entirely; mid-game they
  // are eliminated and the game advances cleanly past them.
  kickPlayer(byId, targetId) {
    if (!this.isHost(byId)) throw new Error('Only the host can kick');
    if (byId === targetId) throw new Error("You can't kick yourself");
    const target = this.get(targetId);
    if (!target) throw new Error('No such player');

    if (this.phase === 'lobby') {
      this.removePlayer(targetId);
      this.pushLog(`${target.name} was removed by the host`);
      return;
    }

    // Is the game currently waiting on this player (or on an action they own)?
    const p = this.pending;
    const central =
      (this.phase === 'action' && this.current().id === targetId) ||
      (p && [p.actorId, p.targetId, p.blockerId].includes(targetId)) ||
      (this.loseState && this.loseState.playerId === targetId) ||
      (this.exchangeState && this.exchangeState.playerId === targetId) ||
      (this.interrogateState &&
        [this.interrogateState.inquisitorId, this.interrogateState.targetId].includes(targetId));

    // Eliminate them (reveal all remaining influence).
    target.revealed.push(...target.influence);
    target.influence = [];
    target.connected = false;
    target.kicked = true;
    this.pushLog(`${target.name} was kicked by the host and is out`);

    if (central) {
      // Abort the in-flight action and move to a clean turn boundary.
      this.pending = null;
      this.loseState = null;
      this.exchangeState = null;
      this.interrogateState = null;
      return this.endTurn();
    }

    // If we were waiting on responders, they're no longer one — re-check.
    if (this.phase === 'response') {
      const remaining = this.responders().filter(r => !p.passed.includes(r.id));
      if (remaining.length === 0) {
        if (p.window === 'challenge') this.afterChallenge();
        else if (p.window === 'block') this.resolveEffect();
        else if (p.window === 'block_challenge') this.blockSucceeds();
        return;
      }
    }

    this.checkGameOverAfterKick();
  }

  checkGameOverAfterKick() {
    const alive = this.alivePlayers();
    if (alive.length <= 1) {
      this.pending = null;
      this.loseState = null;
      this.exchangeState = null;
      this.interrogateState = null;
      this.phase = 'game_over';
      this.winner = alive[0] || null;
      if (this.winner) this.pushLog(`🏆 ${this.winner.name} wins the game!`);
    }
  }

  get(id) { return this.players.find(p => p.id === id); }
  alivePlayers() { return this.players.filter(p => p.influence.length > 0); }
  isHost(id) { return this.players.length > 0 && this.players[0].id === id; }

  setOption(byId, key, value) {
    if (!this.isHost(byId)) throw new Error('Only the host can change options');
    if (this.phase !== 'lobby') throw new Error('Options are locked once the game starts');
    if (key === 'inquisitor') {
      this.options.inquisitor = !!value;
      this.pushLog(`Inquisitor mode ${this.options.inquisitor ? 'ON' : 'OFF'}`);
    }
    if (key === 'timer') {
      this.options.timer = !!value;
      this.pushLog(`Turn timer ${this.options.timer ? 'ON' : 'OFF'}`);
    }
    if (key === 'turnSeconds') {
      const allowed = [20, 30, 45];
      if (allowed.includes(value)) this.options.turnSeconds = value;
    }
  }

  // The 5 character types in play (Ambassador swaps for Inquisitor in that mode).
  characterList() {
    return this.options.inquisitor
      ? ['Duke', 'Assassin', 'Captain', 'Inquisitor', 'Contessa']
      : ['Duke', 'Assassin', 'Captain', 'Ambassador', 'Contessa'];
  }

  // Character claimed by an action (exchange/interrogate depend on mode).
  actionCharacter(action) {
    if (action === 'exchange' || action === 'interrogate')
      return this.options.inquisitor ? 'Inquisitor' : 'Ambassador';
    return ACTIONS[action] ? ACTIONS[action].character || null : null;
  }

  // Who can block a given action (steal's second blocker depends on mode).
  blockCharsFor(action) {
    if (action === 'steal') return ['Captain', this.options.inquisitor ? 'Inquisitor' : 'Ambassador'];
    const cfg = ACTIONS[action];
    return cfg && cfg.blockedBy ? cfg.blockedBy : [];
  }

  start(byId) {
    if (!this.isHost(byId)) throw new Error('Only the host can start');
    if (this.phase !== 'lobby') throw new Error('Already started');
    if (this.players.length < 2) throw new Error('Need at least 2 players');

    this.deck = [];
    for (const c of this.characterList()) for (let i = 0; i < 3; i++) this.deck.push(c);
    shuffle(this.deck);

    for (const p of this.players) {
      p.coins = 2;
      p.influence = [this.deck.pop(), this.deck.pop()];
      p.revealed = [];
    }
    this.phase = 'action';
    this.turnIndex = 0;
    this.log = [];
    this.pushLog(`Game started — ${this.players.length} players`);
    this.pushLog(`It's ${this.current().name}'s turn`);
  }

  current() { return this.players[this.turnIndex]; }

  // ---- taking an action ---------------------------------------------------

  doAction(pid, action, targetId) {
    if (this.phase !== 'action') throw new Error('Not accepting actions right now');
    const actor = this.current();
    if (actor.id !== pid) throw new Error("It's not your turn");
    const cfg = ACTIONS[action];
    if (!cfg) throw new Error('Unknown action');
    if (action === 'interrogate' && !this.options.inquisitor)
      throw new Error('Interrogate is only available in Inquisitor mode');

    // Forced coup at 10+ coins.
    if (actor.coins >= 10 && action !== 'coup')
      throw new Error('You have 10+ coins — you must Coup');

    let target = null;
    if (cfg.targeted) {
      target = this.get(targetId);
      if (!target || target.influence.length === 0) throw new Error('Choose a valid target');
      if (target.id === actor.id) throw new Error("You can't target yourself");
    }
    if (cfg.cost && actor.coins < cfg.cost) throw new Error('Not enough coins');

    // Pay upfront costs (coup and assassinate coins are spent regardless of outcome).
    if (cfg.cost) actor.coins -= cfg.cost;

    this.pending = {
      action, actorId: actor.id, targetId: target ? target.id : null,
      character: this.actionCharacter(action),
      window: null, passed: [], blockerId: null, blockCharacter: null,
    };

    // Resolve the un-contestable ones immediately.
    if (action === 'income') {
      actor.coins += 1;
      this.pushLog(`${actor.name} took Income (+1)`);
      this.pending = null;
      return this.endTurn();
    }
    if (action === 'coup') {
      this.pushLog(`${actor.name} launched a Coup on ${target.name}`);
      this.pending = null;
      return this.loseInfluence(target.id, () => this.endTurn());
    }

    // Everything else opens a response window.
    const cfgText = {
      foreign_aid: `${actor.name} attempts Foreign Aid (+2)`,
      tax: `${actor.name} claims Duke — Tax (+3)`,
      assassinate: `${actor.name} claims Assassin — Assassinate on ${target && target.name}`,
      steal: `${actor.name} claims Captain — Steal from ${target && target.name}`,
      exchange: `${actor.name} claims ${this.actionCharacter('exchange')} — Exchange`,
      interrogate: `${actor.name} claims Inquisitor — Interrogate ${target && target.name}`,
    }[action];
    this.pushLog(cfgText);

    if (cfg.challengeable) this.openChallengeWindow();
    else this.openBlockWindow(); // foreign_aid
  }

  // ---- response windows ---------------------------------------------------

  openChallengeWindow() {
    this.phase = 'response';
    this.pending.window = 'challenge';
    this.pending.passed = [];
    const responders = this.responders();
    if (responders.length === 0) this.afterChallenge();
  }

  openBlockWindow() {
    const p = this.pending;
    this.phase = 'response';
    p.window = 'block';
    p.passed = [];
    if (this.blockers().length === 0) this.resolveEffect();
  }

  openBlockChallengeWindow() {
    this.phase = 'response';
    this.pending.window = 'block_challenge';
    this.pending.passed = [];
    const responders = this.responders();
    if (responders.length === 0) this.blockSucceeds();
  }

  // Who may respond in the current window.
  responders() {
    const p = this.pending;
    if (p.window === 'challenge')
      return this.alivePlayers().filter(x => x.id !== p.actorId);
    if (p.window === 'block')
      return this.blockers();
    if (p.window === 'block_challenge')
      return this.alivePlayers().filter(x => x.id !== p.blockerId);
    return [];
  }

  blockers() {
    const p = this.pending;
    const cfg = ACTIONS[p.action];
    if (!cfg.blockable) return [];
    if (p.action === 'foreign_aid')
      return this.alivePlayers().filter(x => x.id !== p.actorId);
    const t = this.get(p.targetId);
    return t && t.influence.length > 0 ? [t] : [];
  }

  respond(pid, type, character) {
    if (this.phase !== 'response') throw new Error('No response expected now');
    const p = this.pending;
    const eligible = this.responders().some(x => x.id === pid);
    if (!eligible) throw new Error("You can't respond to this");

    if (type === 'pass') return this.pass(pid);
    if (type === 'challenge') return this.doChallenge(pid);
    if (type === 'block') return this.doBlock(pid, character);
    throw new Error('Bad response');
  }

  pass(pid) {
    const p = this.pending;
    if (!p.passed.includes(pid)) p.passed.push(pid);
    const remaining = this.responders().filter(r => !p.passed.includes(r.id));
    if (remaining.length > 0) return; // still waiting on others

    if (p.window === 'challenge') return this.afterChallenge();
    if (p.window === 'block') return this.resolveEffect();
    if (p.window === 'block_challenge') return this.blockSucceeds();
  }

  doChallenge(challengerId) {
    const p = this.pending;
    const challenger = this.get(challengerId);

    if (p.window === 'challenge') {
      const actor = this.get(p.actorId);
      if (this.hasCard(actor, p.character)) {
        // Bluff called wrongly — challenger loses influence, actor redraws.
        this.pushLog(`${challenger.name} challenged... ${actor.name} really had ${p.character}! ${challenger.name} loses influence`);
        this.swapCard(actor, p.character);
        return this.loseInfluence(challenger.id, () => this.afterChallenge());
      }
      // Bluff caught — actor loses influence, action fails.
      this.pushLog(`${challenger.name} challenged ${actor.name}'s ${p.character} — and was right! Action fails`);
      return this.loseInfluence(actor.id, () => this.endTurn());
    }

    if (p.window === 'block_challenge') {
      const blocker = this.get(p.blockerId);
      if (this.hasCard(blocker, p.blockCharacter)) {
        this.pushLog(`${challenger.name} challenged the block... ${blocker.name} had ${p.blockCharacter}! ${challenger.name} loses influence`);
        this.swapCard(blocker, p.blockCharacter);
        return this.loseInfluence(challenger.id, () => this.blockSucceeds());
      }
      this.pushLog(`${challenger.name} challenged the block — ${blocker.name} was bluffing! Block fails`);
      return this.loseInfluence(blocker.id, () => this.resolveEffect());
    }
  }

  doBlock(blockerId, character) {
    const p = this.pending;
    const cfg = ACTIONS[p.action];
    if (!cfg.blockable) throw new Error("This action can't be blocked");
    if (!this.blockCharsFor(p.action).includes(character))
      throw new Error(`${character} can't block that`);
    const blocker = this.get(blockerId);
    p.blockerId = blockerId;
    p.blockCharacter = character;
    this.pushLog(`${blocker.name} claims ${character} to block`);
    this.openBlockChallengeWindow();
  }

  // Called after the initial challenge window clears (nobody challenged, or a
  // wrong challenge was punished): move to block window or resolve.
  afterChallenge() {
    const cfg = ACTIONS[this.pending.action];
    if (cfg.blockable) return this.openBlockWindow();
    return this.resolveEffect();
  }

  blockSucceeds() {
    this.pushLog(`The action was blocked.`);
    this.pending = null;
    this.endTurn();
  }

  // Apply the action's real effect (it survived all challenges/blocks).
  resolveEffect() {
    const p = this.pending;
    const actor = this.get(p.actorId);
    const target = p.targetId ? this.get(p.targetId) : null;

    switch (p.action) {
      case 'foreign_aid':
        actor.coins += 2;
        this.pushLog(`${actor.name} took Foreign Aid (+2)`);
        break;
      case 'tax':
        actor.coins += 3;
        this.pushLog(`${actor.name} collected Tax (+3)`);
        break;
      case 'steal': {
        const amt = Math.min(2, target.coins);
        target.coins -= amt; actor.coins += amt;
        this.pushLog(`${actor.name} stole ${amt} from ${target.name}`);
        break;
      }
      case 'assassinate':
        this.pushLog(`${actor.name} assassinates ${target.name}`);
        this.pending = null;
        return this.loseInfluence(target.id, () => this.endTurn());
      case 'exchange':
        return this.startExchange(actor);
      case 'interrogate':
        return this.startInterrogate(actor, target);
    }
    this.pending = null;
    this.endTurn();
  }

  // ---- exchange (Ambassador) ---------------------------------------------

  startExchange(actor) {
    const n = this.options.inquisitor ? 1 : 2; // Inquisitor draws 1, Ambassador draws 2
    const drawn = [];
    for (let i = 0; i < n; i++) { const c = this.deck.pop(); if (c) drawn.push(c); }
    this.exchangeState = {
      playerId: actor.id,
      cards: [...actor.influence, ...drawn],
      keep: actor.influence.length,
    };
    this.phase = 'exchange';
    this.pushLog(`${actor.name} is exchanging cards`);
  }

  exchangeSelect(pid, indices) {
    if (this.phase !== 'exchange') throw new Error('No exchange in progress');
    const ex = this.exchangeState;
    if (ex.playerId !== pid) throw new Error('Not your exchange');
    if (!Array.isArray(indices) || indices.length !== ex.keep)
      throw new Error(`Pick exactly ${ex.keep} card(s) to keep`);
    const uniq = [...new Set(indices)];
    if (uniq.length !== indices.length) throw new Error('Duplicate selection');

    const actor = this.get(pid);
    const kept = [], returned = [];
    ex.cards.forEach((c, i) => (indices.includes(i) ? kept : returned).push(c));
    actor.influence = kept;
    this.deck.push(...returned);
    shuffle(this.deck);

    this.exchangeState = null;
    this.pending = null;
    this.pushLog(`${actor.name} finished exchanging`);
    this.endTurn();
  }

  // ---- interrogate (Inquisitor) ------------------------------------------

  startInterrogate(inquisitor, target) {
    this.pending = null;
    this.interrogateState = {
      inquisitorId: inquisitor.id, targetId: target.id,
      stage: 'show', shownIndex: null, shownCard: null,
    };
    this.phase = 'interrogate';
    // With a single card, there's nothing to choose — it's shown automatically.
    if (target.influence.length === 1) {
      this.interrogateState.shownIndex = 0;
      this.interrogateState.shownCard = target.influence[0];
      this.interrogateState.stage = 'decide';
    }
  }

  interrogateShow(pid, index) {
    if (this.phase !== 'interrogate') throw new Error('No interrogation in progress');
    const it = this.interrogateState;
    if (it.stage !== 'show' || it.targetId !== pid) throw new Error('Not yours to reveal');
    const target = this.get(pid);
    if (index < 0 || index >= target.influence.length) throw new Error('Bad card');
    it.shownIndex = index;
    it.shownCard = target.influence[index];
    it.stage = 'decide';
  }

  interrogateDecide(pid, forceSwap) {
    if (this.phase !== 'interrogate') throw new Error('No interrogation in progress');
    const it = this.interrogateState;
    if (it.stage !== 'decide' || it.inquisitorId !== pid) throw new Error('Not your decision');
    const target = this.get(it.targetId);
    const inquisitor = this.get(it.inquisitorId);
    if (forceSwap) {
      const [card] = target.influence.splice(it.shownIndex, 1);
      this.deck.push(card);
      shuffle(this.deck);
      const drawn = this.deck.pop();
      if (drawn) target.influence.push(drawn);
      this.pushLog(`${inquisitor.name} forced ${target.name} to swap the revealed card`);
    } else {
      this.pushLog(`${inquisitor.name} let ${target.name} keep the card`);
    }
    this.interrogateState = null;
    this.endTurn();
  }

  // ---- losing influence ---------------------------------------------------

  loseInfluence(pid, next) {
    const player = this.get(pid);
    if (!player || player.influence.length === 0) return next && next();

    if (player.influence.length === 1) {
      const [card] = player.influence.splice(0, 1);
      player.revealed.push(card);
      this.pushLog(`${player.name} loses their ${card}`);
      this.checkElimination(player);
      return next && next();
    }
    // Two influence: let the player choose which to reveal.
    this.phase = 'lose_influence';
    this.loseState = { playerId: pid, next: next || (() => {}) };
  }

  loseCard(pid, index) {
    if (this.phase !== 'lose_influence') throw new Error('Nothing to reveal');
    if (!this.loseState || this.loseState.playerId !== pid)
      throw new Error("It's not your card to lose");
    const player = this.get(pid);
    if (index < 0 || index >= player.influence.length) throw new Error('Bad card');
    const [card] = player.influence.splice(index, 1);
    player.revealed.push(card);
    this.pushLog(`${player.name} reveals and loses their ${card}`);
    this.checkElimination(player);
    const next = this.loseState.next;
    this.loseState = null;
    next();
  }

  checkElimination(player) {
    if (player.influence.length === 0)
      this.pushLog(`💀 ${player.name} is out of the game`);
  }

  // ---- card helpers -------------------------------------------------------

  hasCard(player, character) { return player.influence.includes(character); }

  swapCard(player, character) {
    const i = player.influence.indexOf(character);
    if (i === -1) return;
    player.influence.splice(i, 1);
    this.deck.push(character);
    shuffle(this.deck);
    const drawn = this.deck.pop();
    if (drawn) player.influence.push(drawn);
  }

  // ---- turn flow ----------------------------------------------------------

  endTurn() {
    this.pending = null;
    this.loseState = null;
    this.interrogateState = null;
    const alive = this.alivePlayers();
    if (alive.length <= 1) {
      this.phase = 'game_over';
      this.winner = alive[0] || null;
      if (this.winner) this.pushLog(`🏆 ${this.winner.name} wins the game!`);
      return;
    }
    // Advance to the next living player.
    do {
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
    } while (this.current().influence.length === 0);
    this.phase = 'action';
    this.pushLog(`It's ${this.current().name}'s turn`);
  }

  // ---- decision timer -----------------------------------------------------

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
  }

  // (Re)start the countdown for whatever the game is currently waiting on.
  // Idempotent: safe to call after every state change.
  armTimer() {
    this.clearTimer();
    if (!this.options.timer) return;
    const timed = ['action', 'response', 'lose_influence', 'exchange', 'interrogate'];
    if (!timed.includes(this.phase)) return;
    const ms = (this.options.turnSeconds || 30) * 1000;
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.resolveTimeout(); } catch (e) { /* keep the game alive */ }
      if (this.onChange) this.onChange();
    }, ms);
  }

  // Apply a safe default move when a player runs out of time.
  resolveTimeout() {
    switch (this.phase) {
      case 'action': {
        const cur = this.current();
        if (cur.coins >= 10) {
          const targets = this.alivePlayers().filter(p => p.id !== cur.id);
          const t = targets[Math.floor(Math.random() * targets.length)];
          this.pushLog(`⏱ ${cur.name} ran out of time — auto Coup`);
          this.doAction(cur.id, 'coup', t.id);
        } else {
          this.pushLog(`⏱ ${cur.name} ran out of time — auto Income`);
          this.doAction(cur.id, 'income');
        }
        break;
      }
      case 'response': {
        const window = this.pending.window;
        const pend = this.responders().filter(r => !this.pending.passed.includes(r.id));
        this.pushLog(`⏱ Time's up — remaining players pass`);
        for (const r of pend) {
          if (this.phase !== 'response' || this.pending.window !== window) break;
          this.pass(r.id);
        }
        break;
      }
      case 'lose_influence': {
        const pid = this.loseState.playerId;
        const player = this.get(pid);
        this.pushLog(`⏱ ${player.name} ran out of time — a card is revealed`);
        this.loseCard(pid, Math.floor(Math.random() * player.influence.length));
        break;
      }
      case 'exchange': {
        const pid = this.exchangeState.playerId;
        const keep = Array.from({ length: this.exchangeState.keep }, (_, i) => i);
        this.pushLog(`⏱ ${this.get(pid).name} ran out of time — keeps current cards`);
        this.exchangeSelect(pid, keep);
        break;
      }
      case 'interrogate': {
        const it = this.interrogateState;
        if (it.stage === 'show') {
          const t = this.get(it.targetId);
          this.interrogateShow(it.targetId, Math.floor(Math.random() * t.influence.length));
        } else {
          this.interrogateDecide(it.inquisitorId, false);
        }
        break;
      }
    }
  }

  pushLog(msg) {
    this.log.push(msg);
    if (this.log.length > 60) this.log.shift();
  }

  // ---- what a specific player is allowed to see ---------------------------

  stateFor(pid) {
    const me = this.get(pid);
    const p = this.pending;
    return {
      code: this.code,
      phase: this.phase,
      you: pid,
      isHost: this.isHost(pid),
      options: { inquisitor: this.options.inquisitor, timer: this.options.timer, turnSeconds: this.options.turnSeconds },
      timer: this.deadline ? { msLeft: Math.max(0, this.deadline - Date.now()), total: (this.options.turnSeconds || 30) * 1000 } : null,
      currentPlayerId: this.phase === 'action' && this.current() ? this.current().id : null,
      winner: this.winner ? { id: this.winner.id, name: this.winner.name } : null,
      log: this.log.slice(-14),
      deckCount: this.deck.length,
      players: this.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        coins: pl.coins,
        connected: pl.connected,
        kicked: !!pl.kicked,
        influenceCount: pl.influence.length,
        revealed: pl.revealed,
        alive: pl.influence.length > 0,
        isCurrent: this.phase === 'action' && this.current() && this.current().id === pl.id,
        // Only you can see your own hidden cards.
        cards: pl.id === pid ? pl.influence : null,
      })),
      pending: p ? {
        action: p.action,
        actorId: p.actorId,
        targetId: p.targetId,
        window: p.window,
        character: p.character,
        blockerId: p.blockerId,
        blockCharacter: p.blockCharacter,
        // Who we're still waiting on to respond.
        waitingOn: this.phase === 'response'
          ? this.responders().filter(r => !p.passed.includes(r.id)).map(r => r.id)
          : [],
      } : null,
      lose: this.loseState ? { playerId: this.loseState.playerId } : null,
      interrogate: this.interrogateState ? {
        inquisitorId: this.interrogateState.inquisitorId,
        targetId: this.interrogateState.targetId,
        stage: this.interrogateState.stage,
        // The revealed card is private to the Inquisitor.
        shownCard: (pid === this.interrogateState.inquisitorId && this.interrogateState.stage === 'decide')
          ? this.interrogateState.shownCard : null,
      } : null,
      exchange: this.exchangeState && this.exchangeState.playerId === pid
        ? { cards: this.exchangeState.cards, keep: this.exchangeState.keep }
        : (this.exchangeState ? { playerId: this.exchangeState.playerId } : null),
    };
  }
}

module.exports = { CoupGame, ACTIONS, CHARACTERS };
