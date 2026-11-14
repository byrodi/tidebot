// @ts-check
/** The sea simulation: the boat, the fish, the stock and the upgrades. No DOM here. */

import { KINDS, TASK_GOALS, TASK_TEXT, UPGRADES, statOf, upgradeById } from './content.js';
import { Builtin, ScriptError, Wait, formatValue } from './lang.js';

/** @typedef {import('./content.js').Kind} Kind */
/** @typedef {import('./content.js').Cost} Cost */
/** @typedef {import('./content.js').TaskKind} TaskKind */
/** @typedef {import('./lang.js').Value} Value */
/** @typedef {'north' | 'east' | 'south' | 'west'} Direction */
/** @typedef {Record<Kind, number>} Tally */
/** @typedef {{ x: number, y: number, size: number, age: number, life: number, grow: number }} Shoal */
/** @typedef {{ x: number, y: number, crabs: number, timer: number }} Pot */
/** @typedef {{ x: number, y: number, text: string, start: number }} Effect */

/**
 * @typedef {object} Tuna
 * @property {number} x
 * @property {number} y
 * @property {Direction} dir
 * @property {number} timer Seconds until the next move.
 * @property {number} fromX Cell it came from, for the animation.
 * @property {number} fromY
 * @property {number} movedAt Game time of the last move.
 */

/**
 * @typedef {object} Boat
 * @property {number} x
 * @property {number} y
 * @property {Direction} dir
 * @property {Tally} cargo
 * @property {number} pots Pots on board.
 * @property {number} fromX Cell it came from, for the animation.
 * @property {number} fromY
 * @property {number} moveStart
 * @property {number} moveTime
 * @property {number} castStart
 * @property {number} castTime
 */

/**
 * @typedef {object} SaveData
 * @property {string} code
 * @property {Tally} stock
 * @property {Record<string, number>} levels
 * @property {number} playTime
 * @property {number | undefined} wonAt
 * @property {Record<TaskKind, boolean>} tasks Tasks already done.
 * @property {Record<TaskKind, number>} best Best result so far in each task.
 */

/** Seconds one script statement takes with the first engine. */
export const STEP_COST = 0.004;

const MOVE_TIME = 0.5;
const BLOCKED_TIME = 0.2;
const CAST_TIME = 1;
/** A net that comes back empty takes longer, so a script should look before it casts. */
const EMPTY_CAST_TIME = 2;
const UNLOAD_TIME = 0.5;
const DROP_TIME = 1;
const HAUL_TIME = 1.5;
const SHOAL_MAX = 8;
const SHOAL_GROW = 3;
/** Share of the water cells that hold a shoal. Low, so a fixed route mostly finds nothing. */
const SHOAL_SHARE = 0.45;
const POT_MAX = 5;
const POT_FILL = 4;
const TUNA_STEP = 2;
const TUNA_CATCH = 3;
const TUNA_RESPAWN = 8;
/** Biggest slice of time the simulation handles at once. */
const MAX_TICK = 0.25;
const MAX_WAIT = 60;
const MAX_RANGE = 10000;

/** @type {ReadonlyArray<Direction>} */
const DIRECTIONS = ['north', 'east', 'south', 'west'];
/** @type {Readonly<Record<Direction, readonly [number, number]>>} */
const STEPS = { north: [0, 1], east: [1, 0], south: [0, -1], west: [-1, 0] };
/** @type {Readonly<Record<Direction, Direction>>} */
const OPPOSITE = { north: 'south', east: 'west', south: 'north', west: 'east' };

/** Built-ins that exist only after an upgrade, with the upgrade that adds them. */
/** @type {Readonly<Record<string, string>>} */
const GATED = {
  sonar: 'sonar',
  dropPot: 'pots',
  haulPot: 'pots',
  potsLeft: 'pots',
  potCrabs: 'pots',
  range: 'lists',
  len: 'lists',
  push: 'lists',
  pop: 'lists',
};

/**
 * @param {number} x
 * @param {number} y
 * @returns {number} Map key of a cell. Stays valid when the sea grows.
 */
function cellKey(x, y) {
  return x + y * 64;
}

/**
 * @param {number} count
 * @returns {number} A whole number from 0 to count - 1.
 */
function randomBelow(count) {
  return Math.floor(Math.random() * count);
}

