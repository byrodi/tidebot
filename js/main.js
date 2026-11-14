// @ts-check
/** Wires the page together: editor, game loop, Workshop, guide, console and saves. */

import { GUIDE, KINDS, STARTER_SCRIPT, TASK_TEXT, UPGRADES, costText, statOf } from './content.js';
import { Editor } from './editor.js';
import { Game, STEP_COST, parseSave } from './game.js';
import { Runner, ScriptError, compile } from './lang.js';
import { SeaView } from './render.js';

/** @typedef {import('./content.js').Upgrade} Upgrade */
/** @typedef {import('./content.js').Cost} Cost */
/** @typedef {import('./game.js').SaveData} SaveData */
/** @typedef {'idle' | 'running' | 'error'} Status */

const SAVE_KEY = 'tidebot-save-v1';
const SAVE_EVERY = 5;
/** Longest frame the game simulates, so a sleeping tab does not jump ahead. */
const MAX_FRAME = 0.1;
/** Most game time made up at once after the browser stopped drawing frames. */
const MAX_CATCH_UP = 60;
/** How often to check that frames still arrive, in milliseconds. */
const WATCHDOG_EVERY = 250;
/** Script steps per frame before the script has to wait for the next one. */
const MAX_STEPS = 4000;
const MAX_CONSOLE_LINES = 200;

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function byId(id, type) {
  const node = document.getElementById(id);
  if (!(node instanceof type)) {
    throw new Error(`The page has no #${id} of the expected type`);
  }
  return node;
}

/**
 * @param {string} kind
 * @returns {string} Markup of a catch icon.
 */
function icon(kind) {
  return `<svg class="icon icon-${kind}" aria-hidden="true"><use href="#icon-${kind}"></use></svg>`;
}

/**
 * @param {number} seconds
 * @returns {string} For example "4:07" or "1:02:45".
 */
function clockText(seconds) {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** @returns {SaveData | undefined} */
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw === null ? undefined : parseSave(JSON.parse(raw));
  } catch {
    // Storage is blocked or the save is broken. A new game is the only way on.
    return undefined;
  }
}

class App {
  constructor() {
    const save = loadSave();
    this.game = new Game(save);
    this.view = new SeaView(byId('sea', HTMLCanvasElement));
    this.editor = new Editor(byId('editor', HTMLElement), {
      onChange: () => {
        this.errorLine = 0;
        this.unsaved = true;
      },
      onRun: () => {
        this.run();
      },
    });
    this.editor.value = save?.code ?? STARTER_SCRIPT;

    /** @type {Runner | undefined} */
    this.runner = undefined;
    /** Game seconds the script still has to wait for its last step. */
    this.pending = 0;
    /** @type {number | undefined} */
    this.lastFrame = undefined;
    this.errorLine = 0;
    this.unsaved = false;
    this.sinceSave = 0;
    this.seenVersion = -1;
    /** @type {Set<string>} Hints already shown in this run. */
    this.warned = new Set();
    /** @type {Record<string, string>} Text last written to each HUD field. */
    this.shown = {};

    this.consoleBox = byId('console', HTMLElement);
    this.statusBox = byId('status', HTMLElement);
    this.stockBox = byId('stock', HTMLElement);
    this.workshopBox = byId('workshop', HTMLElement);
    this.guideBox = byId('guide', HTMLElement);
    this.winDialog = byId('win', HTMLDialogElement);
    this.resetButton = byId('reset', HTMLButtonElement);

    this.game.warn = (message) => {
      if (!this.warned.has(message)) {
        this.warned.add(message);
        this.log('hint', message);
      }
    };
    this.game.notify = (message) => {
      this.log('done', message);
    };
    this.bind();
    this.setStatus('idle', 'Ready');
    this.log('info', 'Welcome aboard. Press Run to start the script.');
  }

