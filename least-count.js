/* Least Count game module. Shared lobby, Firebase room, voice and chat stay in index.html. */
let activeGameType = "modduSet";
let lcHand = [];
let lcSelectedIds = new Set();
let lcBotBusy = false;
let lcBotTurnKey = "";
let lcActionBusy = Object.create(null);
let lcSettings = { cardsPerHand: 5, scoreLimit: 200, badShowCost: 40, matchDrop: false };

function lcRoomSettings(lobby) {
  const s = (lobby && lobby.settings) || {};
  return {
    cardsPerHand: Number(s.cardsPerHand) === 7 ? 7 : 5,
    scoreLimit: [100, 150, 200, 250, 300].includes(Number(s.scoreLimit)) ? Number(s.scoreLimit) : 200,
    badShowCost: [20, 40, 60, 80].includes(Number(s.badShowCost)) ? Number(s.badShowCost) : 40,
    matchDrop: s.matchDrop === true
  };
}
function lcPoints(card) {
  if (!card || card.rank === "JOKER" || card.joker) return 0;
  if (card.rank === "A") return 1;
  if (card.rank === "J") return 11;
  if (card.rank === "Q") return 12;
  if (card.rank === "K") return 13;
  return Math.max(2, Math.min(10, Number(card.rank) || 0));
}
function lcTotal(hand) {
  return (Array.isArray(hand) ? hand : []).reduce((sum, card) => sum + lcPoints(card), 0);
}
function lcShuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
function lcBuildDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const cards = [];
  for (let pack = 0; pack < 2; pack++) {
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({ id: "lc-" + pack + "-" + rank + "-" + suit + "-" + Math.random().toString(36).slice(2, 9), rank, suit, joker: false });
      }
    }
    cards.push({ id: "lc-joker-" + pack + "-a-" + Math.random().toString(36).slice(2, 8), rank: "JOKER", suit: "★", joker: true });
    cards.push({ id: "lc-joker-" + pack + "-b-" + Math.random().toString(36).slice(2, 8), rank: "JOKER", suit: "★", joker: true });
  }
  return lcShuffle(cards);
}
function lcCardFace(card) {
  if (!card) return "";
  const red = card.suit === "♥" || card.suit === "♦";
  const rank = card.joker ? "★" : card.rank;
  const suit = card.joker ? "★" : card.suit;
  return '<span class="lc-card-corner">' + escapeLobbyText(rank) + '<small>' + escapeLobbyText(suit) + '</small></span><span class="lc-card-center">' + escapeLobbyText(suit) + '</span><span class="lc-card-value">' + lcPoints(card) + '</span>';
}
function lcCardMarkup(card, selected, clickable, extraClass) {
  const red = card && (card.suit === "♥" || card.suit === "♦");
  const cls = "lc-card" + (red ? " red" : "") + (selected ? " selected" : "") + (extraClass ? " " + extraClass : "");
  const action = clickable ? ' onclick="lcToggleCard(\'' + String(card.id).replace(/[^a-zA-Z0-9_-]/g, "") + '\')" role="button" tabindex="0"' : "";
  return '<button type="button" class="' + cls + '"' + action + ' aria-label="' + escapeLobbyText(card.rank + " " + card.suit + ", " + lcPoints(card) + " points") + '">' + lcCardFace(card) + '</button>';
}
function lcSetNotice(text) {
  const el = document.getElementById("lcMessage");
  if (el) el.textContent = text || "";
}
async function updateLeastCountSetting(key, value) {
  if (!isRoomHost || !roomRef || activeGameType !== "leastCount") return;
  const allowed = {
    cardsPerHand: [5, 7],
    scoreLimit: [100, 150, 200, 250, 300],
    badShowCost: [20, 40, 60, 80]
  };
  if (key === "matchDrop") value = value === true || value === "true";
  else {
    value = Number(value);
    if (!allowed[key] || !allowed[key].includes(value)) return;
  }
  try {
    await roomRef.child("lobby/settings/" + key).set(value);
    setLobbyNotice("Least Count settings updated.");
  } catch (e) {
    setLobbyNotice("Could not update Least Count settings: " + e.message);
  }
}
async function startLeastCountRoom() {
  if (!isRoomHost || !roomRef) return;
  try {
    const snap = await roomRef.child("lobby").get();
    const lobby = snap.val() || {};
    const members = onlineMembers(lobby);
    if (members.length < 2) { setLobbyNotice("Invite at least one more player or add a bot."); return; }
    lcSettings = lcRoomSettings(lobby);
    const deck = lcBuildDeck();
    const hands = {};
    members.forEach(p => { hands[p.id] = deck.splice(0, lcSettings.cardsPerHand); });
    const first = deck.pop();
    const starter = members[0];
    const publicPlayers = members.map(p => ({
      id: p.id, name: p.name, isBot: !!p.isBot, active: true, score: 0,
      cardCount: lcSettings.cardsPerHand, status: p.isBot ? "BOT" : "READY"
    }));
    const state = {
      gameType: "leastCount", status: "playing", round: 1,
      cardsPerHand: lcSettings.cardsPerHand, scoreLimit: lcSettings.scoreLimit,
      badShowCost: lcSettings.badShowCost, matchDrop: lcSettings.matchDrop,
      turnUid: starter.id, phase: "drop", deckCount: deck.length,
      openCards: [first], players: publicPlayers, results: null,
      message: starter.name + "'s turn. Drop one card or a set of the same rank."
    };
    await roomRef.child("private").set({ deck, hands, discardPile: [] });
    await roomRef.child("public").set(state);
    await roomRef.child("lobby/status").set("started");
    enterOnlineGame(state);
  } catch (e) {
    setLobbyNotice("Could not start Least Count: " + e.message);
  }
}
function enterLeastCountGame(state) {
  if (!roomRef || !roomPlayerId) return;
  activeGameType = "leastCount";
  onlineMode = true;
  onlinePublic = state;
  lcSelectedIds = new Set();
  lcHand = [];
  document.getElementById("setup")?.classList.add("hidden");
  document.getElementById("waitingRoom")?.classList.add("hidden");
  document.getElementById("game")?.classList.remove("hidden");
  document.getElementById("leastCountView")?.classList.remove("hidden");
  document.getElementById("modduTablePanel")?.classList.add("hidden");
  document.getElementById("modduHandPanel")?.classList.add("hidden");
  document.getElementById("gameActionsPanel")?.classList.add("hidden");
  document.getElementById("voicePanel")?.classList.remove("hidden");
  const code = document.getElementById("gameRoomCode");
  if (code) { code.textContent = roomCode || "------"; code.closest(".game-room-code").style.display = roomCode ? "flex" : "none"; }
  document.getElementById("gameChat")?.classList.remove("hidden");
  document.getElementById("chatDrawer")?.classList.add("hidden");
  document.getElementById("chatToggle")?.setAttribute("aria-expanded", "false");
  chatHasOpened = false; chatUnreadCount = 0; chatIsOpen = false; updateChatUnread();

  onlinePublicRef = roomRef.child("public");
  onlineHandRef = roomRef.child("private/hands/" + roomPlayerId);
  onlineActionRef = roomRef.child("actions");
  onlineSpecialRef = null;
  if (onlinePublicListener) onlinePublicRef.off("value", onlinePublicListener);
  onlinePublicListener = snap => {
    if (!snap.exists()) return;
    onlinePublic = snap.val();
    lcRender();
    if (isRoomHost && onlinePublic.status === "playing") runLeastCountBotTurn();
  };
  onlinePublicRef.on("value", onlinePublicListener);
  if (onlineHandListener) onlineHandRef.off("value", onlineHandListener);
  onlineHandListener = snap => {
    lcHand = snap.val() || [];
    lcSelectedIds = new Set();
    lcRender();
  };
  onlineHandRef.on("value", onlineHandListener);
  if (isRoomHost) {
    if (onlineActionListener) onlineActionRef.off("child_added", onlineActionListener);
    onlineActionListener = snap => {
      if (!snap.exists()) return;
      const uid = snap.key;
      if (lcActionBusy[uid]) return;
      lcActionBusy[uid] = true;
      processLeastCountAction(uid, snap.val())
        .catch(e => console.warn("Least Count action rejected:", e))
        .finally(() => {
          onlineActionRef.child(uid).remove().catch(() => {});
          delete lcActionBusy[uid];
        });
    };
    onlineActionRef.on("child_added", onlineActionListener);
  }
  onlineChatRef = roomRef.child("chat");
  if (onlineChatListener) onlineChatRef.off("child_added", onlineChatListener);
  const chatRefForLoad = onlineChatRef;
  chatRefForLoad.limitToLast(60).once("value").then(initial => {
    if (!onlineMode || onlineChatRef !== chatRefForLoad) return;
    const oldKeys = new Set(Object.keys(initial.val() || {}));
    onlineChatListener = snap => {
      const isOld = oldKeys.has(snap.key);
      oldKeys.delete(snap.key);
      const shownLocally = locallyShownChatMessages.has(snap.key);
      locallyShownChatMessages.delete(snap.key);
      receiveGameChat(snap, !isOld && !shownLocally);
    };
    chatRefForLoad.limitToLast(60).on("child_added", onlineChatListener);
  }).catch(() => {});
  lcRender();
  if (isRoomHost) runLeastCountBotTurn();
}
function lcRender() {
  const state = onlinePublic;
  if (!state || activeGameType !== "leastCount") return;
  const ownTurn = state.turnUid === roomPlayerId && state.status === "playing";
  const phase = state.phase || "drop";
  const playersEl = document.getElementById("players");
  if (playersEl) {
    playersEl.innerHTML = (state.players || []).map(p => {
      const active = p.active !== false;
      return '<div class="player ' + (p.id === state.turnUid && state.status === "playing" ? "active" : "") + '" data-player-id="' + escapeLobbyText(p.id) + '">' +
        '<span class="profile-count">' + (p.isBot ? "🤖 BOT" : "PLAYER") + '</span><b>' + escapeLobbyText(p.name) + '</b>' +
        '<span class="profile-score">Score: ' + (Number(p.score) || 0) + '</span><span class="profile-score">' + (active ? (p.cardCount || 0) + " cards" : "ELIMINATED") + '</span></div>';
    }).join("");
  }
  const roundEl = document.getElementById("roundInfo");
  if (roundEl) roundEl.textContent = "Least Count · Round " + state.round;
  const targetEl = document.getElementById("targetScoreInfo");
  if (targetEl) targetEl.textContent = "TARGET " + state.scoreLimit;
  const turnEl = document.getElementById("turnInfo");
  if (turnEl) {
    const current = (state.players || []).find(p => p.id === state.turnUid);
    turnEl.textContent = state.status === "playing" ? (ownTurn ? "YOUR TURN · " + (phase === "drop" ? "DROP" : "PICK") : (current ? current.name + "'s turn" : "Waiting")) : state.status === "gameComplete" ? "GAME COMPLETE" : "ROUND COMPLETE";
  }
  lcSetNotice(state.message);
  const deckCount = document.getElementById("lcDeckCount");
  if (deckCount) deckCount.textContent = String(state.deckCount || 0) + " cards";
  const open = document.getElementById("lcOpenCards");
  if (open) {
    const cards = Array.isArray(state.openCards) ? state.openCards : [];
    open.innerHTML = cards.length ? cards.map(card => lcCardMarkup(card, false, ownTurn && phase === "pick", "lc-open-card")).join("") : '<span class="lc-empty-pile">No open cards</span>';
    if (ownTurn && phase === "pick") open.querySelectorAll(".lc-open-card").forEach((el, i) => {
      const card = cards[i];
      el.onclick = () => lcPickOpen(card.id);
    });
  }
  const hand = document.getElementById("lcHand");
  if (hand) {
    hand.innerHTML = lcHand.length ? lcHand.map(card => lcCardMarkup(card, lcSelectedIds.has(card.id), ownTurn && phase === "drop", "")).join("") : '<p class="lc-empty-hand">Your cards will appear here.</p>';
    hand.querySelectorAll(".lc-card[onclick]").forEach(el => {
      el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); } });
    });
  }
  const handCount = document.getElementById("lcHandCount");
  if (handCount) handCount.textContent = String(lcHand.length);
  const total = document.getElementById("lcHandTotal");
  if (total) total.textContent = lcTotal(lcHand) + " points";
  const dropBtn = document.getElementById("lcDropBtn");
  if (dropBtn) { dropBtn.classList.toggle("hidden", !ownTurn || phase !== "drop"); dropBtn.disabled = lcSelectedIds.size === 0; }
  const deckBtn = document.getElementById("lcDeckBtn");
  if (deckBtn) { deckBtn.disabled = !ownTurn || phase !== "pick" || Number(state.deckCount) <= 0; deckBtn.classList.toggle("ready", ownTurn && phase === "pick"); }
  const showBtn = document.getElementById("lcShowBtn");
  if (showBtn) { showBtn.disabled = !ownTurn || phase !== "drop"; showBtn.classList.toggle("hidden", !ownTurn || phase !== "drop"); }
  const actionHint = document.getElementById("lcActionHint");
  if (actionHint) actionHint.textContent = !ownTurn ? "Wait for your turn." : phase === "drop" ? "Select one card or a group of the same rank, then drop." : "Pick one of the cards just dropped, or draw from the deck.";
  const results = document.getElementById("lcResults");
  if (results) results.classList.toggle("hidden", state.status === "playing");
  const nextBtn = document.getElementById("lcNextRoundBtn");
  if (nextBtn) { nextBtn.classList.toggle("hidden", !isRoomHost || state.status !== "roundComplete"); nextBtn.disabled = state.status !== "roundComplete"; }
  const resultBody = document.getElementById("lcResultRows");
  if (resultBody && state.results) {
    resultBody.innerHTML = state.results.map(r => '<div class="lc-result-row"><strong>' + escapeLobbyText(r.name) + '</strong><span>' + r.total + ' hand pts</span><span>+' + r.points + ' score</span><b>' + r.score + ' total</b></div>').join("");
    const summary = document.getElementById("lcResultSummary");
    if (summary) summary.textContent = state.resultMessage || "";
  }
}
function lcToggleCard(id) {
  if (!onlinePublic || onlinePublic.turnUid !== roomPlayerId || onlinePublic.phase !== "drop") return;
  const card = lcHand.find(c => c.id === id);
  if (!card) return;
  if (lcSelectedIds.has(id)) lcSelectedIds.delete(id);
  else {
    if (lcSelectedIds.size) {
      const first = lcHand.find(c => lcSelectedIds.has(c.id));
      if (first && first.rank !== card.rank) { lcSetNotice("You can drop multiple cards only when they have the same rank."); return; }
    }
    lcSelectedIds.add(id);
  }
  lcRender();
}
async function lcSendAction(action) {
  if (!onlineMode || activeGameType !== "leastCount" || !roomRef || !roomPlayerId) return;
  if (onlinePublic?.status !== "playing" || onlinePublic.turnUid !== roomPlayerId) { lcSetNotice("Please wait for your turn."); return; }
  try {
    if (isRoomHost) await processLeastCountAction(roomPlayerId, action);
    else await onlineActionRef.child(roomPlayerId).set({ ...action, requestedAt: Date.now() });
  } catch (e) { lcSetNotice(e.message || "That move could not be completed."); }
}
async function lcDropSelected() {
  if (!lcSelectedIds.size) return;
  const ids = Array.from(lcSelectedIds);
  lcSelectedIds.clear();
  await lcSendAction({ type: "drop", cardIds: ids });
}
async function lcPickDeck() { await lcSendAction({ type: "pickDeck" }); }
async function lcPickOpen(cardId) { await lcSendAction({ type: "pickOpen", cardId }); }
async function lcCallShow() { await lcSendAction({ type: "show" }); }
async function processLeastCountAction(uid, action) {
  if (!isRoomHost || !roomRef || !action) throw new Error("Only the table host can process moves.");
  const [pubSnap, lobbySnap] = await Promise.all([roomRef.child("public").get(), roomRef.child("lobby").get()]);
  const state = pubSnap.val(), lobby = lobbySnap.val() || {};
  if (!state || state.status !== "playing" || state.gameType !== "leastCount") throw new Error("This Least Count round is not active.");
  if (state.turnUid !== uid) throw new Error("It is not this player's turn.");
  const settings = lcRoomSettings(lobby);
  const handRef = roomRef.child("private/hands/" + uid);
  const handSnap = await handRef.get();
  let hand = handSnap.val() || [];
  if (action.type === "show") {
    if (state.phase !== "drop") throw new Error("Finish your pick before calling SHOW.");
    await lcResolveShow(uid, false, state, settings);
    return;
  }
  if (action.type === "drop") {
    if (state.phase !== "drop") throw new Error("Drop your cards before picking.");
    const ids = Array.isArray(action.cardIds) ? Array.from(new Set(action.cardIds)) : [];
    if (!ids.length) throw new Error("Select at least one card.");
    const dropped = hand.filter(card => ids.includes(card.id));
    if (dropped.length !== ids.length) throw new Error("One or more selected cards are no longer in your hand.");
    if (dropped.some(card => card.rank !== dropped[0].rank)) throw new Error("You can drop only cards of the same rank together.");
    const remaining = hand.filter(card => !ids.includes(card.id));
    const previousOpen = Array.isArray(state.openCards) ? state.openCards : [];
    const previousTop = previousOpen.length ? previousOpen[previousOpen.length - 1] : null;
    const matchSkip = settings.matchDrop && previousTop && previousTop.rank === dropped[0].rank;
    const privateSnap = await roomRef.child("private").get();
    const privateData = privateSnap.val() || {};
    const oldDiscard = Array.isArray(privateData.discardPile) ? privateData.discardPile : [];
    await roomRef.child("private/discardPile").set(oldDiscard.concat(previousOpen));
    await handRef.set(remaining);
    const players = (state.players || []).map(p => p.id === uid ? { ...p, cardCount: remaining.length } : p);
    const next = { ...state, players, openCards: dropped, phase: matchSkip ? "drop" : "pick", deckCount: state.deckCount || 0,
      message: matchSkip ? (dropped[0].rank + " matched the open card. Match & Drop: pick skipped.") : "Choose one of the cards just dropped, or draw from the deck." };
    await roomRef.child("public").set(next);
    if (remaining.length === 0) { await lcResolveShow(uid, true, next, settings); return; }
    if (matchSkip) await lcAdvanceTurn(next, uid);
    return;
  }
  if (action.type === "pickDeck" || action.type === "pickOpen") {
    if (state.phase !== "pick") throw new Error("Drop your cards first.");
    let picked = null, openCards = Array.isArray(state.openCards) ? state.openCards.slice() : [];
    const privateSnap = await roomRef.child("private").get();
    const privateData = privateSnap.val() || {};
    let deck = Array.isArray(privateData.deck) ? privateData.deck.slice() : [];
    let discardPile = Array.isArray(privateData.discardPile) ? privateData.discardPile.slice() : [];
    if (action.type === "pickOpen") {
      const index = openCards.findIndex(card => card.id === action.cardId);
      if (index < 0) throw new Error("That open card is no longer available.");
      picked = openCards.splice(index, 1)[0];
    } else {
      if (!deck.length && discardPile.length) {
        deck = lcShuffle(discardPile);
        discardPile = [];
      }
      if (!deck.length) throw new Error("No cards remain to draw. Pick from the open cards.");
      picked = deck.pop();
    }
    hand.push(picked);
    await roomRef.child("private").update({ deck, discardPile });
    await handRef.set(hand);
    const players = (state.players || []).map(p => p.id === uid ? { ...p, cardCount: hand.length } : p);
    const next = { ...state, players, openCards, deckCount: deck.length };
    await lcAdvanceTurn(next, uid);
    return;
  }
  throw new Error("Unknown Least Count move.");
}
async function lcAdvanceTurn(state, currentUid) {
  const active = (state.players || []).filter(p => p.active !== false);
  if (active.length <= 1) {
    const champion = active[0] || null;
    const complete = { ...state, status: "gameComplete", championUid: champion && champion.id, phase: "results",
      message: champion ? champion.name + " wins Least Count!" : "Game complete." };
    await roomRef.child("public").set(complete);
    return;
  }
  const index = active.findIndex(p => p.id === currentUid);
  const nextPlayer = active[(index + 1 + active.length) % active.length];
  const next = { ...state, turnUid: nextPlayer.id, phase: "drop",
    message: nextPlayer.name + "'s turn. Drop one card or a set of the same rank." };
  await roomRef.child("public").set(next);
}
async function lcResolveShow(showUid, automatic, stateOverride, settingsOverride) {
  if (!isRoomHost || !roomRef) return;
  const state = stateOverride || (await roomRef.child("public").get()).val();
  if (!state || state.status !== "playing") return;
  const lobbySnap = await roomRef.child("lobby").get();
  const settings = settingsOverride || lcRoomSettings(lobbySnap.val() || {});
  const active = (state.players || []).filter(p => p.active !== false);
  const handSnaps = await Promise.all(active.map(p => roomRef.child("private/hands/" + p.id).get()));
  const totals = {};
  active.forEach((p, i) => { totals[p.id] = lcTotal(handSnaps[i].val() || []); });
  const min = Math.min(...active.map(p => totals[p.id]));
  const lowest = active.filter(p => totals[p.id] === min);
  const successful = automatic || (lowest.length === 1 && lowest[0].id === showUid);
  let lowestOther = Infinity;
  if (!successful) {
    const others = active.filter(p => p.id !== showUid);
    if (others.length) lowestOther = Math.min(...others.map(p => totals[p.id]));
  }
  const resultRows = [];
  const players = (state.players || []).map(p => {
    if (p.active === false) return p;
    let points = 0;
    if (successful) points = p.id === showUid ? 0 : totals[p.id];
    else if (p.id === showUid) points = settings.badShowCost;
    else points = totals[p.id] === lowestOther ? 0 : totals[p.id];
    const score = (Number(p.score) || 0) + points;
    const activeNow = score < settings.scoreLimit;
    resultRows.push({ uid: p.id, name: p.name, total: totals[p.id], points, score, active: activeNow });
    return { ...p, score, active: activeNow, cardCount: 0, status: activeNow ? "READY" : "ELIMINATED" };
  });
  const stillIn = players.filter(p => p.active !== false);
  const resultMessage = automatic
    ? (showUid + " dropped the last card and scored zero.")
    : successful
      ? ((players.find(p => p.id === showUid)?.name || "Player") + " had the unique lowest hand. SHOW successful!")
      : ((players.find(p => p.id === showUid)?.name || "Player") + " called a bad SHOW and received a " + settings.badShowCost + "-point penalty.");
  const next = { ...state, status: stillIn.length <= 1 ? "gameComplete" : "roundComplete", phase: "results",
    players, results: resultRows, resultMessage,
    championUid: stillIn.length === 1 ? stillIn[0].id : null,
    message: stillIn.length <= 1 ? (stillIn[0] ? stillIn[0].name + " wins the table!" : "Game complete.") : "Round complete. Review the scores." };
  await roomRef.child("public").set(next);
}
async function startLeastCountNextRound() {
  if (!isRoomHost || !roomRef || onlinePublic?.status !== "roundComplete") return;
  try {
    const pubSnap = await roomRef.child("public").get();
    const state = pubSnap.val();
    const active = (state.players || []).filter(p => p.active !== false);
    if (active.length <= 1) return;
    const lobbySnap = await roomRef.child("lobby").get();
    lcSettings = lcRoomSettings(lobbySnap.val() || {});
    const deck = lcBuildDeck(), hands = {};
    active.forEach(p => { hands[p.id] = deck.splice(0, lcSettings.cardsPerHand); });
    const first = deck.pop(), starter = active[0];
    const players = state.players.map(p => p.active === false ? p : { ...p, cardCount: lcSettings.cardsPerHand, status: p.isBot ? "BOT" : "READY" });
    const next = { ...state, status: "playing", round: (Number(state.round) || 1) + 1,
      cardsPerHand: lcSettings.cardsPerHand, scoreLimit: lcSettings.scoreLimit, badShowCost: lcSettings.badShowCost,
      matchDrop: lcSettings.matchDrop, turnUid: starter.id, phase: "drop", deckCount: deck.length,
      openCards: [first], players, results: null, resultMessage: null,
      message: "Round " + ((Number(state.round) || 1) + 1) + " started. " + starter.name + "'s turn." };
    await roomRef.child("private").set({ deck, hands, discardPile: [] });
    await roomRef.child("public").set(next);
  } catch (e) { lcSetNotice("Could not start the next round: " + e.message); }
}
async function runLeastCountBotTurn() {
  if (!isRoomHost || !onlineMode || activeGameType !== "leastCount" || lcBotBusy || !onlinePublic || onlinePublic.status !== "playing") return;
  const uid = onlinePublic.turnUid;
  const bot = (onlinePublic.players || []).find(p => p.id === uid && p.isBot && p.active !== false);
  if (!bot) return;
  const turnKey = String(onlinePublic.round) + ":" + uid + ":" + String(onlinePublic.phase);
  if (lcBotTurnKey === turnKey) return;
  lcBotTurnKey = turnKey;
  lcBotBusy = true;
  try {
    const pubSnap = await roomRef.child("public").get(), state = pubSnap.val();
    if (!state || state.status !== "playing" || state.turnUid !== uid) return;
    const handSnap = await roomRef.child("private/hands/" + uid).get(), hand = handSnap.val() || [];
    if (state.phase === "drop") {
      const handTotal = lcTotal(hand);
      const active = (state.players || []).filter(p => p.active !== false);
      const totals = {};
      for (const p of active) {
        const snap = await roomRef.child("private/hands/" + p.id).get();
        totals[p.id] = lcTotal(snap.val() || []);
      }
      const others = active.filter(p => p.id !== uid);
      if (handTotal <= 8 && others.every(p => handTotal < totals[p.id])) {
        await lcResolveShow(uid, false, state);
        return;
      }
      const groups = {};
      hand.forEach(card => { (groups[card.rank] ||= []).push(card); });
      const pairOrSet = Object.values(groups).filter(group => group.length >= 2).sort((a, b) => b.length - a.length || lcPoints(b[0]) - lcPoints(a[0]))[0];
      let dropCards;
      if (pairOrSet) dropCards = pairOrSet;
      else dropCards = [hand.slice().sort((a, b) => lcPoints(b) - lcPoints(a))[0]];
      await processLeastCountAction(uid, { type: "drop", cardIds: dropCards.map(c => c.id) });
    } else if (state.phase === "pick") {
      const latest = (await roomRef.child("public").get()).val();
      const currentHand = (await roomRef.child("private/hands/" + uid).get()).val() || [];
      const open = Array.isArray(latest.openCards) ? latest.openCards : [];
      const useful = open.slice().sort((a, b) => {
        const aPair = currentHand.some(c => c.rank === a.rank) ? 1 : 0;
        const bPair = currentHand.some(c => c.rank === b.rank) ? 1 : 0;
        return bPair - aPair || lcPoints(a) - lcPoints(b);
      })[0];
      const highest = currentHand.slice().sort((a, b) => lcPoints(b) - lcPoints(a))[0];
      if (useful && (!highest || lcPoints(useful) <= lcPoints(highest) || currentHand.some(c => c.rank === useful.rank))) {
        await processLeastCountAction(uid, { type: "pickOpen", cardId: useful.id });
      } else {
        const privateSnap = await roomRef.child("private").get();
        if ((privateSnap.val()?.deck || []).length) await processLeastCountAction(uid, { type: "pickDeck" });
        else if (useful) await processLeastCountAction(uid, { type: "pickOpen", cardId: useful.id });
      }
    }
  } catch (e) { console.warn("Least Count bot turn failed:", e); }
  finally {
    lcBotBusy = false;
    lcBotTurnKey = "";
    const latest = (await roomRef.child("public").get().catch(() => null))?.val();
    if (latest && latest.status === "playing" && (latest.turnUid !== uid || latest.phase === "pick")) runLeastCountBotTurn();
  }
}
function showLeastCountRules() {
  const modal = document.getElementById("lcRulesModal");
  if (modal) modal.classList.remove("hidden");
}
function closeLeastCountRules() {
  const modal = document.getElementById("lcRulesModal");
  if (modal) modal.classList.add("hidden");
}
function cleanupLeastCountGame() {
  lcHand = [];
  lcSelectedIds = new Set();
  lcBotBusy = false;
  lcBotTurnKey = "";
  document.getElementById("leastCountView")?.classList.add("hidden");
  document.getElementById("modduTablePanel")?.classList.remove("hidden");
  document.getElementById("modduHandPanel")?.classList.remove("hidden");
  document.getElementById("gameActionsPanel")?.classList.remove("hidden");
}
