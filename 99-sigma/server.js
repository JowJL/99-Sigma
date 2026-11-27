// 99 sigma — serveur de jeu sans dépendance (Node 18+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 12;
const HAND_SIZE = 4;
const BUS_GOAL = 7;
const LIMIT = 99;

const rooms = new Map();

// ---------- Cartes ----------
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_ORDER = Object.fromEntries(RANKS.map((r, i) => [r, i + 1])); // A=1 … K=13
const RANK_NAMES = { A: 'As', J: 'Valet', Q: 'Dame', K: 'Roi' };

function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s, id: r + s });
  return shuffle(d);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cardName(c) {
  return RANK_NAMES[c.r] || c.r;
}
// Total obtenu en posant cette carte (kingValue requis pour le Roi)
function applyCard(total, card, kingValue) {
  switch (card.r) {
    case 'J': return Math.max(0, total - 10);
    case 'Q': return total;
    case 'K': return kingValue;
    default: return total + RANK_ORDER[card.r];
  }
}

// ---------- Utilitaires ----------
function code() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(c));
  return c;
}
function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}
function log(room, text) {
  room.log.push({ t: Date.now(), text });
  if (room.log.length > 30) room.log.shift();
}
function seated(room) {
  return room.players.filter((p) => p.seated);
}
function player(room, token) {
  return room.players.find((p) => p.token === token);
}

// ---------- Partie de 99 ----------
function startGame(room) {
  const ps = seated(room);
  room.deck = newDeck();
  room.discard = [];
  room.total = 0;
  room.direction = 1;
  room.loser = null;
  room.endReason = null;
  room.bus = null;
  room.lastPlay = null;
  for (const p of room.players) p.hand = [];
  for (let i = 0; i < HAND_SIZE; i++) for (const p of ps) p.hand.push(room.deck.pop());
  // Le perdant de la partie précédente commence, sinon un joueur au hasard
  let starter = ps.find((p) => p.id === room.lastLoserId);
  if (!starter) starter = ps[crypto.randomInt(ps.length)];
  room.turn = starter.id;
  room.phase = 'playing';
  room.gameNo++;
  log(room, `Nouvelle partie. ${starter.name} commence.`);
}

function nextTurn(room) {
  const ps = seated(room);
  const idx = ps.findIndex((p) => p.id === room.turn);
  for (let step = 1; step <= ps.length; step++) {
    const p = ps[(((idx + step * room.direction) % ps.length) + ps.length) % ps.length];
    if (p.hand.length > 0) return p.id;
  }
  return room.turn;
}

function endGame(room, loser, reason) {
  room.phase = 'over';
  room.loser = loser.id;
  room.lastLoserId = loser.id;
  room.endReason = reason;
  loser.losses = (loser.losses || 0) + 1;
  log(room, `${loser.name} a perdu la partie.`);
}

function playCard(room, p, cardId, kingValue) {
  if (room.phase !== 'playing') throw new Error("Aucune partie n'est en cours.");
  if (room.turn !== p.id) throw new Error("Ce n'est pas ton tour.");
  const i = p.hand.findIndex((c) => c.id === cardId);
  if (i < 0) throw new Error("Tu n'as pas cette carte.");
  const card = p.hand[i];
  if (card.r === 'K') {
    kingValue = Number(kingValue);
    if (!Number.isInteger(kingValue) || kingValue < 1 || kingValue > LIMIT - 1)
      throw new Error('Choisis une valeur entre 1 et 98 pour le Roi.');
  }
  const before = room.total;
  const after = applyCard(before, card, kingValue);
  p.hand.splice(i, 1);
  room.discard.push(card);
  room.total = after;
  room.lastPlay = { by: p.id, card, before, after, kingValue: card.r === 'K' ? kingValue : null };

  let txt = `${p.name} pose ${cardName(card)}`;
  if (card.r === 'K') txt += ` et annonce ${kingValue}`;
  else if (card.r === 'Q') txt += ', le sens change';
  log(room, `${txt}. Total : ${after}.`);
  if (card.r === 'Q') room.direction *= -1;

  if (after >= LIMIT) return endGame(room, p, 'limit');

  if (room.deck.length > 0) p.hand.push(room.deck.pop());

  // Pioche vide : le dernier joueur à garder une carte perd
  const withCards = seated(room).filter((x) => x.hand.length > 0);
  if (withCards.length === 1 && room.deck.length === 0) return endGame(room, withCards[0], 'lastCard');
  if (withCards.length === 0) return endGame(room, p, 'lastCard');

  room.turn = nextTurn(room);
}