  bind() {
    byId('run', HTMLButtonElement).addEventListener('click', () => {
      this.run();
    });
    byId('stop', HTMLButtonElement).addEventListener('click', () => {
      if (this.runner !== undefined) {
        this.runner = undefined;
        this.pending = 0;
        this.setStatus('idle', 'Stopped');
        this.log('info', 'Script stopped.');
      }
    });
    this.workshopBox.addEventListener('click', (event) => {
      const button =
        event.target instanceof Element ? event.target.closest('button[data-buy]') : null;
      const id = button?.getAttribute('data-buy');
      if (id !== null && id !== undefined) {
        this.buy(id);
      }
    });
    for (const tab of document.querySelectorAll('[data-tab]')) {
      tab.addEventListener('click', () => {
        const name = tab.getAttribute('data-tab');
        for (const other of document.querySelectorAll('[data-tab]')) {
          other.setAttribute('aria-selected', String(other === tab));
        }
        this.workshopBox.hidden = name !== 'workshop';
        this.guideBox.hidden = name !== 'guide';
      });
    }
    this.resetButton.addEventListener('click', () => {
      if (this.resetButton.dataset['armed'] !== 'yes') {
        this.resetButton.dataset['armed'] = 'yes';
        this.resetButton.textContent = 'Click again to erase everything';
        window.setTimeout(() => {
          this.resetButton.dataset['armed'] = 'no';
          this.resetButton.textContent = 'Reset progress';
        }, 4000);
        return;
      }
      try {
        localStorage.removeItem(SAVE_KEY);
      } catch {
        // Storage is blocked, so there is no save to remove.
      }
      window.location.reload();
    });
    byId('win-close', HTMLButtonElement).addEventListener('click', () => {
      this.winDialog.close();
    });
    window.addEventListener('beforeunload', () => {
      this.save();
    });
  }

  start() {
    // Set here, so the timer below also works in a tab that never drew a frame.
    this.lastFrame = performance.now();
    requestAnimationFrame((timestamp) => {
      this.frame(timestamp);
    });
    // Browsers stop animation frames in a background tab. Timers still fire there,
    // so the script keeps fishing while the player reads something else.
    window.setInterval(() => {
      const now = performance.now();
      if (this.lastFrame !== undefined && now - this.lastFrame > WATCHDOG_EVERY) {
        this.catchUp(now);
      }
    }, WATCHDOG_EVERY);
  }

  /** @param {number} timestamp */
  catchUp(timestamp) {
    const elapsed = Math.min(MAX_CATCH_UP, (timestamp - (this.lastFrame ?? timestamp)) / 1000);
    this.lastFrame = timestamp;
    for (let left = elapsed; left > 0; left -= MAX_FRAME) {
      this.simulate(Math.min(MAX_FRAME, left));
    }
    this.refresh(elapsed);
  }

  run() {
    this.runner = undefined;
    this.pending = 0;
    this.errorLine = 0;
    this.consoleBox.replaceChildren();
    this.warned.clear();
    try {
      const program = compile(this.editor.value, this.game.features());
      this.game.startRun();
      this.runner = new Runner(program, {
        globals: this.game.globals((text) => {
          this.log('print', text);
        }),
        stepCost: () => STEP_COST / this.game.speed,
        lockedHint: (name) => this.game.lockedHint(name),
      });
      this.setStatus('running', 'Running');
    } catch (error) {
      this.fail(error);
    }
    this.save();
  }

  /** @param {unknown} error */
  fail(error) {
    this.runner = undefined;
    this.pending = 0;
    if (!(error instanceof ScriptError)) {
      throw error;
    }
    this.errorLine = error.line;
    this.setStatus('error', `Error on line ${error.line}`);
    this.log('error', `Line ${error.line}: ${error.message}`);
  }

  /** @param {string} id */
  buy(id) {
    const upgrade = UPGRADES.find((candidate) => candidate.id === id);
    if (upgrade === undefined || !this.game.buy(id)) {
      return;
    }
    const again = this.runner !== undefined ? ' Press Run again to use it in the script.' : '';
    this.log('info', `Bought ${upgrade.name}.${again}`);
    this.save();
    if (id === 'lighthouse') {
      byId('win-time', HTMLElement).textContent = clockText(this.game.wonAt ?? 0);
      this.winDialog.showModal();
    }
  }

  /** @param {number} timestamp */
  frame(timestamp) {
    const dt =
      this.lastFrame === undefined ? 0 : Math.min(MAX_FRAME, (timestamp - this.lastFrame) / 1000);
    this.lastFrame = timestamp;
    this.simulate(dt);
    this.view.draw(this.game, timestamp / 1000);
    this.refresh(dt);
    requestAnimationFrame((next) => {
      this.frame(next);
    });
  }

  /**
   * Runs the script and the sea for one frame. The sea never gets ahead of the
   * frame: a long action is paid off over the next frames through `pending`.
   *
   * @param {number} dt
   */
  simulate(dt) {
    const game = this.game;
    const target = game.time + dt;
    let steps = 0;
    while (target - game.time > 1e-9) {
      const room = target - game.time;
      if (this.pending > 0) {
        const part = Math.min(this.pending, room);
        game.advance(part);
        this.pending -= part;
        continue;
      }
      const runner = this.runner;
      if (runner === undefined || steps >= MAX_STEPS) {
        game.advance(room);
        continue;
      }
      steps += 1;
      try {
        this.pending = runner.step();
      } catch (error) {
        this.fail(error);
        continue;
      }
      if (runner.done) {
        this.runner = undefined;
        this.setStatus('idle', 'Finished');
        // A script without a loop is the first thing a new player runs.
        const looped = /\bwhile\b/.test(this.editor.value);
        const advice = looped ? '' : ' To repeat it, put the lines inside while (true) { ... }';
        this.log('info', `The script reached its end.${advice}`);
      }
    }
  }

