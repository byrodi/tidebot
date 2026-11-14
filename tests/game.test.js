// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STARTER_SCRIPT, UPGRADES } from '../js/content.js';
import { Game, STEP_COST, parseSave } from '../js/game.js';
import { Runner, ScriptError, compile } from '../js/lang.js';

const NO_TASKS = { streak: false, fullTrip: false, fastStart: false };
const NO_BEST = { streak: 0, fullTrip: 0, fastStart: 0 };

/**
 * Runs a script with every language feature unlocked and no game attached.
 *
 * @param {string} source
 * @returns {string[]} Lines the script printed.
 */
function output(source) {
  /** @type {string[]} */
  const lines = [];
  const game = new Game({
    code: '',
    stock: { sardine: 0, crab: 0, tuna: 0 },
    levels: { variables: 1, functions: 1, lists: 1 },
    playTime: 0,
    wonAt: undefined,
    tasks: NO_TASKS,
    best: NO_BEST,
  });
  const runner = new Runner(compile(source), {
    globals: game.globals((text) => lines.push(text)),
    stepCost: () => STEP_COST,
    lockedHint: (name) => game.lockedHint(name),
  });
  for (let steps = 0; !runner.done; steps += 1) {
    assert.ok(steps < 100000, 'script did not finish');
    runner.step();
  }
  return lines;
}

/**
 * Plays a script against a game for some game time.
 *
 * @param {Game} game
 * @param {string} source
 * @param {number} seconds
 */
function play(game, source, seconds) {
  const runner = new Runner(compile(source, game.features()), {
    globals: game.globals(() => {}),
    stepCost: () => STEP_COST / game.speed,
    lockedHint: (name) => game.lockedHint(name),
  });
  game.startRun();
  const end = game.time + seconds;
  while (game.time < end && !runner.done) {
    game.advance(runner.step());
  }
}

/**
 * @param {Record<string, number>} levels
 * @param {Partial<Record<'sardine' | 'crab' | 'tuna', number>>} [stock]
 * @returns {Game}
 */
function gameWith(levels, stock = {}) {
  return new Game({
    code: '',
    stock: { sardine: 0, crab: 0, tuna: 0, ...stock },
    levels,
    playTime: 0,
    wonAt: undefined,
    tasks: { ...NO_TASKS },
    best: { ...NO_BEST },
  });
}

test('math, text and precedence', () => {
  assert.deepEqual(output('print(1 + 2 * 3, (1 + 2) * 3, 7 % 4, -2 + 5, 10 / 4)'), ['7 9 3 3 2.5']);
  assert.deepEqual(output('print("a" + 1, 1 < 2 && 2 <= 2, !true || false)'), ['a1 true false']);
});

test('variables, loops and control flow', () => {
  const source = `
    let total = 0
    let i = 0
    while (true) {
      i++
      if (i > 10) { break }
      if (i % 2 == 0) { continue }
      total += i
    }
    print(total)`;
  assert.deepEqual(output(source), ['25']);
});

test('functions, recursion and early return', () => {
  const source = `
    print(fib(15))
    fn fib(n) {
      if (n < 2) { return n }
      return fib(n - 1) + fib(n - 2)
    }
    fn nothing() { return }
    print(nothing())`;
  assert.deepEqual(output(source), ['610', 'null']);
});

test('lists, for loops and records', () => {
  const source = `
    let squares = []
    for (i of range(1, 5)) { push(squares, i * i) }
    squares[0] += 10
    print(squares, len(squares), squares.length, [1, [2]] == [1, [2]])
    print(pop(squares), squares)`;
  assert.deepEqual(output(source), ['[11, 4, 9, 16] 4 4 true', '16 [11, 4, 9]']);
});

test('else if chains and statements without semicolons or parentheses', () => {
  const source = `
    let n = 5; let size = "none"
    if n < 3 { size = "small" } else if n < 10 { size = "medium" } else { size = "big" }
    print(size)`;
  assert.deepEqual(output(source), ['medium']);
});

