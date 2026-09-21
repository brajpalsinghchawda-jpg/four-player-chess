const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const Rules = require("./public/rules.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

/* ---------- Rooms ---------- */
// rooms: code -> { state, turnIndex, seats: { red, blue, yellow, green }, last, emptySince }
// seats[color] holds the socket id of the player sitting there, or null.
const rooms = new Map();

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O or 1/I
  let code;
  do {
    code = Array.from({ length: 6 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function newRoom() {
  return {
    state: Rules.newState(),
    turnIndex: 0,
    seats: { red: null, blue: null, yellow: null, green: null },
    last: "",
    emptySince: null,
  };
}

const allSeated = (room) => Rules.TURN_ORDER.every((c) => room.seats[c]);

function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit("room", {
    code,
    state: room.state,
    turnIndex: room.turnIndex,
    seats: Object.fromEntries(Rules.TURN_ORDER.map((c) => [c, Boolean(room.seats[c])])),
    last: room.last,
  });
}

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
      if (myColor && room.seats[myColor] === socket.id) room.seats[myColor] = null;
      if (Rules.TURN_ORDER.every((c) => !room.seats[c])) room.emptySince = Date.now();
      socket.leave(roomCode);
      broadcast(roomCode);
    }
    roomCode = null;
    myColor = null;
  }

  function sit(code, preferredColor) {
    const room = rooms.get(code);
    if (!room) {
      socket.emit("problem", "Room not found. Check the code and try again.");
      return;
    }
    leave();

    // Take the seat you had before if it is free, otherwise the first free seat
    let color = null;
    if (Rules.TURN_ORDER.includes(preferredColor) && !room.seats[preferredColor]) {
      color = preferredColor;
    } else {
      color = Rules.TURN_ORDER.find((c) => !room.seats[c]) || null;
    }
    if (color) room.seats[color] = socket.id;
    room.emptySince = null;

    roomCode = code;
    myColor = color;
    socket.join(code);
    socket.emit("joined", { code, color });
    broadcast(code);
  }

  socket.on("createRoom", () => {
    const code = makeCode();
    rooms.set(code, newRoom());
    sit(code, null);
  });

  socket.on("joinRoom", (data) => {
    const code = String((data && data.code) || "").trim().toUpperCase();
    sit(code, data && data.color);
  });

  socket.on("move", (data) => {
    const room = roomCode && rooms.get(roomCode);
    if (!room || !myColor || !data || !data.from || !data.to) return;

    // The server checks everything. Never trust the browser.
    if (!allSeated(room)) return;
    if (Rules.TURN_ORDER[room.turnIndex] !== myColor) return;

    const { from, to } = data;
    const coords = [from.r, from.c, to.r, to.c];
    if (!coords.every((n) => Number.isInteger(n) && n >= 0 && n < Rules.SIZE)) return;

    const piece = room.state[from.r][from.c];
    if (!piece || piece.color !== myColor) return;

    const legal = Rules.legalMoves(room.state, from.r, from.c);
    if (!legal.some(([r, c]) => r === to.r && c === to.c)) return;

    const captured = room.state[to.r][to.c];
    room.state[to.r][to.c] = piece;
    room.state[from.r][from.c] = null;
    room.turnIndex = (room.turnIndex + 1) % Rules.TURN_ORDER.length;
    room.last =
      `${piece.color} ${piece.type}: ${Rules.squareName(from.r, from.c)} to ${Rules.squareName(to.r, to.c)}` +
      (captured ? ` (captured ${captured.color} ${captured.type})` : "");

    broadcast(roomCode);
  });

  socket.on("disconnect", leave);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`4-player chess is running: http://localhost:${PORT}`);
});