  /** @param {number} dt */
  refresh(dt) {
    const game = this.game;
    this.editor.setMarks(this.runner?.line ?? 0, this.errorLine);
    this.show('cargo', `${game.cargoTotal()} / ${game.capacity}`);
    this.show('position', `${game.boat.x}, ${game.boat.y}`);
    this.show('clock', clockText(game.playTime));
    if (game.has('pots')) {
      this.show('pots', `${game.boat.pots} / ${game.potMax}`);
    }
    byId('cargo-fill', HTMLElement).style.width = `${(game.cargoTotal() / game.capacity) * 100}%`;

    if (game.version !== this.seenVersion) {
      this.seenVersion = game.version;
      this.renderStock();
      this.renderWorkshop();
      this.renderGuide();
      byId('pots-field', HTMLElement).hidden = !game.has('pots');
      byId('tip', HTMLElement).textContent = this.tip();
      this.editor.setWords(new Set(game.globals(() => {}).keys()));
    }

    this.sinceSave += dt;
    if (this.sinceSave >= SAVE_EVERY) {
      this.save();
    }
  }

  /**
   * @param {string} id
   * @param {string} text Written only when it changed, to keep the DOM quiet.
   */
  show(id, text) {
    if (this.shown[id] !== text) {
      this.shown[id] = text;
      byId(id, HTMLElement).textContent = text;
    }
  }

