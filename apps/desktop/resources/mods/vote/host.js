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
    proposal: null,
    votes: {},
    yes: 0,
    no: 0,
    lines: ["Waiting to start."],
    names: {},
    kinds: {},
    seatIds: [],
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

function seatLabel(state, seatId) {
  const name = state.names[seatId];
  if (name && name !== seatId) return `${name} (${seatId})`;
  return String(seatId);
}

function firstAgentId(state) {
  const ids = state.seatIds || [];
  for (let i = 0; i < ids.length; i++) {
    if (state.kinds[ids[i]] === "agent") return ids[i];
  }
  return null;
}

function pushLine(state, line) {
  state.lines = state.lines.concat([line]).slice(-24);
}

function snapshotSeats(state, seats) {
  const names = {};
  const kinds = {};
  const seatIds = [];
  for (let i = 0; i < seats.length; i++) {
    const seat = seats[i];
    seatIds.push(seat.id);
    names[seat.id] = seat.name || seat.id;
    kinds[seat.id] = seat.kind || "human";
  }
  state.names = names;
  state.kinds = kinds;
  state.seatIds = seatIds;
}

function startGame(state, ctx) {
  if (state.started) return state;
  const seats = ctx.seats || [];
  if (seats.length < 2) return state;
  const next = clone(state);
  snapshotSeats(next, seats);
  next.started = true;
  next.phase = "propose";
  next.proposal = null;
  next.votes = {};
  next.yes = 0;
  next.no = 0;
  next.lines = ["Propose a motion."];
  return next;
}

function countVotes(votes) {
  let yes = 0;
  let no = 0;
  const keys = Object.keys(votes);
  for (let i = 0; i < keys.length; i++) {
    if (votes[keys[i]] === "yes") yes += 1;
    else if (votes[keys[i]] === "no") no += 1;
  }
  return { yes, no };
}

function allVoted(state) {
  const ids = state.seatIds || [];
  for (let i = 0; i < ids.length; i++) {
    if (!state.votes[ids[i]]) return false;
  }
  return ids.length > 0;
}

function reduce(state, intent, ctx) {
  const name = intent && intent.name;
  if (name === "mod.start") return startGame(state, ctx);
  if (!state || !state.started) return state;
  const actor = intent.seatId;
  const payload = payloadOf(intent);
  if (name === "propose") return onPropose(state, actor, payload);
  if (name === "vote") return onVote(state, actor, payload);
  if (name === "next") return onNext(state, actor);
  return state;
}

function knownSeat(state, seatId) {
  return (state.seatIds || []).indexOf(seatId) !== -1;
}

function onPropose(state, actor, payload) {
  if (state.phase !== "propose" || !knownSeat(state, actor)) return state;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return state;
  const next = clone(state);
  next.proposal = text;
  next.votes = {};
  next.yes = 0;
  next.no = 0;
  next.phase = "vote";
  pushLine(next, `${seatLabel(next, actor)} proposed: ${text}`);
  return next;
}

function onVote(state, actor, payload) {
  if (state.phase !== "vote" || !knownSeat(state, actor)) return state;
  if (state.votes[actor]) return state;
  const choice = payload.choice;
  if (choice !== "yes" && choice !== "no") return state;
  const next = clone(state);
  next.votes[actor] = choice;
  if (!allVoted(next)) return next;
  const tallies = countVotes(next.votes);
  next.yes = tallies.yes;
  next.no = tallies.no;
  next.phase = "result";
  const passed = next.yes > next.no;
  const result = passed ? "passed" : next.yes === next.no ? "tied" : "failed";
  pushLine(next, `Result: ${result}. Yes ${next.yes} / No ${next.no}.`);
  return next;
}

function onNext(state, _actor) {
  if (state.phase !== "result") return state;
  const next = clone(state);
  next.phase = "propose";
  next.proposal = null;
  next.votes = {};
  next.yes = 0;
  next.no = 0;
  pushLine(next, "New round. Propose a motion.");
  return next;
}

function viewOf(title, phase, lines, badges) {
  const view = { title, phase, lines: lines.slice() };
  if (badges && badges.length) view.badges = badges;
  return view;
}

function publicLines(state) {
  return (state.lines || []).slice();
}

function getPublicView(state) {
  const badges = [{ label: state.phase, tone: "info" }];
  if (state.phase === "result") {
    badges.push({
      label: state.yes > state.no ? "passed" : "not passed",
      tone: "ok",
    });
  }
  return viewOf("投票", state.phase, publicLines(state), badges);
}

function getSeatView(state, seatId) {
  const publicView = getPublicView(state);
  const lines = publicView.lines.slice();
  const badges = (publicView.badges || []).slice();
  badges.unshift({ label: "voter", tone: "role" });
  if (state.phase === "vote") {
    if (state.votes[seatId]) {
      lines.push("You have voted.");
      badges.push({ label: "voted", tone: "ok" });
    } else {
      lines.push("You have not voted yet.");
      badges.push({ label: "pending", tone: "wait" });
    }
  }
  return viewOf("投票", state.phase, lines, badges);
}

function actionSchema(properties, required, hint) {
  const params = { type: "object", properties };
  if (required && required.length) params.required = required;
  const action = { params };
  if (hint) action.hint = hint;
  return action;
}

function getActions(state, seatId) {
  if (!state.started || !knownSeat(state, seatId)) return {};
  if (state.phase === "propose") {
    return {
      propose: actionSchema(
        { text: { type: "string" } },
        ["text"],
        "Propose a motion",
      ),
    };
  }
  if (state.phase === "vote" && !state.votes[seatId]) {
    return {
      vote: actionSchema(
        { choice: { type: "string", enum: ["yes", "no"] } },
        ["choice"],
        "Cast your vote",
      ),
    };
  }
  if (state.phase === "result") {
    return {
      next: actionSchema({}, [], "Start a new proposal"),
    };
  }
  return {};
}

function getPrompt(state, seatId) {
  if (!state.started) return "Wait for the host to start.";
  if (state.phase === "propose") return "Propose a short motion.";
  if (state.phase === "vote") {
    if (state.votes[seatId]) return "Wait for the remaining votes.";
    return `Vote yes or no on: ${state.proposal || "the motion"}`;
  }
  if (state.phase === "result") {
    return `The motion ${state.yes > state.no ? "passed" : "did not pass"}. You may start the next round.`;
  }
  return "Wait.";
}

function shouldPromptAgent(state, seatId) {
  if (!state || !state.started || !knownSeat(state, seatId)) return false;
  if (state.phase === "vote") {
    return !state.votes[seatId] && state.kinds[seatId] === "agent";
  }
  if (state.phase === "propose" || state.phase === "result") {
    return seatId === firstAgentId(state);
  }
  return false;
}
