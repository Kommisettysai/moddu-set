/* Least Count game module. Shared lobby, Firebase room, voice and chat stay in index.html. */
let activeGameType = "modduSet";
let lcHand = [];
let lcSelectedIds = new Set();
let lcBotBusy = false;
let lcBotTurnKey = "";
let lcBotTimer = null;
let lcActionPending = false;
let lcActionBusy = Object.create(null);
let lcToastTimer = null;
let lcLastTurnAlertKey = "";
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
function lcBuildDeck(playerCount, cardsPerHand) {
  const suits = ["♠", "♥", "♦", "♣"];
  const suitCodes = { "♠": "S", "♥": "H", "♦": "D", "♣": "C" };
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const required = Math.max(2, Number(playerCount) || 2) * (Number(cardsPerHand) === 7 ? 7 : 5) + 1;
  const packCount = required <= 54 ? 1 : 2;
  const cards = [];
  for (let pack = 0; pack < packCount; pack++) {
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({ id: "lc-" + pack + "-" + rank + "-" + suitCodes[suit] + "-" + Math.random().toString(36).slice(2, 9), rank, suit, joker: false });
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
  // Keep the full ID. Older decks include Unicode suit symbols in their IDs.
  const safeId = escapeLobbyText(String(card.id));
  const action = clickable ? (extraClass === "lc-open-card" ? ' data-lc-open-id="' + safeId + '"' : ' data-lc-card-id="' + safeId + '"') : "";
  return '<button type="button" class="' + cls + '"' + action + (clickable ? "" : " disabled") + ' aria-pressed="' + (selected ? "true" : "false") + '" aria-label="' + escapeLobbyText(card.rank + " " + card.suit + ", " + lcPoints(card) + " points") + '">' + lcCardFace(card) + '</button>';
}
function lcSetNotice(text) {
  const el = document.getElementById("lcMessage");
  if (el) el.textContent = text || "";
}

function lcShowToast(message) {
  const toast = document.getElementById("gameInfoToast");
  if (!toast) { lcSetNotice(message); return; }
  toast.textContent = message;
  toast.classList.add("show");
  if (lcToastTimer) clearTimeout(lcToastTimer);
  lcToastTimer = setTimeout(() => {
    toast.classList.remove("show");
    lcToastTimer = null;
  }, 1100);
}
function lcSelectedCards() {
  return lcHand.filter(card => lcSelectedIds.has(card.id));
}
function lcCanMatchDrop(state) {
  const selected = lcSelectedCards();
  const open = Array.isArray(state?.openCards) ? state.openCards : [];
  const top = open.length ? open[open.length - 1] : null;
  return !!(state?.matchDrop && selected.length && top &&
    selected.every(card => card.rank === selected[0].rank) &&
    selected[0].rank === top.rank);
}
function lcDeckAction() {
  if (!onlinePublic || onlinePublic.turnUid !== roomPlayerId) return;
  if (onlinePublic.phase === "pick") { lcPickDeck(); return; }
  if (onlinePublic.phase !== "drop") return;
  const selected = lcSelectedCards();
  if (!selected.length) { lcShowToast("Select a card or same-rank set first."); return; }
  if (lcCanMatchDrop(onlinePublic)) {
    lcShowToast("Matching rank! Tap the open card to use Match & Drop.");
    return;
  }
  const ids = selected.map(card => card.id);
  lcSelectedIds.clear();
  lcSendAction({ type: "dropAndPickDeck", cardIds: ids });
}
function lcMatchDropSelected() {
  if (!onlinePublic || onlinePublic.phase !== "drop" || !lcCanMatchDrop(onlinePublic) || lcActionPending) return;
  const ids = lcSelectedCards().map(card => card.id);
  if (!ids.length) return;
  lcSelectedIds.clear();
  lcShowToast("Matched! Pick skipped.");
  lcSendAction({ type: "drop", cardIds: ids });
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
    const deck = lcBuildDeck(members.length, lcSettings.cardsPerHand);
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
    lcActionPending = false;
    lcRender();
    if (isRoomHost && onlinePublic.status === "playing") scheduleLeastCountBotTurn();
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
  if (isRoomHost) scheduleLeastCountBotTurn(120);
}
function lcRender() {
  const state = onlinePublic;
  if (!state || activeGameType !== "leastCount") return;
  const ownTurn = state.turnUid === roomPlayerId && state.status === "playing";
  const phase = state.phase || "drop";
  const playersEl = document.getElementById("players");
  const playerStrip = playersEl?.closest(".player-strip");
  if (playerStrip) playerStrip.classList.add("lc-player-strip");
  if (playersEl) {
    playersEl.innerHTML = (state.players || []).map((p, index) => {
      const active = p.active !== false;
      const isCurrent = p.id === state.turnUid && state.status === "playing";
      return '<div class="player lc-player-card ' + (isCurrent ? "active turn-owner" : "") + (!active ? "eliminated-player" : "") + '" data-player-id="' + escapeLobbyText(p.id) + '">' +
        playerIdentityMarkup(p, index, "game") +
        '<span class="profile-score">Score: ' + (Number(p.score) || 0) + '</span>' +
        (active ? '' : '<span class="player-eliminated">ELIMINATED</span>') +
        '</div>';
    }).join("");
  }
  const roundEl = document.getElementById("roundInfo");
  if (roundEl) roundEl.textContent = "Least Count · Round " + state.round;
  const targetEl = document.getElementById("targetScoreInfo");
  if (targetEl) targetEl.textContent = "TARGET " + state.scoreLimit;
  const turnEl = document.getElementById("turnInfo");
  const current = (state.players || []).find(p => p.id === state.turnUid);
  const turnLabel = ownTurn ? "YOUR TURN · " + (phase === "drop" ? "DROP" : "PICK") :
    (current ? current.name + (current.isBot ? " · BOT" : "") + "'s turn" : "Waiting");
  if (turnEl) {
    turnEl.textContent = state.status === "playing" ? turnLabel : state.status === "gameComplete" ? "GAME COMPLETE" : "ROUND COMPLETE";
    turnEl.classList.toggle("own-turn", ownTurn);
    turnEl.setAttribute("aria-label", state.status === "playing" ? turnLabel : turnEl.textContent);
  }
  const turnAlertKey = state.status === "playing" ? String(state.round) + ":" + String(state.turnUid) : "";
  if (ownTurn && turnAlertKey && turnAlertKey !== lcLastTurnAlertKey) {
    try { if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(180); } catch (e) {}
    lcShowToast("Your turn · " + (phase === "drop" ? "Drop a card" : "Pick a card"));
  }
  lcLastTurnAlertKey = turnAlertKey;
  lcSetNotice(state.message);
  const deckCount = document.getElementById("lcDeckCount");
  if (deckCount) deckCount.textContent = String(state.deckCount || 0) + " cards";
  const open = document.getElementById("lcOpenCards");
  if (open) {
    const cards = Array.isArray(state.openCards) ? state.openCards : [];
    const matchReady = ownTurn && phase === "drop" && lcCanMatchDrop(state);
    open.innerHTML = cards.length ? cards.map((card, index) => {
      const isTop = index === cards.length - 1;
      const canTap = ownTurn && (phase === "pick" || (matchReady && isTop));
      return lcCardMarkup(card, false, canTap, "lc-open-card" + (phase === "drop" ? (canTap ? " match-drop-ready" : " match-drop-disabled") : ""));
    }).join("") : '<span class="lc-empty-pile">No open cards</span>';
    open.querySelectorAll("button[data-lc-open-id]").forEach(cardButton => {
      cardButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (onlinePublic?.turnUid !== roomPlayerId) return;
        if (onlinePublic?.phase === "pick") lcPickOpen(cardButton.dataset.lcOpenId);
        else if (onlinePublic?.phase === "drop") lcMatchDropSelected();
      }, { passive: false });
    });

  }
  const newDrop = document.getElementById("lcNewDrop");
  if (newDrop) {
    const cards = Array.isArray(state.newDrop) ? state.newDrop : [];
    newDrop.innerHTML = cards.length ? '<small>NEXT PLAYER CAN PICK</small>' + cards.map(card => lcCardMarkup(card, false, false, "lc-new-drop-card")).join("") : "";
    newDrop.classList.toggle("hidden", !cards.length);
  }
  const hand = document.getElementById("lcHand");
  if (hand) {
    const orderedHand = lcHand.slice().sort((a, b) => lcPoints(a) - lcPoints(b));
    hand.innerHTML = orderedHand.length ? orderedHand.map(card => lcCardMarkup(card, lcSelectedIds.has(card.id), ownTurn && phase === "drop", "")).join("") : '<p class="lc-empty-hand">Your cards will appear here.</p>';
    // Bind directly to each freshly rendered card. This avoids delegated mobile tap
    // events being lost when Firebase updates replace the hand's child elements.
    hand.querySelectorAll("button[data-lc-card-id]").forEach(cardButton => {
      cardButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        lcToggleCard(cardButton.dataset.lcCardId);
      }, { passive: false });
    });
  }
  const handCount = document.getElementById("lcHandCount");
  if (handCount) handCount.textContent = String(lcHand.length);
  const total = document.getElementById("lcHandTotal");
  if (total) total.textContent = "In hand: " + lcTotal(lcHand) + " pts";
  const deckBtn = document.getElementById("lcDeckBtn");
  if (deckBtn) {
    const deckActionReady = ownTurn && (phase === "pick" || (phase === "drop" && lcSelectedIds.size > 0 && !lcCanMatchDrop(state)));
    deckBtn.disabled = lcActionPending || !deckActionReady;
    deckBtn.classList.toggle("ready", deckActionReady);
    const deckLabel = document.getElementById("lcDeckLabel");
    if (deckLabel) deckLabel.textContent = phase === "drop" ? "DROP + DRAW" : "DRAW DECK";
  }
  const skipBtn = document.getElementById("lcSkipPickBtn");
  const canSkipPick = ownTurn && phase === "drop" && lcCanMatchDrop(state);
  if (skipBtn) {
    skipBtn.classList.toggle("hidden", !canSkipPick);
    skipBtn.disabled = lcActionPending || !canSkipPick;
  }
  const showBtn = document.getElementById("lcShowBtn");
  if (showBtn) { showBtn.disabled = lcActionPending || !ownTurn || phase !== "drop"; showBtn.classList.toggle("hidden", !ownTurn || phase !== "drop"); }
  const actionHint = document.getElementById("lcActionHint");
  if (actionHint) actionHint.textContent = !ownTurn ? ((state.players || []).find(p => p.id === state.turnUid)?.isBot ? "Bot is playing…" : "Wait for your turn.") : phase === "drop" ? (lcSelectedIds.size ? (lcCanMatchDrop(state) ? lcSelectedIds.size + " selected · same rank as the open card. You can skip the pick." : lcSelectedIds.size + " selected · tap the deck to drop and draw.") : "Select one card or a same-rank set. Lowest points appear first; highest cards are on the right.") : "Pick one card from the discard pile or draw from the deck.";
  const results = document.getElementById("lcResults");
  if (results) results.classList.toggle("hidden", state.status === "playing");
  const nextBtn = document.getElementById("lcNextRoundBtn");
  if (nextBtn) { nextBtn.classList.toggle("hidden", !isRoomHost || state.status !== "roundComplete"); nextBtn.disabled = state.status !== "roundComplete"; }
  const playAgainBtn = document.getElementById("lcPlayAgainBtn");
  if (playAgainBtn) { playAgainBtn.classList.toggle("hidden", !isRoomHost || state.status !== "gameComplete"); }
  const resultBody = document.getElementById("lcResultRows");
  if (resultBody && state.results) {
    resultBody.innerHTML = state.results.map(r => '<div class="lc-result-row"><strong>' + escapeLobbyText(r.name) + '</strong><span>' + r.total + ' hand pts</span><span>+' + r.points + ' score</span><b>' + r.score + ' total</b><small class="lc-result-cards">' + (r.cards || []).map(card => escapeLobbyText((card.rank === "JOKER" ? "★" : card.rank) + (card.joker ? "" : card.suit || ""))).join(" · ") + '</small></div>').join("");
    const summary = document.getElementById("lcResultSummary");
    if (summary) summary.textContent = state.resultMessage || "";
  }
}
function lcToggleCard(id) {
  if (lcActionPending || !onlinePublic || onlinePublic.turnUid !== roomPlayerId || onlinePublic.phase !== "drop") return;
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
  if (!onlineMode || activeGameType !== "leastCount" || !roomRef || !roomPlayerId || lcActionPending) return;
  if (onlinePublic?.status !== "playing" || onlinePublic.turnUid !== roomPlayerId) { lcSetNotice("Please wait for your turn."); return; }
  lcActionPending = true;
  lcRender();
  try {
    if (isRoomHost) await processLeastCountAction(roomPlayerId, action);
    else await onlineActionRef.child(roomPlayerId).set({ ...action, requestedAt: Date.now() });
  } catch (e) {
    lcActionPending = false;
    lcSetNotice(e.message || "That move could not be completed.");
    lcRender();
  }
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
  if (action.type === "dropAndPickDeck") {
    if (state.phase !== "drop") throw new Error("You can only drop cards during your DROP turn.");
    const ids = Array.isArray(action.cardIds) ? Array.from(new Set(action.cardIds)) : [];
    if (!ids.length) throw new Error("Select at least one card.");
    const dropped = hand.filter(card => ids.includes(card.id));
    if (dropped.length !== ids.length) throw new Error("One or more selected cards are no longer in your hand.");
    if (dropped.some(card => card.rank !== dropped[0].rank)) throw new Error("You can drop only cards of the same rank together.");
    const previousOpen = Array.isArray(state.openCards) ? state.openCards : [];
    const previousTop = previousOpen.length ? previousOpen[previousOpen.length - 1] : null;
    if (settings.matchDrop && previousTop && previousTop.rank === dropped[0].rank) {
      throw new Error("That rank matches the open card. Tap the open card to use Match & Drop.");
    }
    const remaining = hand.filter(card => !ids.includes(card.id));
    const privateSnap = await roomRef.child("private").get();
    const privateData = privateSnap.val() || {};
    let deck = Array.isArray(privateData.deck) ? privateData.deck.slice() : [];
    let discardPile = (Array.isArray(privateData.discardPile) ? privateData.discardPile : []).concat(previousOpen);
    if (!deck.length && discardPile.length) {
      deck = lcShuffle(discardPile);
      discardPile = [];
    }
    if (remaining.length && !deck.length) throw new Error("No cards remain to draw. There are no open cards to recycle.");
    const next = { ...state,
      players: (state.players || []).map(p => p.id === uid ? { ...p, cardCount: remaining.length + (remaining.length ? 1 : 0) } : p),
      openCards: dropped, newDrop: [], deckCount: deck.length,
      message: "Cards dropped. " + (remaining.length ? "Drawing from the deck." : "All cards dropped. Showing your hand.") };
    if (remaining.length) {
      const picked = deck.pop();
      await roomRef.child("private").update({ deck, discardPile });
      await handRef.set(remaining.concat(picked));
      next.players = next.players.map(p => p.id === uid ? { ...p, cardCount: remaining.length + 1 } : p);
      next.deckCount = deck.length;
      await roomRef.child("public").set(next);
      await lcAdvanceTurn(next, uid);
      return;
    }
    await roomRef.child("private").update({ deck, discardPile });
    await handRef.set([]);
    await roomRef.child("public").set(next);
    await lcResolveShow(uid, true, next, settings);
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
    await handRef.set(remaining);
    const players = (state.players || []).map(p => p.id === uid ? { ...p, cardCount: remaining.length } : p);
    const next = { ...state, players, newDrop: dropped, phase: matchSkip ? "drop" : "pick", deckCount: state.deckCount || 0,
      message: matchSkip ? (dropped[0].rank + " matched the previous open card. Match & Drop: pick skipped.") : "Pick one of the previous player's open cards, or draw from the deck." };
    if (matchSkip) {
      await roomRef.child("private/discardPile").set(oldDiscard.concat(previousOpen));
      next.openCards = dropped;
      next.newDrop = [];
    }
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
    const newDrop = Array.isArray(state.newDrop) ? state.newDrop : [];
    await roomRef.child("private").update({ deck, discardPile: discardPile.concat(openCards) });
    await handRef.set(hand);
    const players = (state.players || []).map(p => p.id === uid ? { ...p, cardCount: hand.length } : p);
    const next = { ...state, players, openCards: newDrop, newDrop: [], deckCount: deck.length };
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
    resultRows.push({ uid: p.id, name: p.name, total: totals[p.id], points, score, active: activeNow, cards: handSnaps[active.findIndex(x => x.id === p.id)].val() || [] });
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
async function restartLeastCountTable() {
  if (!isRoomHost || activeGameType !== "leastCount") return;
  await startLeastCountRoom();
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
    const deck = lcBuildDeck(active.length, lcSettings.cardsPerHand), hands = {};
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
function scheduleLeastCountBotTurn(delay = 220) {
  if (!isRoomHost || !onlineMode || activeGameType !== "leastCount") return;
  if (lcBotTimer) clearTimeout(lcBotTimer);
  lcBotTimer = setTimeout(() => {
    lcBotTimer = null;
    runLeastCountBotTurn();
  }, delay);
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
      const previousOpen = Array.isArray(state.openCards) ? state.openCards : [];
      const previousTop = previousOpen.length ? previousOpen[previousOpen.length - 1] : null;
      const matchesOpen = state.matchDrop && previousTop && previousTop.rank === dropCards[0].rank;
      await processLeastCountAction(uid, matchesOpen
        ? { type: "drop", cardIds: dropCards.map(c => c.id) }
        : { type: "dropAndPickDeck", cardIds: dropCards.map(c => c.id) });
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
  } catch (e) {
    console.warn("Least Count bot turn failed:", e);
    lcSetNotice("Bot move failed: " + (e.message || "please check the table connection."));
  }
  finally {
    lcBotBusy = false;
    lcBotTurnKey = "";
    const latest = (await roomRef.child("public").get().catch(() => null))?.val();
    if (latest && latest.status === "playing" && (latest.turnUid !== uid || latest.phase === "pick")) scheduleLeastCountBotTurn(260);
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
  document.body.classList.remove("least-count-theme");
  document.getElementById("players")?.closest(".player-strip")?.classList.remove("lc-player-strip");
  lcLastTurnAlertKey = "";
  lcHand = [];
  lcSelectedIds = new Set();
  lcBotBusy = false;
  lcBotTurnKey = "";
  if (lcBotTimer) clearTimeout(lcBotTimer);
  lcBotTimer = null;
  lcActionPending = false;
  document.getElementById("leastCountView")?.classList.add("hidden");
  document.getElementById("modduTablePanel")?.classList.remove("hidden");
  document.getElementById("modduHandPanel")?.classList.remove("hidden");
  document.getElementById("gameActionsPanel")?.classList.remove("hidden");
}