/**
 * @param {Value | undefined} value
 * @param {string} fn Name of the built-in, for the message.
 * @returns {number}
 */
function numberArg(value, fn) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ScriptError(`${fn}() needs a number, got ${formatValue(value ?? null, true)}`);
  }
  return value;
}

/**
 * @param {Value | undefined} value
 * @param {string} fn
 * @returns {Value[]}
 */
function listArg(value, fn) {
  if (!Array.isArray(value)) {
    throw new ScriptError(`${fn}() needs a list, got ${formatValue(value ?? null, true)}`);
  }
  return value;
}

/**
 * @param {Value | undefined} value
 * @param {string} fn
 * @returns {Kind}
 */
function kindArg(value, fn) {
  if (value === 'sardine' || value === 'crab' || value === 'tuna') {
    return value;
  }
  throw new ScriptError(`${fn}() needs a kind of catch: sardine, crab or tuna`);
}

/**
 * @param {Value | undefined} value
 * @returns {Direction}
 */
function directionArg(value) {
  if (value === 'north' || value === 'east' || value === 'south' || value === 'west') {
    return value;
  }
  throw new ScriptError('move() needs a direction: north, east, south or west');
}

/**
 * @param {unknown} value
 * @returns {number | undefined} The value when it is a usable amount.
 */
function amount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Checks data read from storage.
 *
 * @param {unknown} raw
 * @returns {SaveData | undefined} Undefined when the data is not a save.
 */
export function parseSave(raw) {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const data = /** @type {Record<string, unknown>} */ (raw); // Narrowed to an object above.
  const stock = data['stock'];
  const levels = data['levels'];
  if (typeof data['code'] !== 'string' || typeof stock !== 'object' || stock === null) {
    return undefined;
  }
  if (typeof levels !== 'object' || levels === null) {
    return undefined;
  }
  const stockFields = /** @type {Record<string, unknown>} */ (stock);
  // Saves from before the tasks have neither field.
  const tasks = /** @type {Record<string, unknown>} */ (
    typeof data['tasks'] === 'object' && data['tasks'] !== null ? data['tasks'] : {}
  );
  const best = /** @type {Record<string, unknown>} */ (
    typeof data['best'] === 'object' && data['best'] !== null ? data['best'] : {}
  );
  /** @type {Record<string, number>} */
  const cleanLevels = {};
  for (const [id, level] of Object.entries(levels)) {
    const checked = amount(level);
    if (checked !== undefined) {
      cleanLevels[id] = Math.floor(checked);
    }
  }
  return {
    code: data['code'],
    stock: {
      sardine: amount(stockFields['sardine']) ?? 0,
      crab: amount(stockFields['crab']) ?? 0,
      tuna: amount(stockFields['tuna']) ?? 0,
    },
    levels: cleanLevels,
    playTime: amount(data['playTime']) ?? 0,
    wonAt: amount(data['wonAt']),
    tasks: {
      streak: tasks['streak'] === true,
      fullTrip: tasks['fullTrip'] === true,
      fastStart: tasks['fastStart'] === true,
    },
    best: {
      streak: amount(best['streak']) ?? 0,
      fullTrip: amount(best['fullTrip']) ?? 0,
      fastStart: amount(best['fastStart']) ?? 0,
    },
  };
}

