const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const Rules = require("./public/rules.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const COLORS = Rules.TURN_ORDER;
const CLOCK_MINUTES = [0, 1, 3, 5, 10]; // 0 means no timer
const CLOCK_BONUS = [0, 2, 5, 10];      // seconds added after each move

/* ---------- Rooms ---------- */
// rooms: code -> room
// room.seats[color]  = socket id of the player sitting there, or null
// room.names[color]  = that player's display name
// room.started       = true once all four seats were filled; after that the game never waits for anyone
// room.clock         = { base, bonus } in milliseconds, or null for "no timer"
// room.times[color]  = time left (ms) as of the last update
// room.tickingSince  = timestamp when the current player's clock started running, or null
const rooms = new Map();

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O or 1/I
  let code;
  do {
    code = Array.from({ length: 6 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms.has(code));
  return code;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function newRoom(minutes, bonusSeconds) {
  const room = {
    seats: { red: null, blue: null, yellow: null, green: null },
    names: { red: null, blue: null, yellow: null, green: null },
    emptySince: null,
    clock: minutes > 0 ? { base: minutes * 60 * 1000, bonus: bonusSeconds * 1000 } : null,
  };
  resetGame(room);
  return room;
}

// Puts the board, clocks and turn back to the start (used for new rooms and rematches)
function resetGame(room) {
  room.state = Rules.newState();
  room.turnIndex = 0;
  room.last = "";
  room.over = false;
  room.winner = null;
  room.eliminated = { red: false, blue: false, yellow: false, green: false };
  const base = room.clock ? room.clock.base : 0;
  room.times = { red: base, blue: base, yellow: base, green: base };
  room.tickingSince = null;
  room.started = COLORS.every((c) => room.seats[c]);
  syncTicking(room);
}

const displayName = (room, color) => room.names[color] || capitalize(color);

/* ---------- Clocks ---------- */
// Charges the time since the last update to the player whose turn it is
function settle(room) {
  if (room.tickingSince === null) return;
  const now = Date.now();
  room.times[COLORS[room.turnIndex]] -= now - room.tickingSince;
  room.tickingSince = now;
}

// Starts or stops the clock depending on the state of the game.
// Once the game has started, the clock keeps running even if a player disconnects.
function syncTicking(room) {
  const shouldTick = Boolean(room.clock) && !room.over && room.started;
  if (shouldTick && room.tickingSince === null) room.tickingSince = Date.now();
  if (!shouldTick && room.tickingSince !== null) {
    settle(room);
    room.tickingSince = null;
  }
}

function advanceTurn(room) {
  do {
    room.turnIndex = (room.turnIndex + 1) % COLORS.length;
  } while (room.eliminated[COLORS[room.turnIndex]]);
}

// Takes a player out of the game. Their pieces stay on the board as dead pieces.
// keepLast = add the message after the last move instead of replacing it.
function eliminate(room, color, reason, keepLast) {
  room.eliminated[color] = true;
  Rules.markDead(room.state, color);
  const message = `${displayName(room, color)} ${reason}`;
  room.last = keepLast && room.last ? `${room.last} — ${message}` : message;

  const alive = COLORS.filter((c) => !room.eliminated[c]);
  if (alive.length <= 1) {
    room.over = true;
    room.winner = alive[0] || null;
  } else if (COLORS[room.turnIndex] === color) {
    advanceTurn(room);
  }
  syncTicking(room);
}

// Checks the player whose turn it is. No legal move and in check = checkmate;
// no legal move and not in check = stalemate. Either way that player is out,
// and we keep going in case the next player is stuck too.
function resolveTurn(room) {
  while (!room.over) {
    const color = COLORS[room.turnIndex];
    if (Rules.hasAnyLegalMove(room.state, color)) return;
    const mated = Rules.isInCheck(room.state, color);
    eliminate(room, color, mated ? "was checkmated" : "is stalemated", true);
  }
}

// Returns true if the current player just ran out of time
function checkTimeout(room) {
  if (room.tickingSince === null) return false;
  settle(room);
  const color = COLORS[room.turnIndex];
  if (room.times[color] > 0) return false;
  room.times[color] = 0;
  eliminate(room, color, "ran out of time");
  resolveTurn(room);
  return true;
}

/* ---------- Sending state to players ---------- */
// Names come from players, so clean them: no HTML characters, max 16 letters
function cleanName(raw, color) {
  const name = String(raw || "").replace(/[<>&"'`]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return name || capitalize(color);
}

function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  settle(room);
  io.to(code).emit("room", {
    code,
    state: room.state,
    turnIndex: room.turnIndex,
    seats: Object.fromEntries(COLORS.map((c) => [c, room.seats[c] ? room.names[c] : null])),
    names: Object.fromEntries(COLORS.map((c) => [c, displayName(room, c)])),
    eliminated: room.eliminated,
    started: room.started,
    over: room.over,
    winner: room.winner,
    clock: room.clock,
    times: Object.fromEntries(COLORS.map((c) => [c, Math.max(0, Math.round(room.times[c]))])),
    ticking: room.tickingSince !== null,
    last: room.last,
  });
}

// Every quarter of a second, check whether anyone's time has run out
setInterval(() => {
  for (const [code, room] of rooms) {
    if (checkTimeout(room)) broadcast(code);
  }
}, 250);

// Delete rooms that have been empty for 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > 15 * 60 * 1000) rooms.delete(code);
  }
}, 60 * 1000);

/* ---------- Connections ---------- */
io.on("connection", (socket) => {
  let roomCode = null;
  let myColor = null;

  function leave() {
    const room = roomCode && rooms.get(roomCode);
    if (room) {
      if (myColor && room.seats[myColor] === socket.id) {
        room.seats[myColor] = null;
        if (!room.started) room.names[myColor] = null; // during a game, keep the name
      }
      if (COLORS.every((c) => !room.seats[c])) room.emptySince = Date.now();
      socket.leave(roomCode);
      broadcast(roomCode);
    }
    roomCode = null;
    myColor = null;
  }

  function sit(code, preferredColor, name) {
    const room = rooms.get(code);
    if (!room) {
      socket.emit("problem", "Room not found. Check the code and try again.");
      return;
    }
    leave();

    // Take the seat you had before if it is free, otherwise the first free seat
    let color = null;
    if (COLORS.includes(preferredColor) && !room.seats[preferredColor]) {
      color = preferredColor;
    } else {
      color = COLORS.find((c) => !room.seats[c] && !room.eliminated[c]) || null;
    }
    if (color) {
      room.seats[color] = socket.id;
      room.names[color] = cleanName(name, color);
    }
    room.emptySince = null;
    // The game starts the first time all four seats are filled
    if (!room.started && COLORS.every((c) => room.seats[c])) room.started = true;
    syncTicking(room);

    roomCode = code;
    myColor = color;
    socket.join(code);
    socket.emit("joined", { code, color });
    broadcast(code);
  }

  socket.on("createRoom", (data) => {
    data = data || {};
    const minutes = CLOCK_MINUTES.includes(Number(data.minutes)) ? Number(data.minutes) : 5;
    const bonus = CLOCK_BONUS.includes(Number(data.bonus)) ? Number(data.bonus) : 0;
    const code = makeCode();
    rooms.set(code, newRoom(minutes, bonus));
    sit(code, null, data.name);
  });

  socket.on("joinRoom", (data) => {
    const code = String((data && data.code) || "").trim().toUpperCase();
    sit(code, data && data.color, data && data.name);
  });

  socket.on("move", (data) => {
    const room = roomCode && rooms.get(roomCode);
    if (!room || !myColor || !data || !data.from || !data.to) return;

    // The server checks everything. Never trust the browser.
    if (room.over || !room.started) return;
    if (checkTimeout(room)) {          // someone ran out of time just before this move
      broadcast(roomCode);
      return;
    }
    if (COLORS[room.turnIndex] !== myColor) return;

    const { from, to } = data;
    const coords = [from.r, from.c, to.r, to.c];
    if (!coords.every((n) => Number.isInteger(n) && n >= 0 && n < Rules.SIZE)) return;

    const piece = room.state[from.r][from.c];
    if (!piece || piece.color !== myColor) return;

    const legal = Rules.legalMoves(room.state, from.r, from.c);
    if (!legal.some(([r, c]) => r === to.r && c === to.c)) return;

    const movedType = piece.type;
    const result = Rules.applyMove(room.state, from, to);   // also handles castling and promotion
    if (room.clock) room.times[myColor] += room.clock.bonus; // bonus seconds for moving
    advanceTurn(room);
    room.last =
      `${displayName(room, myColor)} (${myColor} ${movedType}): ` +
      `${Rules.squareName(from.r, from.c)} to ${Rules.squareName(to.r, to.c)}` +
      (result.castled ? " (castled)" : "") +
      (result.promoted ? " (promoted to queen)" : "") +
      (result.captured ? ` (captured ${result.captured.color} ${result.captured.type})` : "");
    resolveTurn(room);                 // is the next player checkmated or stalemated?

    broadcast(roomCode);
  });

  socket.on("resign", () => {
    const room = roomCode && rooms.get(roomCode);
    if (!room || !myColor || room.over || room.eliminated[myColor]) return;
    if (checkTimeout(room)) { broadcast(roomCode); return; } // someone else's clock ran out first
    eliminate(room, myColor, "resigned");
    resolveTurn(room); // resigning can also leave the current player stuck
    broadcast(roomCode);
  });

  // Anyone sitting at the table can start a new game once this one is over
  socket.on("rematch", () => {
    const room = roomCode && rooms.get(roomCode);
    if (!room || !myColor || !room.over) return;
    resetGame(room);
    broadcast(roomCode);
  });

  socket.on("disconnect", leave);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`4-player chess is running: http://localhost:${PORT}`);
});

if (process.env.CHESS_TEST) module.exports = { rooms }; // lets the automatic tests look inside
