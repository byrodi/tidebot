// @ts-check
/** Canvas view of the sea. It reads the game state and never changes it. */

/** @typedef {import('./game.js').Game} Game */
/** @typedef {import('./game.js').Direction} Direction */
/** @typedef {{ cell: number, size: number, left: number }} Layout */

// Colors of the rodi. family, the same values as css/tokens.css.
// Pink is the player's side: boat, dock and pots. Plum is the sea and its fish.
const TEXT = '#29242a';
const MUTED = '#74616c';
const SURFACE = '#ffffff';
const ACCENT = '#e47f93';
const ROSE = '#a94460';
const ROSE_STRONG = '#9a3f55';
const ROSE_SOFT = '#fcecf0';
const BLUSH = '#efccd4';
const PLUM = '#9272a8';
const PLUM_TEXT = '#715385';
const WATER_LIGHT = '#f5f1fa';
const WATER_DEEP = '#e6ddf1';
const WATER_EDGE = '#d6c8e2';
const FONT = '"Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, Arial, sans-serif';
/** Corner radius of the sea, in CSS pixels. */
const CORNER = 16;
/** Room for the axis numbers at the left and the bottom. */
const AXIS = 22;
const TAU = Math.PI * 2;

/** Rotation of a shape drawn pointing east. Screen y grows downward. */
/** @type {Readonly<Record<Direction, number>>} */
const HEADING = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 };

/**
 * @param {number} x
 * @param {number} y
 * @param {number} salt
 * @returns {number} A fixed pseudo-random number from 0 to 1 for a cell.
 */
function noise(x, y, salt) {
  const value = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * @param {number} t
 * @returns {number} Smooth step from 0 to 1.
 */
function ease(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * @param {Layout} layout
 * @param {number} x Cell x, may be a fraction.
 * @param {number} y Cell y, may be a fraction.
 * @returns {[number, number]} Canvas position of the cell centre.
 */
function centre(layout, x, y) {
  return [layout.left + (x + 0.5) * layout.cell, (layout.size - 1 - y + 0.5) * layout.cell];
}

/** Where the crabs of one pot sit on their reef, in cells from the cell centre. */
/** @type {ReadonlyArray<readonly [number, number]>} */
const CRAB_SPOTS = [
  [-0.27, -0.12],
  [0.26, 0.14],
  [-0.22, 0.22],
  [0.02, -0.3],
  [0.02, 0.3],
];

/**
 * A crab seen from above: body, two raised pincers, six legs and two eyes.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} size Half the width of the body.
 * @param {number} step From -1 to 1, moves the legs.
 */
function drawCrab(ctx, x, y, size, step) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = ROSE;
  ctx.strokeStyle = ROSE;
  ctx.lineWidth = Math.max(1, size * 0.16);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const side of [-1, 1]) {
    for (let leg = 0; leg < 3; leg += 1) {
      const y0 = (leg - 0.6) * size * 0.34;
      ctx.moveTo(side * size * 0.5, y0);
      ctx.lineTo(side * size * 1.05, y0 + size * (0.26 + 0.1 * step * (leg % 2 === 0 ? 1 : -1)));
    }
    ctx.moveTo(side * size * 0.45, -size * 0.25);
    ctx.lineTo(side * size * 0.82, -size * 0.62);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, 0, size * 0.68, size * 0.48, 0, 0, TAU);
  ctx.fill();
  for (const side of [-1, 1]) {
    // A pincer is a disc with a wedge cut out at the top.
    const px = side * size * 0.86;
    const py = -size * 0.78;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, size * 0.3, -Math.PI / 2 + 0.55, -Math.PI / 2 - 0.55 + TAU);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = SURFACE;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(side * size * 0.22, -size * 0.18, size * 0.1, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} angle
 * @param {number} length
 * @param {string} color
 */
function drawFish(ctx, x, y, angle, length, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, length / 2, length / 4.4, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-length * 0.38, 0);
  ctx.lineTo(-length * 0.74, -length * 0.24);
  ctx.lineTo(-length * 0.74, length * 0.24);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * A tuna seen from above, pointing east: a deep body, a forked tail and two side fins.
 * The shape is the same on both sides, so it looks right for every heading.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} length
 */