/** The whole game state and its rules. */
export class Game {
  /** @param {SaveData} [save] */
  constructor(save) {
    /** @type {Record<string, number>} */
    this.levels = {};
    for (const upgrade of UPGRADES) {
      this.levels[upgrade.id] = Math.min(save?.levels[upgrade.id] ?? 0, upgrade.levels.length);
    }
    /** @type {Tally} */
    this.stock = { sardine: 0, crab: 0, tuna: 0, ...save?.stock };
    /** Seconds played over all sessions. */
    this.playTime = save?.playTime ?? 0;
    /** Play time when the lighthouse was built. */
    this.wonAt = save?.wonAt;
    /** @type {Record<TaskKind, boolean>} */
    this.tasks = { streak: false, fullTrip: false, fastStart: false, ...save?.tasks };
    /** @type {Record<TaskKind, number>} */
    this.best = { streak: 0, fullTrip: 0, fastStart: 0, ...save?.best };
    /** Casts in a row that caught something. */
    this.streak = 0;
    /** Trips in a row that came back with a full cargo. */
    this.fullTrips = 0;
    /** Game time when the current run started. */
    this.runStart = 0;
    /** Sardines caught and unloaded in the current run. */
    this.runUnloaded = 0;
    /** Sardines that were already on board when the run started. They do not count. */
    this.carried = 0;
    /** Seconds simulated in this session. */
    this.time = 0;
    /** Grows whenever stock or upgrades change, so the UI knows when to redraw. */
    this.version = 0;
    /** @type {Map<number, Shoal>} */
    this.shoals = new Map();
    /** @type {Map<number, Pot>} */
    this.pots = new Map();
    /** @type {Tuna[]} */
    this.tunas = [];
    /** @type {number[]} Seconds until each missing tuna shoal comes back. */
    this.tunaRespawns = [];
    /** @type {Effect[]} */
    this.effects = [];
    this.spawnTimer = 0;
    /** @type {Boat} */
    this.boat = {
      x: 0,
      y: 0,
      dir: 'east',
      cargo: { sardine: 0, crab: 0, tuna: 0 },
      pots: this.potMax,
      fromX: 0,
      fromY: 0,
      moveStart: -1,
      moveTime: 0,
      castStart: -1,
      castTime: 0,
    };
    /** @type {(message: string) => void} Receives hints about wasted actions. */
    this.warn = () => {};
    /** @type {(message: string) => void} Receives good news, such as a finished task. */
    this.notify = () => {};

    if (save === undefined) {
      // A new player's first script fishes the cell next to the dock. It must not be empty.
      this.shoals.set(cellKey(1, 0), { x: 1, y: 0, size: 6, age: 0, life: 60, grow: SHOAL_GROW });
    }
    for (let i = 0; i < 3; i += 1) {
      const shoal = this.spawnSardine();
      if (shoal !== undefined) {
        shoal.age = randomBelow(15);
      }
    }
    this.syncTuna();
  }

  /**
   * @param {string} id
   * @returns {number} Levels bought of an upgrade.
   */
  level(id) {
    return this.levels[id] ?? 0;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this.level(id) > 0;
  }

  /** @returns {number} */
  get size() {
    return statOf('sea', this.level('sea'));
  }

  /** @returns {number} */
  get capacity() {
    return statOf('hold', this.level('hold'));
  }

  /** @returns {number} */
  get speed() {
    return statOf('engine', this.level('engine'));
  }

  /** @returns {number} */
  get net() {
    return statOf('net', this.level('net'));
  }

  /** @returns {number} */
  get potMax() {
    return statOf('pots', this.level('pots'));
  }