test('errors name the line and explain the problem', () => {
  /** @type {Array<[string, RegExp, number]>} */
  const cases = [
    ['move(east)\ncast(', /Unexpected the end/, 2],
    ['print(1)\nprint(nope)', /Unknown name "nope"/, 2],
    ['let a = [1]\nprint(a[3])', /no item 3/, 2],
    ['cast', /write cast\(\)/, 1],
    ['print(1 / 0)', /divide by zero/, 1],
    ['fn f() { f() }\nf()', /too deep/, 1],
    ['let cargo = cargo()\ncargo()', /hides the built-in/, 2],
    ['move(up)', /Unknown name "up"/, 1],
    ['move("up")', /needs a direction/, 1],
    ['while (true) {', /never closed/, 1],
    ['x = 1', /Unknown variable "x"/, 1],
    ['for (let i = 0; i < 3; i++) {}', /for \(i of range/, 1],
  ];
  for (const [source, pattern, line] of cases) {
    assert.throws(
      () => output(source),
      (error) => {
        assert.ok(error instanceof ScriptError, `${source}: not a ScriptError: ${String(error)}`);
        assert.match(error.message, pattern);
        assert.equal(error.line, line, source);
        return true;
      }
    );
  }
});

test('locked language features are refused with the upgrade name', () => {
  const none = new Set();
  assert.throws(() => compile('let n = 1', none), /Buy "Variables"/);
  assert.throws(() => compile('fn f() {}', none), /Buy "Functions"/);
  assert.throws(() => compile('for (i of x) {}', none), /Buy "Lists"/);
  assert.doesNotThrow(() => compile(STARTER_SCRIPT, none));
  const game = gameWith({});
  assert.match(game.lockedHint('sonar') ?? '', /"Sonar" upgrade/);
});

test('the starter script runs once and brings the first sardines home', () => {
  const game = new Game();
  play(game, STARTER_SCRIPT, 30);
  assert.equal(game.stock.sardine, 2, 'a new game has a shoal next to the dock');
  assert.ok(game.time < 10, 'the script has no loop, so it ends');
});

test('the starter script in a loop keeps earning', () => {
  const game = gameWith({});
  play(game, `while (true) {\n${STARTER_SCRIPT}}`, 600);
  assert.ok(game.stock.sardine >= 10, `only ${game.stock.sardine} sardines in ten minutes`);
  assert.ok(game.cargoTotal() <= game.capacity);
});

test('an empty net takes longer and breaks the row of good casts', () => {
  const game = new Game();
  game.move('east');
  const hit = game.cast();
  assert.deepEqual([hit.value, hit.seconds, game.streak], [2, 1, 1]);
  game.shoals.clear();
  const miss = game.cast();
  assert.deepEqual([miss.value, miss.seconds, game.streak], [0, 2, 0]);
});

test('a script that looks before it casts finishes the first task', () => {
  const careful = gameWith({});
  /** @type {string[]} */
  const news = [];
  careful.notify = (message) => news.push(message);
  const sweep = `
    while (true) {
      while (cargo() < capacity()) {
        if (scan() == sardine) { cast() }
        else if (posY() % 2 == 0) { if (!move(east)) { if (!move(north)) { break } } }
        else { if (!move(west)) { if (!move(north)) { break } } }
      }
      while (posX() > 0) { move(west) }
      while (posY() > 0) { move(south) }
      unload()
    }`;
  play(careful, sweep, 300);
  assert.equal(careful.tasks.streak, true);
  assert.match(news[0] ?? '', /^Task done: /);

  const blind = gameWith({});
  play(blind, 'while (true) { move(east) cast() cast() cast() move(west) unload() }', 300);
  assert.equal(blind.tasks.streak, false, 'a blind cast hits an empty net too often');
});

test('five full trips in a row finish the second task, a short trip starts over', () => {
  const game = gameWith({});
  const trip = (/** @type {number} */ fish) => {
    game.boat.cargo.sardine = fish;
    game.unload();
  };
  for (const fish of [6, 6, 6, 6, 3]) {
    trip(fish);
  }
  assert.deepEqual([game.tasks.fullTrip, game.taskProgress('fullTrip').value], [false, 4]);
  for (const fish of [6, 6, 6, 6, 6]) {
    trip(fish);
  }
  assert.equal(game.tasks.fullTrip, true);
});

test('the fast start task counts only fish caught in the first seconds of this run', () => {
  const unloadTen = (/** @type {Game} */ game, /** @type {number} */ times) => {
    for (let i = 0; i < times; i += 1) {
      game.boat.cargo.sardine = 10;
      game.unload();
    }
  };
  const quick = gameWith({ hold: 1 });
  quick.boat.cargo.sardine = 10;
  quick.startRun();
  unloadTen(quick, 4);
  assert.equal(quick.tasks.fastStart, false, 'fish from before the run do not count');
  unloadTen(quick, 1);
  assert.equal(quick.tasks.fastStart, true);

  const slow = gameWith({ hold: 1 });
  slow.startRun();
  slow.advance(41);
  unloadTen(slow, 5);
  assert.equal(slow.tasks.fastStart, false);
});

test('a language upgrade is sold only after its task', () => {
  const game = gameWith({}, { sardine: 500 });
  assert.equal(game.canBuy('variables'), false);
  assert.equal(game.canBuy('engine'), false, 'the engine needs variables');
  game.tasks.streak = true;
  assert.equal(game.buy('variables'), true);
  assert.equal(game.canBuy('engine'), true);
  assert.equal(game.canBuy('functions'), false, 'its own task is still open');
});

test('a full cargo stops the catch until the boat unloads', () => {
  const game = gameWith({});
  play(game, 'while (true) { move(east) cast() move(west) }', 900);
  assert.equal(game.cargoTotal(), game.capacity);
  assert.equal(game.stock.sardine, 0);
});

test('pots need bait and a reef, and give crabs back', () => {
  const game = gameWith({ variables: 1, functions: 1, pots: 1 });
  assert.equal(game.terrainAt(2, 1), 'reef');
  game.boat.cargo.sardine = 2;
  const source = `
    move(east) move(east) move(north)
    let dropped = dropPot()
    wait(30)
    let crabs = haulPot()
    while (posX() > 0) { move(west) }
    while (posY() > 0) { move(south) }
    unload()`;
  play(game, source, 60);
  assert.equal(game.stock.crab, 5);
  assert.equal(game.boat.pots, 2);
  assert.equal(game.pots.size, 0);
});

test('tuna take a crab and fill the cargo', () => {
  const game = gameWith({ variables: 1, functions: 1, lists: 1, sonar: 1, pots: 1, tuna: 1 });
  game.boat.cargo.crab = 1;
  const source = `
    fn step(tx, ty) {
      if (posX() < tx) { move(east) } else if (posX() > tx) { move(west) }
      else if (posY() < ty) { move(north) } else if (posY() > ty) { move(south) }
    }
    while (cargoOf(tuna) == 0) {
      for (shoal of sonar()) {
        if (shoal.kind == tuna) {
          step(shoal.x, shoal.y)
          if (scan() == tuna) { cast() }
        }
      }
    }`;
  play(game, source, 120);
  assert.equal(game.boat.cargo.tuna, 3);
  assert.equal(game.boat.cargo.crab, 0);
});

test('upgrades cost stock and change the boat', () => {
  const game = gameWith({}, { sardine: 20 });
  assert.equal(game.canBuy('functions'), false, 'needs variables first');
  assert.equal(game.buy('hold'), true);
  assert.equal(game.capacity, 10);
  assert.equal(game.stock.sardine, 5);
  assert.equal(game.buy('net'), false);
  for (const upgrade of UPGRADES) {
    assert.ok(upgrade.levels.length > 0, upgrade.id);
  }
});

test('a save survives a round trip and bad data is refused', () => {
  const game = gameWith({ hold: 2 }, { sardine: 7 });
  game.tasks.streak = true;
  game.best.fullTrip = 3;
  const copy = parseSave(JSON.parse(JSON.stringify(game.toSave('cast()'))));
  assert.deepEqual(copy, game.toSave('cast()'));
  assert.equal(parseSave('nope'), undefined);
  assert.equal(parseSave({ code: 1 }), undefined);
  assert.equal(new Game(parseSave({ code: '', stock: {}, levels: { hold: 99 } })).capacity, 40);
});
