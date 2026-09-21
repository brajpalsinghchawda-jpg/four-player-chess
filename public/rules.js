/*
  Game rules for 4-player chess.
  This one file runs in BOTH places:
    - the server (Node.js), which decides what is a legal move
    - the browser, which uses it to show the legal squares
*/
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SIZE = 14;
  const TURN_ORDER = ["red", "blue", "yellow", "green"]; // clockwise, red starts

  // Direction each color's pawns move: [row change, column change]
  const FORWARD = { green: [-1, 0], blue: [1, 0], red: [0, 1], yellow: [0, -1] };

  const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const KNIGHT_JUMPS = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];

  const BACK = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  const BACK_SWAPPED = ["R", "N", "B", "K", "Q", "B", "N", "R"];

  const isVoid = (r, c) => (r < 3 || r > 10) && (c < 3 || c > 10);
  const inBoard = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE && !isVoid(r, c);
  const squareName = (r, c) => String.fromCharCode(97 + c) + (SIZE - r); // e.g. "h2"

  function isPawnStart(color, r, c) {
    return (color === "green" && r === 12) || (color === "blue" && r === 1) ||
           (color === "red" && c === 1) || (color === "yellow" && c === 12);
  }

  // A fresh board: state[row][col] = { color, type } or null. Row 0 is the top.
  function newState() {
    const state = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    for (let i = 0; i < 8; i++) {
      const p = i + 3;
      state[13][p] = { color: "green",  type: BACK[i] };
      state[12][p] = { color: "green",  type: "P" };
      state[0][p]  = { color: "blue",   type: BACK_SWAPPED[i] };
      state[1][p]  = { color: "blue",   type: "P" };
      state[p][0]  = { color: "red",    type: BACK[i] };
      state[p][1]  = { color: "red",    type: "P" };
      state[p][13] = { color: "yellow", type: BACK_SWAPPED[i] };
      state[p][12] = { color: "yellow", type: "P" };
    }
    return state;
  }

  // Squares the piece at (r, c) can reach, ignoring whether its own king ends up in check.
  // (No castling, en passant or promotion yet.)
  function pseudoMoves(state, r, c) {
    const piece = state[r][c];
    if (!piece) return [];
    const out = [];

    // A living king can never be captured, but the pieces of an eliminated player
    // (marked dead) stay on the board and can be captured like any other piece.
    const isEnemy = (nr, nc) => {
      const t = state[nr][nc];
      return t && t.color !== piece.color && (t.type !== "K" || t.dead);
    };

    const slide = (dirs) => {
      for (const [dr, dc] of dirs) {
        let nr = r + dr, nc = c + dc;
        while (inBoard(nr, nc)) {
          if (!state[nr][nc]) {
            out.push([nr, nc]);
          } else {
            if (isEnemy(nr, nc)) out.push([nr, nc]);
            break;
          }
          nr += dr;
          nc += dc;
        }
      }
    };

    const jump = (offsets) => {
      for (const [dr, dc] of offsets) {
        const nr = r + dr, nc = c + dc;
        if (inBoard(nr, nc) && (!state[nr][nc] || isEnemy(nr, nc))) out.push([nr, nc]);
      }
    };

    switch (piece.type) {
      case "R": slide(ROOK_DIRS); break;
      case "B": slide(BISHOP_DIRS); break;
      case "Q": slide(ROOK_DIRS.concat(BISHOP_DIRS)); break;
      case "N": jump(KNIGHT_JUMPS); break;
      case "K": jump(ROOK_DIRS.concat(BISHOP_DIRS)); break;
      case "P": {
        const [fr, fc] = FORWARD[piece.color];
        const r1 = r + fr, c1 = c + fc;
        if (inBoard(r1, c1) && !state[r1][c1]) {
          out.push([r1, c1]);
          const r2 = r1 + fr, c2 = c1 + fc;
          if (isPawnStart(piece.color, r, c) && inBoard(r2, c2) && !state[r2][c2]) {
            out.push([r2, c2]);
          }
        }
        const [pr, pc] = fr !== 0 ? [0, 1] : [1, 0];
        for (const side of [1, -1]) {
          const nr = r + fr + side * pr, nc = c + fc + side * pc;
          if (inBoard(nr, nc) && isEnemy(nr, nc)) out.push([nr, nc]);
        }
        break;
      }
    }
    return out;
  }

  // When a player is eliminated, their pieces stay on the board but become dead
  function markDead(state, color) {
    for (const row of state) {
      for (const piece of row) {
        if (piece && piece.color === color) piece.dead = true;
      }
    }
  }

  /* ---------- Check and checkmate ---------- */

  // Does the piece at (pr, pc) attack the square (tr, tc)? Pawns attack diagonally forward,
  // and sliding pieces are blocked by any piece (or corner) in the way.
  function pieceAttacks(state, pr, pc, tr, tc) {
    const p = state[pr][pc];
    const dr = tr - pr, dc = tc - pc;
    if (dr === 0 && dc === 0) return false;
    switch (p.type) {
      case "N": return KNIGHT_JUMPS.some(([a, b]) => a === dr && b === dc);
      case "K": return Math.abs(dr) <= 1 && Math.abs(dc) <= 1;
      case "P": {
        const [fr, fc] = FORWARD[p.color];
        const [qr, qc] = fr !== 0 ? [0, 1] : [1, 0];
        return (dr === fr + qr && dc === fc + qc) || (dr === fr - qr && dc === fc - qc);
      }
      default: { // rook, bishop, queen
        const straight = dr === 0 || dc === 0;
        const diagonal = Math.abs(dr) === Math.abs(dc);
        if (p.type === "R" && !straight) return false;
        if (p.type === "B" && !diagonal) return false;
        if (p.type === "Q" && !straight && !diagonal) return false;
        const sr = Math.sign(dr), sc = Math.sign(dc);
        let r = pr + sr, c = pc + sc;
        while (r !== tr || c !== tc) {
          if (!inBoard(r, c) || state[r][c]) return false;
          r += sr;
          c += sc;
        }
        return true;
      }
    }
  }

  // Position of a player's living king, or null
  function findKing(state, color) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const p = state[r][c];
        if (p && p.color === color && p.type === "K" && !p.dead) return [r, c];
      }
    }
    return null;
  }

  // Is this player's king attacked by any living opponent piece?
  // (Pieces of eliminated players are dead and attack nothing.)
  function isInCheck(state, color) {
    const king = findKing(state, color);
    if (!king) return false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const p = state[r][c];
        if (p && p.color !== color && !p.dead && pieceAttacks(state, r, c, king[0], king[1])) return true;
      }
    }
    return false;
  }

  // Squares the piece at (r, c) can really move to: moves that would leave
  // your own king in check are not allowed.
  function legalMoves(state, r, c) {
    const piece = state[r][c];
    if (!piece || piece.dead) return [];
    return pseudoMoves(state, r, c).filter(([nr, nc]) => {
      const target = state[nr][nc];
      state[nr][nc] = piece;   // try the move...
      state[r][c] = null;
      const safe = !isInCheck(state, piece.color);
      state[r][c] = piece;     // ...and take it back
      state[nr][nc] = target;
      return safe;
    });
  }

  function hasAnyLegalMove(state, color) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const p = state[r][c];
        if (p && p.color === color && !p.dead && legalMoves(state, r, c).length > 0) return true;
      }
    }
    return false;
  }

  return {
    SIZE, TURN_ORDER, newState, legalMoves, pseudoMoves, isInCheck, findKing,
    hasAnyLegalMove, markDead, isVoid, inBoard, squareName,
  };
});