  /** @returns {number} */
  cargoTotal() {
    const cargo = this.boat.cargo;
    return cargo.sardine + cargo.crab + cargo.tuna;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  inSea(x, y) {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {'dock' | 'reef' | 'water'}
   */
  terrainAt(x, y) {
    if (x === 0 && y === 0) {
      return 'dock';
    }
    // Reefs sit a knight's move apart, so every sea size has a few and none touch.
    return this.has('pots') && (x + 2 * y) % 5 === 4 ? 'reef' : 'water';
  }

  /** @returns {Set<string>} Language features the player owns. */
  features() {
    return new Set(['variables', 'functions', 'lists'].filter((id) => this.has(id)));
  }

  /**
   * @param {string} id
   * @returns {Cost | undefined} Price of the next level, undefined when all are bought.
   */
  nextCost(id) {
    return upgradeById(id).levels[this.level(id)]?.cost;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  canBuy(id) {
    const upgrade = upgradeById(id);
    const cost = this.nextCost(id);
    if (cost === undefined || (upgrade.requires !== undefined && !this.has(upgrade.requires))) {
      return false;
    }
    if (upgrade.task !== undefined && !this.tasks[upgrade.task]) {
      return false;
    }
    return KINDS.every((kind) => this.stock[kind] >= (cost[kind] ?? 0));
  }

  /**
   * @param {TaskKind} kind
   * @returns {{ value: number, goal: number }} Best result so far and the result that is needed.
   */
  taskProgress(kind) {
    const goals = {
      streak: TASK_GOALS.streak,
      fullTrip: TASK_GOALS.fullTrips,
      fastStart: TASK_GOALS.fastCatch,
    };
    return { value: Math.min(this.best[kind], goals[kind]), goal: goals[kind] };
  }

  /**
   * Notes a result in a task and finishes the task when the result is good enough.
   *
   * @param {TaskKind} kind
   * @param {number} value
   */
  record(kind, value) {
    if (this.tasks[kind] || value <= this.best[kind]) {
      return;
    }
    this.best[kind] = value;
    if (value >= this.taskProgress(kind).goal) {
      this.tasks[kind] = true;
      this.notify(`Task done: ${TASK_TEXT[kind]}`);
    }
    this.version += 1;
  }

  /**
   * @param {string} id
   * @returns {boolean} False when the upgrade cannot be bought now.
   */
  buy(id) {
    const cost = this.nextCost(id);
    if (cost === undefined || !this.canBuy(id)) {
      return false;
    }
    for (const kind of KINDS) {
      this.stock[kind] -= cost[kind] ?? 0;
    }
    const potsBefore = this.potMax;
    this.levels[id] = this.level(id) + 1;
    if (id === 'pots') {
      this.boat.pots += this.potMax - potsBefore;
      for (const [key, shoal] of this.shoals) {
        if (this.terrainAt(shoal.x, shoal.y) === 'reef') {
          this.shoals.delete(key);
        }
      }
    }
    if (id === 'lighthouse') {
      this.wonAt = this.playTime;
    }
    this.syncTuna();
    this.version += 1;
    return true;
  }

  /**
   * @param {string} code
   * @returns {SaveData}
   */
  toSave(code) {
    return {
      code,
      stock: { ...this.stock },
      levels: { ...this.levels },
      playTime: this.playTime,
      wonAt: this.wonAt,
      tasks: { ...this.tasks },
      best: { ...this.best },
    };
  }

  /** Puts the boat back at the dock. Every script run starts there. */
  startRun() {
    const boat = this.boat;
    this.streak = 0;
    this.fullTrips = 0;
    this.runStart = this.time;
    this.runUnloaded = 0;
    this.carried = boat.cargo.sardine;
    boat.x = 0;
    boat.y = 0;
    boat.dir = 'east';
    boat.moveStart = -1;
    boat.castStart = -1;
  }

  /**
   * Moves the simulation forward.
   *
   * @param {number} seconds
   */
  advance(seconds) {
    let left = seconds;
    while (left > 0) {
      const slice = Math.min(left, MAX_TICK);
      this.tick(slice);
      left -= slice;
    }
  }

  /** @param {number} dt */
  tick(dt) {
    this.time += dt;
    this.playTime += dt;

    for (const [key, shoal] of this.shoals) {
      shoal.age += dt;
      if (shoal.age >= shoal.life) {
        this.shoals.delete(key);
        continue;
      }
      shoal.grow -= dt;
      if (shoal.grow <= 0) {
        shoal.grow += SHOAL_GROW;
        shoal.size = Math.min(SHOAL_MAX, shoal.size + 1);
      }
    }
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = Math.max(0.35, 22 / (this.size * this.size));
      this.spawnSardine();
    }

    for (const pot of this.pots.values()) {
      if (pot.crabs < POT_MAX) {
        pot.timer -= dt;
        if (pot.timer <= 0) {
          pot.timer += POT_FILL;
          pot.crabs += 1;
        }
      }
    }

    for (const tuna of this.tunas) {
      tuna.timer -= dt;
      if (tuna.timer <= 0) {
        tuna.timer += TUNA_STEP;
        this.moveTuna(tuna);
      }
    }
    const waiting = this.tunaRespawns.map((seconds) => seconds - dt);
    this.tunaRespawns = waiting.filter((seconds) => seconds > 0);
    for (let i = this.tunaRespawns.length; i < waiting.length; i += 1) {
      this.spawnTuna();
    }

    if (this.effects.length > 0) {
      this.effects = this.effects.filter((effect) => this.time - effect.start < 1.2);
    }
  }

  /** @returns {Shoal | undefined} The new shoal, undefined when the sea is full. */
  spawnSardine() {
    /** @type {Array<[number, number]>} */
    const empty = [];
    let water = 0;
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.terrainAt(x, y) !== 'water') {
          continue;
        }
        water += 1;
        if (!this.shoals.has(cellKey(x, y))) {
          empty.push([x, y]);
        }
      }
    }
    const spot = empty[randomBelow(empty.length)];
    if (spot === undefined || this.shoals.size >= Math.max(2, Math.round(water * SHOAL_SHARE))) {
      return undefined;
    }
    const [x, y] = spot;
    /** @type {Shoal} */
    const shoal = {
      x,
      y,
      size: 2 + randomBelow(3),
      age: 0,
      life: 20 + Math.random() * 15,
      grow: SHOAL_GROW,
    };
    this.shoals.set(cellKey(x, y), shoal);
    return shoal;
  }

  /** Keeps the number of tuna shoals right for the upgrades owned. */
  syncTuna() {
    const wanted = this.has('tuna') ? (this.size >= 6 ? 2 : 1) : 0;
    while (this.tunas.length + this.tunaRespawns.length < wanted) {
      this.tunaRespawns.push(2);
    }
  }

  spawnTuna() {
    let x = 0;
    let y = 0;
    while ((x === 0 && y === 0) || (x === this.boat.x && y === this.boat.y)) {
      x = randomBelow(this.size);
      y = randomBelow(this.size);
    }
    const dir = DIRECTIONS[randomBelow(DIRECTIONS.length)] ?? 'north';
    this.tunas.push({ x, y, dir, timer: TUNA_STEP, fromX: x, fromY: y, movedAt: -1 });
  }

  /** @param {Tuna} tuna */
  moveTuna(tuna) {
    // Straight ahead, or back the way it came when the edge or the dock is in the way.
    for (const dir of [tuna.dir, OPPOSITE[tuna.dir]]) {
      const [dx, dy] = STEPS[dir];
      const x = tuna.x + dx;
      const y = tuna.y + dy;
      if (this.inSea(x, y) && this.terrainAt(x, y) !== 'dock') {
        tuna.fromX = tuna.x;
        tuna.fromY = tuna.y;
        tuna.x = x;
        tuna.y = y;
        tuna.dir = dir;
        tuna.movedAt = this.time;
        return;
      }
    }
  }

  /** @param {string} text Shown floating above the boat for a moment. */
  float(text) {
    this.effects.push({ x: this.boat.x, y: this.boat.y, text, start: this.time });
  }

  /**
   * @param {number} seconds Time the action takes with the first engine.
   * @param {Value} value What the script gets back.
   * @returns {Wait}
   */
  act(seconds, value) {
    return new Wait(seconds / this.speed, value);
  }

  /**
   * @param {Direction} dir
   * @returns {Wait}
   */
  move(dir) {
    const boat = this.boat;
    const [dx, dy] = STEPS[dir];
    const x = boat.x + dx;
    const y = boat.y + dy;
    boat.dir = dir;
    if (!this.inSea(x, y)) {
      return this.act(BLOCKED_TIME, false);
    }
    boat.fromX = boat.x;
    boat.fromY = boat.y;
    boat.x = x;
    boat.y = y;
    boat.moveStart = this.time;
    boat.moveTime = MOVE_TIME / this.speed;
    return this.act(MOVE_TIME, true);
  }

  /** @returns {Wait} */
  cast() {
    const boat = this.boat;
    const caught = this.catchHere();
    const seconds = caught > 0 ? CAST_TIME : EMPTY_CAST_TIME;
    if (caught > 0) {
      this.streak += 1;
      this.record('streak', this.streak);
    } else {
      this.streak = 0;
    }
    boat.castStart = this.time;
    boat.castTime = seconds / this.speed;
    return this.act(seconds, caught);
  }

  /** @returns {number} Fish caught in the boat's cell. */
  catchHere() {
    const boat = this.boat;
    const free = this.capacity - this.cargoTotal();
    const tunaIndex = this.tunas.findIndex((tuna) => tuna.x === boat.x && tuna.y === boat.y);
    if (tunaIndex !== -1) {
      if (boat.cargo.crab > 0) {
        // The bait leaves the cargo, so one more slot is free.
        const caught = Math.min(TUNA_CATCH, free + 1);
        boat.cargo.crab -= 1;
        boat.cargo.tuna += caught;
        this.tunas.splice(tunaIndex, 1);
        this.tunaRespawns.push(TUNA_RESPAWN);
        this.float(`+${caught} tuna`);
        return caught;
      }
      this.warn('Tuna only bite on crab bait. Keep at least one crab in the cargo.');
    }
    const key = cellKey(boat.x, boat.y);
    const shoal = this.shoals.get(key);
    if (shoal === undefined) {
      if (tunaIndex === -1) {
        this.warn('cast() found no fish here and lost 2 seconds. Check with scan() first.');
      }
      return 0;
    }
    if (free <= 0) {
      this.warn('The cargo is full. Sail to the dock and unload().');
      return 0;
    }
    const caught = Math.min(shoal.size, this.net, free);
    shoal.size -= caught;
    if (shoal.size === 0) {
      this.shoals.delete(key);
    }
    boat.cargo.sardine += caught;
    this.float(`+${caught}`);
    return caught;
  }

  /** @returns {Wait} */
  unload() {
    const boat = this.boat;
    if (this.terrainAt(boat.x, boat.y) !== 'dock') {
      this.warn('unload() only works at the dock: x 0, y 0.');
      return this.act(BLOCKED_TIME, 0);
    }
    const total = this.cargoTotal();
    this.fullTrips = total >= this.capacity ? this.fullTrips + 1 : 0;
    this.runUnloaded += Math.max(0, boat.cargo.sardine - this.carried);
    this.carried = 0;
    for (const kind of KINDS) {
      this.stock[kind] += boat.cargo[kind];
      boat.cargo[kind] = 0;
    }
    if (total > 0) {
      this.float(`${total} unloaded`);
      this.version += 1;
      this.record('fullTrip', this.fullTrips);
      if (this.time - this.runStart <= TASK_GOALS.fastSeconds) {
        this.record('fastStart', this.runUnloaded);
      }
    }
    return this.act(UNLOAD_TIME, total);
  }

  /** @returns {Wait} */
  dropPot() {
    const boat = this.boat;
    const key = cellKey(boat.x, boat.y);
    /** @type {string | undefined} */
    let problem;
    if (this.terrainAt(boat.x, boat.y) !== 'reef') {
      problem = 'dropPot() only works on a reef. Check with terrain() == "reef".';
    } else if (this.pots.has(key)) {
      problem = 'There is already a pot on this reef.';
    } else if (boat.pots === 0) {
      problem = 'No pots left on board. Haul one first.';
    } else if (boat.cargo.sardine === 0) {
      problem = 'A pot needs bait. Keep at least one sardine in the cargo.';
    }
    if (problem !== undefined) {
      this.warn(problem);
      return this.act(BLOCKED_TIME, false);
    }
    boat.pots -= 1;
    boat.cargo.sardine -= 1;
    this.pots.set(key, { x: boat.x, y: boat.y, crabs: 0, timer: POT_FILL });
    return this.act(DROP_TIME, true);
  }

  /** @returns {Wait} */
  haulPot() {
    const boat = this.boat;
    const key = cellKey(boat.x, boat.y);
    const pot = this.pots.get(key);
    if (pot === undefined) {
      this.warn('haulPot() found no pot here.');
      return this.act(BLOCKED_TIME, 0);
    }
    const caught = Math.min(pot.crabs, this.capacity - this.cargoTotal());
    if (caught < pot.crabs) {
      this.warn('The cargo was full, so some crabs got away. Unload before you haul.');
    }
    this.pots.delete(key);
    boat.pots += 1;
    boat.cargo.crab += caught;
    if (caught > 0) {
      this.float(`+${caught} crab`);
    }
    return this.act(HAUL_TIME, caught);
  }

  /** @returns {Value[]} One record per shoal, as sonar() gives it to a script. */
  sonar() {
    /** @type {Value[]} */
    const found = [];
    for (const shoal of this.shoals.values()) {
      found.push({ x: shoal.x, y: shoal.y, kind: 'sardine', size: shoal.size, dir: null });
    }
    for (const tuna of this.tunas) {
      found.push({ x: tuna.x, y: tuna.y, kind: 'tuna', size: TUNA_CATCH, dir: tuna.dir });
    }
    return found;
  }

  /**
   * @param {string} name A name the script used that does not exist.
   * @returns {string | undefined} What to do about it, when the game knows.
   */
  lockedHint(name) {
    const id = GATED[name];
    if (id !== undefined && !this.has(id)) {
      return ` ${name}() comes with the "${upgradeById(id).name}" upgrade`;
    }
    return name === 'console' ? ' To write to the console, use print()' : undefined;
  }

  /**
   * @param {(text: string) => void} print Receives lines from print().
   * @returns {Map<string, Value>} Everything a script can use right now.
   */
  globals(print) {
    /** @type {Map<string, Value>} */
    const globals = new Map();
    for (const word of [...DIRECTIONS, ...KINDS]) {
      globals.set(word, word);
    }
    /**
     * @param {string} name
     * @param {number} min
     * @param {number} max
     * @param {(args: Value[]) => Value | Wait} run
     */
    const define = (name, min, max, run) => {
      globals.set(name, new Builtin(name, min, max, run));
    };
    const boat = this.boat;

    define('move', 1, 1, ([dir]) => this.move(directionArg(dir)));
    define('cast', 0, 0, () => this.cast());
    define('unload', 0, 0, () => this.unload());
    define('wait', 1, 1, ([seconds]) => {
      const time = numberArg(seconds, 'wait');
      if (time < 0 || time > MAX_WAIT) {
        throw new ScriptError(`wait() takes 0 to ${MAX_WAIT} seconds`);
      }
      return new Wait(time, null);
    });
    define('scan', 0, 0, () => {
      if (this.tunas.some((tuna) => tuna.x === boat.x && tuna.y === boat.y)) {
        return 'tuna';
      }
      return this.shoals.has(cellKey(boat.x, boat.y)) ? 'sardine' : null;
    });
    define('shoalSize', 0, 0, () => this.shoals.get(cellKey(boat.x, boat.y))?.size ?? 0);
    define('terrain', 0, 0, () => this.terrainAt(boat.x, boat.y));
    define('cargo', 0, 0, () => this.cargoTotal());
    define('cargoOf', 1, 1, ([kind]) => boat.cargo[kindArg(kind, 'cargoOf')]);
    define('stock', 1, 1, ([kind]) => this.stock[kindArg(kind, 'stock')]);
    define('capacity', 0, 0, () => this.capacity);
    define('posX', 0, 0, () => boat.x);
    define('posY', 0, 0, () => boat.y);
    define('seaSize', 0, 0, () => this.size);
    define('now', 0, 0, () => this.time);
    define('print', 0, 8, (args) => {
      print(args.map((arg) => formatValue(arg)).join(' '));
      return null;
    });
    define('abs', 1, 1, ([value]) => Math.abs(numberArg(value, 'abs')));
    define('floor', 1, 1, ([value]) => Math.floor(numberArg(value, 'floor')));
    define('min', 2, 2, ([a, b]) => Math.min(numberArg(a, 'min'), numberArg(b, 'min')));
    define('max', 2, 2, ([a, b]) => Math.max(numberArg(a, 'max'), numberArg(b, 'max')));
    define('random', 0, 0, () => Math.random());

    if (this.has('lists')) {
      define('len', 1, 1, ([value]) =>
        typeof value === 'string' ? value.length : listArg(value, 'len').length
      );
      define('push', 2, 2, ([list, value]) => {
        listArg(list, 'push').push(value ?? null);
        return null;
      });
      define('pop', 1, 1, ([list]) => {
        const items = listArg(list, 'pop');
        if (items.length === 0) {
          throw new ScriptError('pop() cannot take an item from an empty list');
        }
        return items.pop() ?? null;
      });
      define('range', 1, 2, (args) => {
        const first = numberArg(args[0], 'range');
        const start = args.length === 2 ? first : 0;
        const end = args.length === 2 ? numberArg(args[1], 'range') : first;
        if (end - start > MAX_RANGE) {
          throw new ScriptError(`range() can make at most ${MAX_RANGE} numbers`);
        }
        /** @type {Value[]} */
        const numbers = [];
        for (let value = start; value < end; value += 1) {
          numbers.push(value);
        }
        return numbers;
      });
    }
    if (this.has('sonar')) {
      define('sonar', 0, 0, () => this.sonar());
    }
    if (this.has('pots')) {
      define('dropPot', 0, 0, () => this.dropPot());
      define('haulPot', 0, 0, () => this.haulPot());
      define('potsLeft', 0, 0, () => boat.pots);
      define('potCrabs', 0, 0, () => this.pots.get(cellKey(boat.x, boat.y))?.crabs ?? 0);
    }
    return globals;
  }
}