// ---------- Bus ----------
function busDraw(bus) {
  if (bus.deck.length === 0) {
    bus.deck = shuffle(bus.used);
    bus.used = [];
    bus.reshuffles++;
  }
  return bus.deck.pop();
}
function startBus(room, p) {
  if (room.phase !== 'over' || room.loser !== p.id) throw new Error('Seul le perdant peut lancer le bus.');
  const deck = newDeck();
  const bus = { playerId: p.id, deck, used: [], streak: 0, errors: 0, flips: 0, reshuffles: 0, last: null, done: false };
  bus.current = busDraw(bus);
  room.bus = bus;
  room.phase = 'bus';
  log(room, `${p.name} monte dans le bus.`);
}
function busGuess(room, p, guess) {
  const bus = room.bus;
  if (room.phase !== 'bus' || !bus || bus.done) throw new Error("Aucun bus n'est en cours.");
  if (bus.playerId !== p.id) throw new Error("Ce n'est pas toi qui fais le bus.");
  if (!['plus', 'moins', 'egal'].includes(guess)) throw new Error('Réponse invalide.');
  const prev = bus.current;
  const next = busDraw(bus);
  bus.used.push(prev);
  const a = RANK_ORDER[prev.r];
  const b = RANK_ORDER[next.r];
  const actual = b > a ? 'plus' : b < a ? 'moins' : 'egal';
  const ok = actual === guess;
  bus.flips++;
  bus.current = next;
  if (ok) bus.streak++;
  else {
    bus.streak = 0;
    bus.errors++;
  }
  bus.last = { prev, next, guess, ok };
  if (bus.streak >= BUS_GOAL) {
    bus.done = true;
    log(room, `${p.name} sort du bus après ${bus.flips} cartes et ${bus.errors} erreur${bus.errors > 1 ? 's' : ''}.`);
  }
}
function leaveBus(room, p) {
  if (room.phase !== 'bus') return;
  const bus = room.bus;
  if (!bus.done && bus.playerId !== p.id) throw new Error('Seul le joueur du bus peut abandonner.');
  if (!bus.done) log(room, `${p.name} descend du bus.`);
  room.phase = 'over';
}

// ---------- Vue envoyée à chaque joueur ----------
function view(room, me) {
  const ps = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    seated: p.seated,
    connected: p.streams.size > 0,
    cards: p.hand ? p.hand.length : 0,
    losses: p.losses || 0,
    host: p.id === room.hostId,
  }));
  let bus = null;
  if (room.bus) {
    const b = room.bus;
    bus = { playerId: b.playerId, current: b.current, streak: b.streak, errors: b.errors, flips: b.flips, last: b.last, done: b.done, goal: BUS_GOAL };
  }
  return {
    code: room.code,
    phase: room.phase,
    me: me ? { id: me.id, name: me.name, seated: me.seated, hand: me.hand || [] } : null,
    players: ps,
    hostId: room.hostId,
    total: room.total,
    direction: room.direction,
    turn: room.turn,
    deckCount: room.deck ? room.deck.length : 0,
    lastPlay: room.lastPlay,
    loser: room.loser,
    endReason: room.endReason,
    bus,
    log: room.log.slice(-12),
    gameNo: room.gameNo,
    limits: { max: MAX_PLAYERS, hand: HAND_SIZE, limit: LIMIT },
  };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const p of room.players) {
    if (p.streams.size === 0) continue;
    const data = `data: ${JSON.stringify(view(room, p))}\n\n`;
    for (const res of p.streams) res.write(data);
  }
}

// ---------- Actions ----------
function createRoom(name) {
  const room = {
    code: code(),
    players: [],
    hostId: null,
    phase: 'lobby',
    total: 0,
    direction: 1,
    turn: null,
    deck: [],
    discard: [],
    log: [],
    gameNo: 0,
    touched: Date.now(),
  };
  rooms.set(room.code, room);
  const p = addPlayer(room, name);
  room.hostId = p.id;
  log(room, `${p.name} a ouvert la table.`);
  return { room, p };
}
function addPlayer(room, name) {
  name = cleanName(name);
  if (!name) throw new Error('Choisis un pseudo.');
  const same = room.players.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (same) {
    // Un joueur déconnecté récupère sa place (et ses cartes) avec son pseudo
    if (same.streams.size === 0 && room.players.length > 0 && room.hostId) {
      same.token = crypto.randomBytes(16).toString('hex');
      same.reclaimed = true;
      return same;
    }
    throw new Error('Ce pseudo est déjà pris à cette table.');
  }
  const canSit = seated(room).length < MAX_PLAYERS;
  const p = {
    id: crypto.randomUUID().slice(0, 8),
    token: crypto.randomBytes(16).toString('hex'),
    name,
    // On rejoint une partie en cours comme spectateur, on joue à la suivante
    seated: canSit,
    waiting: canSit && (room.phase === 'playing' || room.phase === 'bus'),
    hand: [],
    losses: 0,
    streams: new Set(),
  };
  room.players.push(p);
  return p;
}