  save() {
    this.sinceSave = 0;
    this.unsaved = false;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.game.toSave(this.editor.value)));
    } catch {
      // Storage is blocked or full. The game still plays, it just will not resume.
    }
  }

  /**
   * @param {Status} status
   * @param {string} text
   */
  setStatus(status, text) {
    this.statusBox.dataset['status'] = status;
    this.statusBox.textContent = text;
  }

  /**
   * @param {'info' | 'hint' | 'error' | 'print' | 'done'} kind
   * @param {string} text
   */
  log(kind, text) {
    const line = document.createElement('div');
    line.className = `log log-${kind}`;
    line.textContent = kind === 'hint' ? `Hint: ${text}` : text;
    this.consoleBox.append(line);
    while (this.consoleBox.childElementCount > MAX_CONSOLE_LINES) {
      this.consoleBox.firstElementChild?.remove();
    }
    this.consoleBox.scrollTop = this.consoleBox.scrollHeight;
  }

  /** @returns {string} What the player should aim for next. */
  tip() {
    const game = this.game;
    if (game.wonAt !== undefined) {
      return 'The lighthouse is lit. The sea is yours.';
    }
    const fresh = KINDS.every((kind) => game.stock[kind] === 0);
    if (fresh && UPGRADES.every((upgrade) => !game.has(upgrade.id))) {
      return 'Press Run. The boat fishes one cell and comes back. To repeat that, put the lines inside while (true) { ... }';
    }
    /** @type {{ upgrade: Upgrade, cost: Cost, weight: number } | undefined} */
    let next;
    for (const upgrade of UPGRADES) {
      const cost = game.nextCost(upgrade.id);
      if (cost === undefined || (upgrade.requires !== undefined && !game.has(upgrade.requires))) {
        continue;
      }
      // A crab or a tuna takes more work than a sardine.
      const weight = (cost.sardine ?? 0) + (cost.crab ?? 0) * 4 + (cost.tuna ?? 0) * 10;
      if (next === undefined || weight < next.weight) {
        next = { upgrade, cost, weight };
      }
    }
    if (next === undefined) {
      return 'Everything is bought.';
    }
    const task = next.upgrade.task;
    if (task !== undefined && !game.tasks[task]) {
      return `Next goal: ${next.upgrade.name}. Task: ${TASK_TEXT[task]}`;
    }
    const ready = game.canBuy(next.upgrade.id) ? 'You can buy it now.' : '';
    return `Next goal: ${next.upgrade.name} for ${costText(next.cost)}. ${ready}`;
  }

  renderStock() {
    const game = this.game;
    const visible = KINDS.filter(
      (kind) =>
        kind === 'sardine' || game.stock[kind] > 0 || game.has(kind === 'crab' ? 'pots' : 'tuna')
    );
    this.stockBox.innerHTML = visible
      .map(
        (kind) =>
          `<span class="chip" title="${kind} in stock">${icon(kind)}<b>${Math.floor(game.stock[kind])}</b></span>`
      )
      .join('');
  }

  renderWorkshop() {
    const game = this.game;
    /** @type {string[]} */
    const parts = [];
    let group = '';
    for (const upgrade of UPGRADES) {
      if (upgrade.group !== group) {
        group = upgrade.group;
        parts.push(`<h3 class="group">${group}</h3>`);
      }
      parts.push(this.card(upgrade));
    }
    this.workshopBox.innerHTML = parts.join('');
    byId('workshop-count', HTMLElement).textContent = String(
      UPGRADES.filter((upgrade) => game.canBuy(upgrade.id)).length || ''
    );
  }

  /**
   * @param {Upgrade} upgrade
   * @returns {string} Markup of one Workshop card.
   */
  card(upgrade) {
    const game = this.game;
    const level = game.level(upgrade.id);
    const cost = game.nextCost(upgrade.id);
    const locked = upgrade.requires !== undefined && !game.has(upgrade.requires);
    const pips = upgrade.levels
      .map((_, index) => `<i class="pip${index < level ? ' on' : ''}"></i>`)
      .join('');
    let stat = '';
    if (upgrade.stat !== undefined) {
      const now = statOf(upgrade.id, level);
      const after = cost === undefined ? '' : ` → ${statOf(upgrade.id, level + 1)}`;
      stat = `<p class="stat">${upgrade.stat} ${now}${after}</p>`;
    }
    // A task waits for the script: dashed plum. Once done it settles into soft plum.
    let task = '';
    if (upgrade.task !== undefined && cost !== undefined && !locked) {
      const text = TASK_TEXT[upgrade.task];
      if (game.tasks[upgrade.task]) {
        task = `<p class="task done">${icon('check')}<span>Task done: ${text}</span></p>`;
      } else {
        const { value, goal } = game.taskProgress(upgrade.task);
        task = `<p class="task">${icon('clock')}<span>Task: ${text} <b>Best so far: ${value} of ${goal}.</b></span></p>`;
      }
    }
    let action = `<span class="owned">${icon('check')}Owned</span>`;
    if (cost !== undefined) {
      const price = KINDS.filter((kind) => cost[kind] !== undefined)
        .map((kind) => {
          const short = game.stock[kind] < (cost[kind] ?? 0) ? ' short' : '';
          return `<span class="price${short}">${icon(kind)}${cost[kind]}</span>`;
        })
        .join('');
      const requires = UPGRADES.find((candidate) => candidate.id === upgrade.requires);
      const button = locked
        ? `<span class="needs">${icon('lock')}Needs ${requires?.name ?? ''}</span>`
        : `<button class="button buy" data-buy="${upgrade.id}"${game.canBuy(upgrade.id) ? '' : ' disabled'}>Buy</button>`;
      action = `<span class="prices">${price}</span>${button}`;
    }
    // Owned is plum, locked is hatched, affordable is rose. The words say it too.
    const ready = game.canBuy(upgrade.id) ? ' ready' : '';
    const state = cost === undefined ? ' done' : locked ? ' locked' : ready;
    return `<article class="card${state}">
      <header><h4>${upgrade.name}</h4><span class="pips">${pips}</span></header>
      <p>${upgrade.desc}</p>${stat}${task}
      <footer>${action}</footer>
    </article>`;
  }

  renderGuide() {
    const game = this.game;
    this.guideBox.replaceChildren();
    for (const section of GUIDE) {
      if (section.requires !== undefined && !game.has(section.requires)) {
        continue;
      }
      const block = document.createElement('section');
      block.className = 'doc';
      const title = document.createElement('h3');
      title.className = 'group';
      title.textContent = section.title;
      block.append(title);
      if (section.intro !== undefined) {
        const intro = document.createElement('p');
        intro.textContent = section.intro;
        block.append(intro);
      }
      const list = document.createElement('dl');
      for (const entry of section.entries) {
        const term = document.createElement('dt');
        term.textContent = entry.code;
        const text = document.createElement('dd');
        text.textContent = entry.text;
        list.append(term, text);
      }
      block.append(list);
      if (section.example !== undefined) {
        const example = document.createElement('pre');
        example.textContent = section.example;
        block.append(example);
      }
      this.guideBox.append(block);
    }
  }
}

new App().start();