function drawTunaFish(ctx, x, y, length) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = PLUM_TEXT;
  ctx.beginPath();
  ctx.ellipse(0, 0, length / 2, length / 3.4, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-length * 0.36, 0);
  ctx.lineTo(-length * 0.8, -length * 0.36);
  ctx.lineTo(-length * 0.62, 0);
  ctx.lineTo(-length * 0.8, length * 0.36);
  ctx.closePath();
  ctx.fill();
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(length * 0.12, side * length * 0.24);
    ctx.lineTo(-length * 0.14, side * length * 0.5);
    ctx.lineTo(-length * 0.1, side * length * 0.24);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(length * 0.26, 0, length * 0.07, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Draws the game on a canvas and keeps the canvas sharp when it resizes. */
export class SeaView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('This browser cannot draw on a 2D canvas');
    }
    this.canvas = canvas;
    this.ctx = ctx;
    this.width = 0;
    this.height = 0;
    new ResizeObserver(() => {
      this.resize();
    }).observe(canvas);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
  }

  /**
   * @param {Game} game
   * @param {number} wall Real seconds, drives the idle animation.
   */
  draw(game, wall) {
    const ctx = this.ctx;
    const side = Math.min(this.width, this.height);
    if (side <= AXIS) {
      return;
    }
    const ratio = this.canvas.width / this.width;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    /** @type {Layout} */
    const layout = { cell: (side - AXIS) / game.size, size: game.size, left: AXIS };

    this.drawWater(layout, game, wall);
    this.drawPots(layout, game, wall);
    this.drawSardines(layout, game, wall);
    this.drawTuna(layout, game, wall);
    this.drawBoat(layout, game, wall);
    if (game.wonAt !== undefined) {
      this.drawLighthouse(layout, wall);
    }
    this.drawEffects(layout, game);
    this.drawAxes(layout);
  }

  /**
   * @param {Layout} layout
   * @param {Game} game
   * @param {number} wall
   */
  drawWater(layout, game, wall) {
    const ctx = this.ctx;
    const { cell, size, left } = layout;
    const span = cell * size;
    const water = ctx.createLinearGradient(left, 0, left + span, span);
    water.addColorStop(0, WATER_LIGHT);
    water.addColorStop(1, WATER_DEEP);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(left, 0, span, span, CORNER);
    ctx.clip();
    ctx.fillStyle = water;
    ctx.fillRect(left, 0, span, span);

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const [cx, cy] = centre(layout, x, y);
        const terrain = game.terrainAt(x, y);
        if ((x + y) % 2 === 1) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.fillRect(cx - cell / 2, cy - cell / 2, cell, cell);
        }
        if (terrain === 'reef') {
          this.drawReef(layout, x, y);
        } else if (terrain === 'dock') {
          this.drawDock(layout);
        }
        // Three small waves per cell drift from side to side.
        ctx.strokeStyle = 'rgba(146, 114, 168, 0.4)';
        ctx.lineWidth = 1.2;
        ctx.lineCap = 'round';
        for (let i = 0; i < 3; i += 1) {
          const drift = Math.sin(wall * 0.7 + noise(x, y, i) * TAU) * cell * 0.05;
          const wx = cx + (noise(x, y, i + 3) - 0.5) * cell * 0.62 + drift;
          const wy = cy + (noise(x, y, i + 6) - 0.5) * cell * 0.7;
          const w = cell * 0.07;
          ctx.beginPath();
          ctx.moveTo(wx - w, wy);
          ctx.quadraticCurveTo(wx - w / 2, wy - w * 0.6, wx, wy);
          ctx.quadraticCurveTo(wx + w / 2, wy + w * 0.6, wx + w, wy);
          ctx.stroke();
        }
      }
    }

    ctx.strokeStyle = 'rgba(113, 83, 133, 0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let i = 1; i < size; i += 1) {
      ctx.moveTo(left + i * cell, 0);
      ctx.lineTo(left + i * cell, span);
      ctx.moveTo(left, i * cell);
      ctx.lineTo(left + span, i * cell);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    ctx.strokeStyle = WATER_EDGE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(left + 0.5, 0.5, span - 1, span - 1, CORNER);
    ctx.stroke();
  }

  /**
   * @param {Layout} layout
   * @param {number} x
   * @param {number} y
   */
  drawReef(layout, x, y) {
    const ctx = this.ctx;
    const { cell } = layout;
    const [cx, cy] = centre(layout, x, y);
    ctx.fillStyle = ROSE_SOFT;
    ctx.beginPath();
    ctx.ellipse(cx, cy, cell * 0.44, cell * 0.4, 0, 0, TAU);
    ctx.fill();
    for (let i = 0; i < 5; i += 1) {
      const angle = (i / 5) * TAU + noise(x, y, i) * 0.8;
      const reach = cell * (0.2 + noise(x, y, i + 5) * 0.14);
      const radius = cell * (0.045 + noise(x, y, i + 10) * 0.04);
      ctx.fillStyle = BLUSH;
      ctx.beginPath();
      ctx.ellipse(
        cx + Math.cos(angle) * reach,
        cy + Math.sin(angle) * reach,
        radius * 1.25,
        radius,
        angle,
        0,
        TAU
      );
      ctx.fill();
    }
  }

  /** @param {Layout} layout */
  drawDock(layout) {
    const ctx = this.ctx;
    const { cell } = layout;
    const [cx, cy] = centre(layout, 0, 0);
    const left = cx - cell / 2;
    const bottom = cy + cell / 2;
    const plank = cell * 0.18;
    // An L-shaped pier along the two outer edges keeps the middle free for the boat.
    ctx.fillStyle = BLUSH;
    ctx.fillRect(left, bottom - cell, plank, cell);
    ctx.fillRect(left, bottom - plank, cell, plank);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 6; i += 1) {
      const offset = (cell / 6) * i;
      ctx.moveTo(left, bottom - cell + offset - cell / 12);
      ctx.lineTo(left + plank, bottom - cell + offset - cell / 12);
      ctx.moveTo(left + offset + cell / 12, bottom - plank);
      ctx.lineTo(left + offset + cell / 12, bottom);
    }
    ctx.stroke();
    ctx.fillStyle = ROSE;
    for (const [px, py] of [
      [left + plank, bottom - cell * 0.92],
      [left + plank, bottom - cell * 0.5],
      [left + cell * 0.5, bottom - plank],
      [left + cell * 0.92, bottom - plank],
    ]) {
      ctx.beginPath();
      ctx.arc(px ?? 0, py ?? 0, cell * 0.028, 0, TAU);
      ctx.fill();
    }
  }

  /**
   * @param {Layout} layout
   * @param {Game} game
   * @param {number} wall
   */
  drawPots(layout, game, wall) {
    const ctx = this.ctx;
    const { cell } = layout;
    for (const pot of game.pots.values()) {
      const [cx, cy] = centre(layout, pot.x, pot.y);
      // The pot is a small wire cage in the corner of the reef.
      const half = cell * 0.1;
      const px = cx + cell * 0.28;
      const py = cy - cell * 0.28;
      ctx.fillStyle = SURFACE;
      ctx.strokeStyle = ROSE_STRONG;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.roundRect(px - half, py - half, half * 2, half * 2, half * 0.35);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const offset of [-half / 3, half / 3]) {
        ctx.moveTo(px + offset, py - half);
        ctx.lineTo(px + offset, py + half);
        ctx.moveTo(px - half, py + offset);
        ctx.lineTo(px + half, py + offset);
      }
      ctx.stroke();
      // One crab on the reef for every crab in the pot.
      for (let i = 0; i < pot.crabs; i += 1) {
        const [dx, dy] = CRAB_SPOTS[i % CRAB_SPOTS.length] ?? [0, 0];
        const step = Math.sin(wall * 4 + i * 1.7);
        drawCrab(ctx, cx + (dx + step * 0.012) * cell, cy + dy * cell, cell * 0.11, step);
      }
    }
  }

  /**
   * @param {Layout} layout
   * @param {Game} game
   * @param {number} wall
   */
  drawSardines(layout, game, wall) {
    const { cell } = layout;
    for (const shoal of game.shoals.values()) {
      const [cx, cy] = centre(layout, shoal.x, shoal.y);
      const turn = noise(shoal.x, shoal.y, 20) > 0.5 ? 1 : -1;
      const start = wall * 0.9 * turn + noise(shoal.x, shoal.y, 21) * TAU;
      for (let i = 0; i < shoal.size; i += 1) {
        const angle = start + (i / shoal.size) * TAU;
        const reach = cell * (0.27 + 0.03 * Math.sin(wall * 2 + i));
        const fx = cx + Math.cos(angle) * reach;
        const fy = cy + Math.sin(angle) * reach * 0.82;
        drawFish(this.ctx, fx, fy, angle + (Math.PI / 2) * turn, cell * 0.15, PLUM);
      }
    }
  }

  /**
   * @param {Layout} layout
   * @param {Game} game
   * @param {number} wall
   */
  drawTuna(layout, game, wall) {
    const ctx = this.ctx;
    const { cell } = layout;
    for (const tuna of game.tunas) {
      const t = ease((game.time - tuna.movedAt) / 0.6);
      const [cx, cy] = centre(
        layout,
        tuna.fromX + (tuna.x - tuna.fromX) * t,
        tuna.fromY + (tuna.y - tuna.fromY) * t
      );
      const heading = HEADING[tuna.dir];
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(heading);
      const sway = Math.sin(wall * 5) * cell * 0.015;
      for (const [dx, dy] of [
        [0.15, 0],
        [-0.15, -0.2],
        [-0.15, 0.2],
      ]) {
        drawTunaFish(ctx, (dx ?? 0) * cell, (dy ?? 0) * cell + sway, cell * 0.25);
      }
      ctx.restore();
    }
  }

  /**
   * @param {Layout} layout
   * @param {Game} game
   * @param {number} wall
   */
  drawBoat(layout, game, wall) {
    const ctx = this.ctx;
    const { cell } = layout;
    const boat = game.boat;
    const moving = boat.moveTime > 0 ? ease((game.time - boat.moveStart) / boat.moveTime) : 1;
    const [cx, cy] = centre(
      layout,
      boat.fromX + (boat.x - boat.fromX) * (boat.moveStart < 0 ? 1 : moving),
      boat.fromY + (boat.y - boat.fromY) * (boat.moveStart < 0 ? 1 : moving)
    );

    const casting = boat.castTime > 0 ? (game.time - boat.castStart) / boat.castTime : 2;
    if (boat.castStart >= 0 && casting >= 0 && casting <= 1) {
      ctx.strokeStyle = `rgba(169, 68, 96, ${0.55 * (1 - casting)})`;
      ctx.lineWidth = 1.5;
      for (const lag of [0, 0.35]) {
        const grow = Math.max(0, casting - lag);
        ctx.beginPath();
        ctx.arc(cx, cy, cell * (0.18 + grow * 0.32), 0, TAU);
        ctx.stroke();
      }
    }

    const length = cell * 0.3;
    const bob = Math.sin(wall * 2.2) * cell * 0.012;
    ctx.save();
    ctx.translate(cx, cy + bob);
    ctx.rotate(HEADING[boat.dir]);
    // The hull is drawn pointing east.
    ctx.fillStyle = 'rgba(113, 83, 133, 0.18)';
    ctx.beginPath();
    ctx.ellipse(-length * 0.05, length * 0.12, length * 1.02, length * 0.5, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(length, 0);
    ctx.bezierCurveTo(
      length * 0.5,
      -length * 0.56,
      -length * 0.6,
      -length * 0.5,
      -length * 0.9,
      -length * 0.36
    );
    ctx.lineTo(-length * 0.9, length * 0.36);
    ctx.bezierCurveTo(-length * 0.6, length * 0.5, length * 0.5, length * 0.56, length, 0);
    ctx.closePath();
    ctx.fillStyle = SURFACE;
    ctx.fill();
    ctx.strokeStyle = ROSE_STRONG;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = ACCENT;
    ctx.fillRect(-length * 0.9, -length * 0.36, length * 0.22, length * 0.72);
    ctx.fillStyle = ROSE_STRONG;
    ctx.beginPath();
    ctx.roundRect(-length * 0.5, -length * 0.22, length * 0.62, length * 0.44, length * 0.08);
    ctx.fill();
    // The cabin roof shows how full the cargo is.
    const full = Math.min(1, game.cargoTotal() / game.capacity);
    ctx.fillStyle = BLUSH;
    ctx.fillRect(-length * 0.44, -length * 0.16, length * 0.5 * full, length * 0.32);
    ctx.restore();
  }

  /**
   * @param {Layout} layout
   * @param {number} wall
   */
  drawLighthouse(layout, wall) {
    const ctx = this.ctx;
    const { cell } = layout;
    const [cx, cy] = centre(layout, 0, 0);
    const x = cx - cell * 0.3;
    const y = cy + cell * 0.3;
    const angle = wall * 0.8;
    const span = cell * layout.size;
    // The beam turns a full circle, so it is cut off at the edge of the sea.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(layout.left, 0, span, span, CORNER);
    ctx.clip();
    ctx.fillStyle = 'rgba(228, 127, 147, 0.24)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, cell * 1.7, angle - 0.22, angle + 0.22);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    for (const [radius, color] of /** @type {Array<[number, string]>} */ ([
      [0.15, ROSE],
      [0.105, SURFACE],
      [0.06, ACCENT],
    ])) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, cell * radius, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = ROSE_STRONG;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.15, 0, TAU);
    ctx.stroke();
  }

  /**
   * @param {Layout} layout
   * @param {Game} game
   */
  drawEffects(layout, game) {
    for (const effect of game.effects) {
      const age = game.time - effect.start;
      const [cx, cy] = centre(layout, effect.x, effect.y);
      const size = Math.max(11, layout.cell * 0.16);
      // Keep the whole text inside the sea, also in the cells at its edge.
      this.ctx.font = `600 ${size}px ${FONT}`;
      const half = this.ctx.measureText(effect.text).width / 2 + 4;
      const right = layout.left + layout.cell * layout.size;
      const x = Math.min(right - half, Math.max(layout.left + half, cx));
      this.ctx.globalAlpha = Math.max(0, 1 - age / 1.2);
      this.label(effect.text, x, cy - layout.cell * (0.3 + age * 0.25), size, TEXT, true);
      this.ctx.globalAlpha = 1;
    }
  }

  /** @param {Layout} layout */
  drawAxes(layout) {
    const { cell, size, left } = layout;
    for (let i = 0; i < size; i += 1) {
      this.label(String(i), left + (i + 0.5) * cell, size * cell + AXIS / 2, 11, MUTED);
      this.label(String(i), AXIS / 2 - 2, (size - 1 - i + 0.5) * cell, 11, MUTED);
    }
  }

  /**
   * @param {string} text
   * @param {number} x
   * @param {number} y
   * @param {number} size
   * @param {string} color
   * @param {boolean} [outlined]
   */
  label(text, x, y, size, color, outlined = false) {
    const ctx = this.ctx;
    ctx.font = `600 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (outlined) {
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = SURFACE;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}