function handleAction(room, p, body) {
  switch (body.type) {
    case 'start': {
      if (room.phase === 'playing') throw new Error('Une partie est déjà en cours.');
      if (room.phase === 'bus' && !room.bus.done && room.bus.playerId !== p.id)
        throw new Error('Attendez la fin du bus.');
      for (const x of room.players) x.waiting = false;
      if (seated(room).length < 2) throw new Error('Il faut au moins 2 joueurs.');
      if (!p.seated) throw new Error('Les spectateurs ne peuvent pas lancer la partie.');
      return startGame(room);
    }
    case 'play':
      if (p.waiting) throw new Error('Tu joueras à la prochaine partie.');
      return playCard(room, p, body.card, body.kingValue);
    case 'bus':
      return startBus(room, p);
    case 'guess':
      return busGuess(room, p, body.guess);
    case 'leaveBus':
      return leaveBus(room, p);
    case 'abort': {
      if (room.phase !== 'playing') throw new Error("Aucune partie n'est en cours.");
      room.phase = 'lobby';
      for (const x of room.players) x.hand = [];
      log(room, `${p.name} a arrêté la partie.`);
      return;
    }
    case 'leave': {
      if (room.phase === 'playing' && p.hand.length > 0) {
        // Ses cartes repartent sous la pioche, la partie continue
        room.deck.unshift(...shuffle(p.hand));
        p.hand = [];
        if (room.turn === p.id) room.turn = nextTurn(room);
      }
      room.players = room.players.filter((x) => x !== p);
      for (const s of p.streams) s.end();
      log(room, `${p.name} a quitté la table.`);
      if (room.hostId === p.id && room.players.length) room.hostId = room.players[0].id;
      if (room.phase === 'bus' && room.bus && room.bus.playerId === p.id) room.phase = 'over';
      if (room.phase === 'playing') {
        const left = seated(room).filter((x) => x.hand.length > 0);
        if (seated(room).length < 2) {
          room.phase = 'lobby';
          log(room, 'Pas assez de joueurs, retour à la salle d’attente.');
        } else if (left.length === 1 && room.deck.length === 0) endGame(room, left[0], 'lastCard');
      }
      // Une place se libère pour un spectateur
      const s = room.players.find((x) => !x.seated);
      if (s && seated(room).length < MAX_PLAYERS) {
        s.seated = true;
        s.waiting = room.phase === 'playing' || room.phase === 'bus';
      }
      if (room.players.length === 0) rooms.delete(room.code);
      return;
    }
    default:
      throw new Error('Action inconnue.');
  }
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        reject(new Error('Requête invalide.'));
      }
    });
    req.on('error', reject);
  });
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const INDEX = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const b = await readBody(req);
      const { room, p } = createRoom(b.name);
      return json(res, 200, { code: room.code, token: p.token });
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || '').toUpperCase().trim());
      if (!room) return json(res, 404, { error: "Cette table n'existe pas ou plus. Vérifie le code." });
      const p = addPlayer(room, b.name);
      if (p.reclaimed) {
        p.reclaimed = false;
        log(room, `${p.name} revient à la table.`);
      } else log(room, p.seated ? `${p.name} rejoint la table.` : `${p.name} regarde la partie (table pleine).`);
      broadcast(room);
      return json(res, 200, { code: room.code, token: p.token });
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || '').toUpperCase());
      if (!room) return json(res, 404, { error: "Cette table n'existe plus." });
      const p = player(room, b.token);
      if (!p) return json(res, 403, { error: "Tu n'es pas assis à cette table." });
      handleAction(room, p, b);
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
      const p = room && player(room, url.searchParams.get('token'));
      if (!p) return json(res, 404, { error: 'gone' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      p.streams.add(res);
      broadcast(room);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        p.streams.delete(res);
        if (rooms.has(room.code)) broadcast(room);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    json(res, 404, { error: 'Introuvable.' });
  } catch (e) {
    json(res, 400, { error: e.message || 'Erreur.' });
  }
});

// Ménage : une table sans activité depuis 3 heures est supprimée
setInterval(() => {
  const now = Date.now();
  for (const [c, r] of rooms) {
    const online = r.players.some((p) => p.streams.size > 0);
    if (!online && now - r.touched > 3 * 3600 * 1000) rooms.delete(c);
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`99 sigma en ligne sur http://localhost:${PORT}`));
}
module.exports = { server, rooms, applyCard };
