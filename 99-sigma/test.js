// Test : lance le serveur, joue des parties complètes avec des joueurs simulés
const assert = require('assert');
const { server, applyCard } = require('./server');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const VAL = { A: 1, J: 11, Q: 12, K: 13 };

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  return { ok: r.ok, ...j };
}

// Ouvre le flux d'un joueur et garde le dernier état reçu
function listen(code, token) {
  const ctl = new AbortController();
  const p = { state: null, waiters: [], close: () => ctl.abort() };
  fetch(`${BASE}/api/events?code=${code}&token=${token}`, { signal: ctl.signal }).then(async (res) => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            p.state = JSON.parse(line.slice(6));
            p.waiters.splice(0).forEach((w) => w());
          }
        }
      }
    } catch {}
  });
  return p;
}
const tick = () => new Promise((r) => setTimeout(r, 15));
async function settle(players, pred) {
  for (let i = 0; i < 400; i++) {
    if (players.every((p) => p.state) && pred()) return;
    await tick();
  }
  throw new Error('Timeout en attendant un état');
}

async function game(nPlayers, round) {
  const names = ['Léa', 'Tom', 'Inès', 'Max', 'Zoé', 'Sam', 'Noé'].slice(0, nPlayers);
  const c = await post('/api/create', { name: names[0] });
  const code = c.code;
  const seats = [{ name: names[0], token: c.token }];
  for (const n of names.slice(1)) {
    const j = await post('/api/join', { code, name: n });
    assert(j.ok, j.error);
    seats.push({ name: n, token: j.token });
  }

  const ps = seats.map((s) => Object.assign(listen(code, s.token), s));
  await settle(ps, () => ps.every((p) => p.state.players.length === nPlayers));
  // Pseudo d'un joueur connecté refusé
  await settle(ps, () => ps[0].state.players.every((x) => x.connected));
  const dup = await post('/api/join', { code, name: names[0].toUpperCase() });
  assert(!dup.ok && /pseudo/.test(dup.error));

  let games = 0;
  let maxTurns = 0;
  for (let g = 0; g < 5; g++) {
    const st = await post('/api/action', { code, token: ps[g % nPlayers].token, type: 'start' });
    assert(st.ok, st.error);
    await settle(ps, () => ps.every((p) => p.state.phase === 'playing' && p.state.gameNo === g + 1));

    // Chacun ne voit que sa main, 4 cartes
    for (const p of ps) {
      assert.strictEqual(p.state.me.hand.length, 4);
      assert(!JSON.stringify(p.state.players).includes('"hand"'));
    }
    assert.strictEqual(ps[0].state.deckCount, 52 - 4 * nPlayers);

    let turns = 0;
    let sawEmptyDeck = false;
    while (true) {
      const s0 = ps[0].state;
      if (s0.phase !== 'playing') break;
      const cur = ps.find((p) => p.state.me.id === s0.turn);
      const other = ps.find((p) => p !== cur);
      const st = cur.state;
      assert(st.total >= 0 && st.total <= 98, 'total hors limites ' + st.total);

      // Coup hors tour refusé
      if (turns % 7 === 0 && other.state.me.hand.length) {
        const bad = await post('/api/action', { code, token: other.token, type: 'play', card: other.state.me.hand[0].id });
        assert(!bad.ok && /tour/.test(bad.error));
      }
      // Roi sans valeur valable refusé
      const king = st.me.hand.find((x) => x.r === 'K');
      if (king && turns % 3 === 0) {
        const bad = await post('/api/action', { code, token: cur.token, type: 'play', card: king.id, kingValue: 99 });
        assert(!bad.ok && /98/.test(bad.error));
      }

      // Stratégie : une carte qui ne fait pas perdre, sinon la première
      const safe = st.me.hand.filter((x) => applyCard(st.total, x, 40) < 99);
      const card = (safe.length ? safe : st.me.hand)[Math.floor(Math.random() * (safe.length || st.me.hand.length))];
      const kv = card.r === 'K' ? 1 + Math.floor(Math.random() * 98) : undefined;
      const expected = applyCard(st.total, card, kv);
      const before = { total: st.total, hand: st.me.hand.length, deck: st.deckCount, dir: st.direction };
      const gn = st.gameNo;
      const logLen = JSON.stringify(st.log);
      const r = await post('/api/action', { code, token: cur.token, type: 'play', card: card.id, kingValue: kv });
      assert(r.ok, r.error);
      await settle(ps, () => ps.every((p) => JSON.stringify(p.state.log) !== logLen));
      const after = cur.state;
      turns++;

      if (expected >= 99) {
        assert.strictEqual(after.phase, 'over');
        assert.strictEqual(after.loser, cur.state.me.id);
        assert.strictEqual(after.endReason, 'limit');
        break;
      }
      assert.strictEqual(after.total, expected, 'total attendu');
      if (card.r === 'Q') assert.strictEqual(after.direction, -before.dir);
      if (before.deck > 0) {
        assert.strictEqual(after.me.hand.length, before.hand, 'repioche');
        assert.strictEqual(after.deckCount, before.deck - 1);
      } else {
        sawEmptyDeck = true;
        assert.strictEqual(after.me.hand.length, before.hand - 1);
      }
      if (after.phase === 'over') {
        assert.strictEqual(after.endReason, 'lastCard');
        const loser = ps.find((p) => p.state.me.id === after.loser);
        assert(loser.state.me.hand.length > 0, 'le perdant garde une carte');
        assert.strictEqual(ps.filter((p) => p.state.me.hand.length > 0).length, 1);
        break;
      }
      // Le joueur suivant a encore des cartes
      const nxt = ps.find((p) => p.state.me.id === after.turn);
      assert(nxt.state.me.hand.length > 0, 'le tour va à un joueur sans carte');
      assert(turns < 500);
    }
    maxTurns = Math.max(maxTurns, turns);
    games++;
    const s = ps[0].state;
    const loser = ps.find((p) => p.state.me.id === s.loser);

    // Bus pour le perdant, sauf une partie sur deux
    if (g % 2 === 0) {
      const notLoser = ps.find((p) => p !== loser);
      const bad = await post('/api/action', { code, token: notLoser.token, type: 'bus' });
      assert(!bad.ok);
      assert((await post('/api/action', { code, token: loser.token, type: 'bus' })).ok);
      await settle(ps, () => ps.every((p) => p.state.phase === 'bus'));
      let guesses = 0;
      while (!loser.state.bus.done) {
        const b = loser.state.bus;
        const v = VAL[b.current.r] || Number(b.current.r);
        const guess = v === 7 ? 'egal' : v < 7 ? 'plus' : 'moins';
        const flips = b.flips;
        const streak = b.streak;
        const r = await post('/api/action', { code, token: loser.token, type: 'guess', guess });
        assert(r.ok, r.error);
        await settle(ps, () => ps.every((p) => p.state.bus.flips === flips + 1));
        const nb = loser.state.bus;
        const a = VAL[nb.last.prev.r] || Number(nb.last.prev.r);
        const z = VAL[nb.last.next.r] || Number(nb.last.next.r);
        const actual = z > a ? 'plus' : z < a ? 'moins' : 'egal';
        assert.strictEqual(nb.last.ok, actual === guess);
        assert.strictEqual(nb.streak, nb.last.ok ? streak + 1 : 0);
        assert.strictEqual(nb.last.next.id, nb.current.id, 'on repart de la dernière carte');
        guesses++;
        assert(guesses < 3000);
      }
      assert.strictEqual(loser.state.bus.streak, 7);
      console.log(`  partie ${g + 1} : ${turns} coups, ${loser.name} perd (${s.endReason}), bus en ${guesses} cartes`);
    } else {
      console.log(`  partie ${g + 1} : ${turns} coups, ${loser.name} perd (${s.endReason}), bus passé`);
    }
  }
  // Un joueur déconnecté récupère sa place avec son pseudo
  ps[nPlayers - 1].close();
  await settle([ps[0]], () => !ps[0].state.players.find((x) => x.name === ps[nPlayers - 1].name).connected);
  const back = await post('/api/join', { code, name: ps[nPlayers - 1].name });
  assert(back.ok, back.error);
  const again = listen(code, back.token);
  await settle([again], () => again.state.me.id === ps[0].state.players.find((x) => x.name === ps[nPlayers - 1].name).id);
  assert.strictEqual(again.state.players.length, nPlayers);
  again.close();
  // Un joueur quitte la table, les autres continuent
  assert((await post('/api/action', { code, token: back.token, type: 'leave' })).ok);
  await settle([ps[0]], () => ps[0].state.players.length === nPlayers - 1);
  ps.forEach((p) => p.close());
  return games;
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  let total = 0;
  try {
    for (const n of [2, 3, 4, 6]) {
      console.log(`Table à ${n} joueurs`);
      total += await game(n);
    }
    console.log(`\nOK : ${total} parties jouées sans erreur.`);
  } catch (e) {
    console.error('ÉCHEC :', e);
    process.exitCode = 1;
  }
  server.closeAllConnections();
  server.close();
  process.exit();
})();
