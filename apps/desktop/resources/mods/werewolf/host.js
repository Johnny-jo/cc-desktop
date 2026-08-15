export function createGame() {
  return {
    initialState,
    reduce,
    getPublicView,
    getSeatView,
    getActions,
    getPrompt,
    shouldPromptAgent,
  };
}

function initialState() {
  return {
    started: false,
    phase: "lobby",
    winner: null,
    living: [],
    dead: [],
    lines: ["Waiting to start."],
    votes: {},
    roles: {},
    names: {},
    kinds: {},
    seerInspect: null,
    seerDone: false,
    pendingKill: null,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function payloadOf(intent) {
  return intent && intent.payload && typeof intent.payload === "object"
    ? intent.payload
    : {};
}

function seatName(state, seatId) {
  return state.names[seatId] || seatId;
}

function isLiving(state, seatId) {
  return state.living.indexOf(seatId) !== -1;
}

function roleOf(state, seatId) {
  return state.roles[seatId] || null;
}

function livingOf(state, role) {
  return state.living.filter((id) => state.roles[id] === role);
}

function pushLine(state, line) {
  state.lines = state.lines.concat([line]).slice(-24);
}

function shuffle(ids, rng) {
  const out = ids.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function hintIsJudge(seat) {
  const hint = `${seat.id} ${seat.name || ""}`;
  return /judge|法官/i.test(hint);
}

function pickJudgeId(seats) {
  for (let i = 0; i < seats.length; i++) {
    if (hintIsJudge(seats[i])) return seats[i].id;
  }
  return null;
}

function checkWin(state) {
  const wolves = livingOf(state, "wolf");
  const village = state.living.filter((id) => state.roles[id] !== "wolf");
  if (wolves.length === 0) {
    state.phase = "ended";
    state.winner = "village";
    pushLine(state, "Village wins. No wolves remain.");
    return true;
  }
  if (wolves.length >= village.length) {
    state.phase = "ended";
    state.winner = "wolves";
    pushLine(state, "Wolves win.");
    return true;
  }
  return false;
}

function killSeat(state, seatId, reason) {
  if (!seatId || !isLiving(state, seatId)) return false;
  state.living = state.living.filter((id) => id !== seatId);
  state.dead = state.dead.concat([seatId]);
  pushLine(state, `${seatName(state, seatId)} ${reason}`);
  return true;
}

function majorityTarget(votes, allowed) {
  const counts = {};
  const keys = Object.keys(votes);
  for (let i = 0; i < keys.length; i++) {
    const target = votes[keys[i]];
    if (!target || allowed.indexOf(target) === -1) continue;
    counts[target] = (counts[target] || 0) + 1;
  }
  let best = null;
  let bestN = 0;
  let tied = false;
  const targets = Object.keys(counts);
  for (let i = 0; i < targets.length; i++) {
    const id = targets[i];
    const n = counts[id];
    if (n > bestN) {
      best = id;
      bestN = n;
      tied = false;
    } else if (n === bestN) {
      tied = true;
    }
  }
  if (!best || tied) return null;
  return best;
}

function everyoneVoted(needed, votes) {
  for (let i = 0; i < needed.length; i++) {
    if (!votes[needed[i]]) return false;
  }
  return needed.length > 0;
}

function enterDayTalk(state) {
  state.phase = "day_talk";
  state.votes = {};
  state.seerDone = false;
  state.pendingKill = null;
  pushLine(state, "Day begins. Talk, then continue to the vote.");
}

function enterNightWolf(state) {
  state.phase = "night_wolf";
  state.votes = {};
  pushLine(state, "Night falls. Wolves choose a victim.");
}

function applyNightAndContinue(state) {
  const target = state.pendingKill;
  state.pendingKill = null;
  state.votes = {};
  state.phase = "resolve";
  if (target) {
    killSeat(state, target, "was killed in the night.");
  } else {
    pushLine(state, "The night passes quietly.");
  }
  if (checkWin(state)) return;
}

function startGame(state, ctx) {
  if (state.started) return state;
  const next = clone(state);
  const seats = ctx.seats || [];
  if (seats.length < 4) return state;
  const names = {};
  const kinds = {};
  const ids = [];
  for (let i = 0; i < seats.length; i++) {
    const seat = seats[i];
    ids.push(seat.id);
    names[seat.id] = seat.name || seat.id;
    kinds[seat.id] = seat.kind || "human";
  }
  const roles = {};
  const judgeId = pickJudgeId(seats);
  const pool = [];
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== judgeId) pool.push(ids[i]);
  }
  const shuffled = shuffle(pool, ctx.rng);
  const wolfCount = Math.max(1, Math.floor(shuffled.length / 3));
  if (judgeId) roles[judgeId] = "judge";
  if (shuffled.length > 0) roles[shuffled[0]] = "seer";
  for (let i = 1; i < shuffled.length; i++) {
    roles[shuffled[i]] = i <= wolfCount ? "wolf" : "villager";
  }
  next.started = true;
  next.winner = null;
  next.living = ids.slice();
  next.dead = [];
  next.roles = roles;
  next.names = names;
  next.kinds = kinds;
  next.votes = {};
  next.seerInspect = null;
  next.seerDone = false;
  next.pendingKill = null;
  next.lines = ["Roles are assigned in secret."];
  enterDayTalk(next);
  return next;
}

function reduce(state, intent, ctx) {
  const name = intent && intent.name;
  if (name === "mod.start") return startGame(state, ctx);
  if (!state || !state.started || state.phase === "ended") return state;
  const actor = intent.seatId;
  const payload = payloadOf(intent);
  if (name === "day_talk") return onDayTalk(state, actor, payload);
  if (name === "next") return onNext(state, actor);
  if (name === "day_vote") return onDayVote(state, actor, payload);
  if (name === "night_wolf") return onNightWolf(state, actor, payload);
  if (name === "night_seer") return onNightSeer(state, actor, payload);
  return state;
}

function onDayTalk(state, actor, payload) {
  if (state.phase !== "day_talk" || !isLiving(state, actor)) return state;
  const say = typeof payload.say === "string" ? payload.say.trim() : "";
  if (!say) return state;
  const next = clone(state);
  pushLine(next, `${seatName(next, actor)}: ${say}`);
  return next;
}

function onNext(state, actor) {
  if (!isLiving(state, actor)) return state;
  if (state.phase === "day_talk") {
    const next = clone(state);
    next.phase = "day_vote";
    next.votes = {};
    pushLine(next, "Voting begins.");
    return next;
  }
  if (state.phase === "resolve") {
    const next = clone(state);
    enterDayTalk(next);
    return next;
  }
  return state;
}

function onDayVote(state, actor, payload) {
  if (state.phase !== "day_vote" || !isLiving(state, actor)) return state;
  const target = typeof payload.targetSeatId === "string" ? payload.targetSeatId : "";
  if (!isLiving(state, target) || state.votes[actor]) return state;
  const next = clone(state);
  next.votes[actor] = target;
  if (!everyoneVoted(next.living, next.votes)) return next;
  const chosen = majorityTarget(next.votes, next.living);
  next.votes = {};
  if (chosen) {
    killSeat(next, chosen, "was exiled by vote.");
  } else {
    pushLine(next, "The vote is tied. Nobody is exiled.");
  }
  if (checkWin(next)) return next;
  enterNightWolf(next);
  return next;
}

function onNightWolf(state, actor, payload) {
  if (state.phase !== "night_wolf") return state;
  if (roleOf(state, actor) !== "wolf" || !isLiving(state, actor)) return state;
  const target = typeof payload.targetSeatId === "string" ? payload.targetSeatId : "";
  if (!isLiving(state, target) || state.votes[actor]) return state;
  const next = clone(state);
  next.votes[actor] = target;
  const wolves = livingOf(next, "wolf");
  if (!everyoneVoted(wolves, next.votes)) return next;
  next.pendingKill = majorityTarget(next.votes, next.living);
  next.votes = {};
  const seers = livingOf(next, "seer");
  if (seers.length === 0) {
    applyNightAndContinue(next);
    return next;
  }
  next.phase = "night_seer";
  next.seerDone = false;
  pushLine(next, "The seer may inspect someone.");
  return next;
}

function onNightSeer(state, actor, payload) {
  if (state.phase !== "night_seer") return state;
  if (roleOf(state, actor) !== "seer" || !isLiving(state, actor)) return state;
  if (state.seerDone) return state;
  const target = typeof payload.targetSeatId === "string" ? payload.targetSeatId : "";
  if (!target || !state.roles[target] || target === actor) return state;
  const next = clone(state);
  next.seerInspect = { targetSeatId: target, role: next.roles[target] };
  next.seerDone = true;
  applyNightAndContinue(next);
  return next;
}

function livingNames(state) {
  return state.living.map((id) => seatName(state, id)).join(", ") || "(none)";
}

function deadNames(state) {
  return state.dead.map((id) => seatName(state, id)).join(", ") || "(none)";
}

function viewOf(title, phase, lines, badges) {
  const view = { title, phase, lines: lines.slice() };
  if (badges && badges.length) view.badges = badges;
  return view;
}

function getPublicView(state) {
  const lines = [
    `Living: ${livingNames(state)}`,
    `Dead: ${deadNames(state)}`,
  ].concat(state.lines || []);
  if (state.winner) lines.push(`Winner: ${state.winner}`);
  const badges = [{ label: state.phase, tone: "info" }];
  if (!state.started) badges.push({ label: "waiting", tone: "wait" });
  if (state.winner) badges.push({ label: state.winner, tone: "ok" });
  return viewOf("狼人杀", state.phase, lines, badges);
}

function getSeatView(state, seatId) {
  const publicView = getPublicView(state);
  const role = roleOf(state, seatId);
  const lines = publicView.lines.slice();
  const badges = (publicView.badges || []).slice();
  if (!role) {
    lines.unshift("You have no role yet.");
    return viewOf("狼人杀", state.phase, lines, badges);
  }
  lines.unshift(`You are the ${role}.`);
  badges.unshift({ label: role, tone: "role" });
  if (!isLiving(state, seatId)) badges.push({ label: "dead", tone: "danger" });
  if (role === "wolf") {
    const fellows = Object.keys(state.roles).filter(
      (id) => state.roles[id] === "wolf" && id !== seatId,
    );
    if (fellows.length) {
      lines.push(`Fellow wolves: ${fellows.join(", ")}`);
    } else {
      lines.push("You are the only wolf.");
    }
  }
  if (role === "seer" && state.seerInspect) {
    const seen = state.seerInspect;
    lines.push(
      `Last inspect: ${seatName(state, seen.targetSeatId)} is ${seen.role}.`,
    );
  }
  return viewOf("狼人杀", state.phase, lines, badges);
}

function targetEnum(state, excludeId) {
  return state.living.filter((id) => id !== excludeId);
}

function actionSchema(properties, required, hint) {
  const params = { type: "object", properties };
  if (required && required.length) params.required = required;
  const action = { params };
  if (hint) action.hint = hint;
  return action;
}

function getActions(state, seatId) {
  if (!state.started || state.phase === "ended" || !isLiving(state, seatId)) {
    return {};
  }
  const role = roleOf(state, seatId);
  if (state.phase === "day_talk") {
    return {
      day_talk: actionSchema(
        { say: { type: "string" } },
        ["say"],
        "Say something to the table (optional)",
      ),
      next: actionSchema({}, [], "End talk and start the day vote"),
    };
  }
  if (state.phase === "day_vote" && !state.votes[seatId]) {
    const targets = targetEnum(state, null);
    return {
      day_vote: actionSchema(
        { targetSeatId: { type: "string", enum: targets } },
        ["targetSeatId"],
        "Vote to exile someone",
      ),
    };
  }
  if (
    state.phase === "night_wolf" &&
    role === "wolf" &&
    !state.votes[seatId]
  ) {
    const targets = targetEnum(state, null);
    return {
      night_wolf: actionSchema(
        { targetSeatId: { type: "string", enum: targets } },
        ["targetSeatId"],
        "Choose a victim",
      ),
    };
  }
  if (state.phase === "night_seer" && role === "seer" && !state.seerDone) {
    const targets = targetEnum(state, seatId);
    return {
      night_seer: actionSchema(
        { targetSeatId: { type: "string", enum: targets } },
        ["targetSeatId"],
        "Inspect a player",
      ),
    };
  }
  if (state.phase === "resolve") {
    return {
      next: actionSchema({}, [], "Begin the next day"),
    };
  }
  return {};
}

function getPrompt(state, seatId) {
  const role = roleOf(state, seatId) || "unknown";
  if (!state.started) return "Wait for the host to start.";
  if (state.phase === "ended") {
    return `Game over. ${state.winner || "nobody"} won.`;
  }
  if (!isLiving(state, seatId)) return "You are dead. Watch the village.";
  if (state.phase === "day_talk") {
    return `You are the ${role}. Day talk is open. You may speak, then someone continues to the vote.`;
  }
  if (state.phase === "day_vote") return "Vote for someone to exile.";
  if (state.phase === "night_wolf" && role === "wolf") {
    return "You are a wolf. Choose a living player to kill.";
  }
  if (state.phase === "night_seer" && role === "seer") {
    return "You are the seer. Inspect one player.";
  }
  if (state.phase === "resolve") return "Night is resolved. Continue to the next day.";
  return `You are the ${role}. Wait for your turn.`;
}

function shouldPromptAgent(state, seatId) {
  if (!state || !state.started || state.phase === "ended") return false;
  if (!isLiving(state, seatId)) return false;
  const role = roleOf(state, seatId);
  if (state.phase === "day_vote") return !state.votes[seatId];
  if (state.phase === "night_wolf") {
    return role === "wolf" && !state.votes[seatId];
  }
  if (state.phase === "night_seer") {
    return role === "seer" && !state.seerDone;
  }
  return false;
}
