// @ts-check
/** Game data: upgrades, the in-game guide and the first script. Balance lives here. */

/** @typedef {'sardine' | 'crab' | 'tuna'} Kind */
/** @typedef {Partial<Record<Kind, number>>} Cost */
/** @typedef {'streak' | 'fullTrip' | 'fastStart'} TaskKind */

/**
 * @typedef {object} Upgrade
 * @property {string} id
 * @property {string} group Heading in the Workshop.
 * @property {string} name
 * @property {string} desc
 * @property {string} [requires] Id of the upgrade that must be owned first.
 * @property {TaskKind} [task] Something the script must achieve before the upgrade is sold.
 * @property {string} [stat] Label of the number the upgrade changes.
 * @property {number} [base] Value of that number before the first level.
 * @property {ReadonlyArray<{ cost: Cost, value?: number }>} levels
 */

/**
 * @typedef {object} GuideSection
 * @property {string} title
 * @property {string} [requires] Upgrade id. The section is hidden until it is owned.
 * @property {string} [intro]
 * @property {ReadonlyArray<{ code: string, text: string }>} entries
 * @property {string} [example]
 */

/** @type {ReadonlyArray<Kind>} */
export const KINDS = ['sardine', 'crab', 'tuna'];

/** Targets of the tasks that guard the language upgrades. */
export const TASK_GOALS = { streak: 8, fullTrips: 5, fastCatch: 40, fastSeconds: 40 };

/** @type {Readonly<Record<TaskKind, string>>} */
export const TASK_TEXT = {
  streak:
    `Catch fish with ${TASK_GOALS.streak} casts in a row. ` +
    'An empty net breaks the row, so check scan() first.',
  fullTrip:
    `Unload a full cargo ${TASK_GOALS.fullTrips} times in a row. ` +
    'Compare cargo() with capacity().',
  fastStart:
    `Unload ${TASK_GOALS.fastCatch} sardines in the first ${TASK_GOALS.fastSeconds} seconds ` +
    'after you press Run.',
};

/** @type {ReadonlyArray<Upgrade>} */
export const UPGRADES = [
  {
    id: 'variables',
    group: 'Language',
    name: 'Variables',
    desc: 'Remember values with let. Change them with =, += and ++.',
    task: 'streak',
    levels: [{ cost: { sardine: 10 } }],
  },
  {
    id: 'functions',
    group: 'Language',
    name: 'Functions',
    desc: 'Give a piece of code a name with fn and call it anywhere.',
    requires: 'variables',
    task: 'fullTrip',
    levels: [{ cost: { sardine: 40 } }],
  },
  {
    id: 'lists',
    group: 'Language',
    name: 'Lists',
    desc: 'Lists, for loops and range().',
    requires: 'variables',
    task: 'fastStart',
    levels: [{ cost: { sardine: 70 } }],
  },
  {
    id: 'hold',
    group: 'Boat',
    name: 'Cargo hold',
    desc: 'Carry more fish before you must unload.',
    stat: 'Cargo',
    base: 6,
    levels: [
      { cost: { sardine: 15 }, value: 10 },
      { cost: { sardine: 50 }, value: 16 },
      { cost: { sardine: 120, crab: 15 }, value: 24 },
      { cost: { sardine: 300, crab: 60, tuna: 10 }, value: 40 },
    ],
  },
  {
    id: 'net',
    group: 'Boat',
    name: 'Net',
    desc: 'Catch more sardines with one cast().',
    stat: 'Fish per cast',
    base: 2,
    levels: [
      { cost: { sardine: 20 }, value: 3 },
      { cost: { sardine: 70 }, value: 4 },
      { cost: { sardine: 180, crab: 20 }, value: 6 },
    ],
  },
  {
    id: 'engine',
    group: 'Boat',
    name: 'Engine',
    desc: 'The boat sails, fishes and thinks faster.',
    requires: 'variables',
    stat: 'Speed',
    base: 1,
    levels: [
      { cost: { sardine: 25 }, value: 1.4 },
      { cost: { sardine: 80 }, value: 2 },
      { cost: { sardine: 200, crab: 30 }, value: 2.8 },
      { cost: { sardine: 400, crab: 80, tuna: 20 }, value: 4 },
    ],
  },
  {
    id: 'sea',
    group: 'Boat',
    name: 'Bigger sea',
    desc: 'The map grows: more cells and more shoals.',
    requires: 'variables',
    stat: 'Sea size',
    base: 3,
    levels: [
      { cost: { sardine: 30 }, value: 4 },
      { cost: { sardine: 100 }, value: 5 },
      { cost: { sardine: 250, crab: 40 }, value: 6 },
      { cost: { sardine: 500, crab: 120, tuna: 25 }, value: 8 },
    ],
  },
  {
    id: 'sonar',
    group: 'Gear',
    name: 'Sonar',
    desc: 'sonar() lists every shoal in the sea.',
    requires: 'lists',
    levels: [{ cost: { sardine: 100 } }],
  },
  {
    id: 'pots',
    group: 'Gear',
    name: 'Crab pots',
    desc: 'Reefs appear. Drop pots on them and haul crabs.',
    requires: 'functions',
    stat: 'Pots',
    base: 0,
    levels: [
      { cost: { sardine: 120 }, value: 2 },
      { cost: { sardine: 200, crab: 30 }, value: 4 },
      { cost: { sardine: 300, crab: 100, tuna: 15 }, value: 6 },
    ],
  },
  {
    id: 'tuna',
    group: 'Gear',
    name: 'Tuna line',
    desc: 'Tuna shoals cross the sea. They only bite on crab bait.',
    requires: 'pots',
    levels: [{ cost: { sardine: 250, crab: 40 } }],
  },
  {
    id: 'lighthouse',
    group: 'Goal',
    name: 'Lighthouse',
    desc: 'Build the lighthouse at the dock to finish the game.',
    levels: [{ cost: { sardine: 600, crab: 200, tuna: 60 } }],
  },
];

/**
 * @param {string} id
 * @returns {Upgrade}
 */
export function upgradeById(id) {
  const upgrade = UPGRADES.find((candidate) => candidate.id === id);
  if (upgrade === undefined) {
    throw new Error(`Unknown upgrade "${id}"`);
  }
  return upgrade;
}

/**
 * @param {string} id
 * @param {number} level Levels bought so far.
 * @returns {number} The number an upgrade gives at that level.
 */
export function statOf(id, level) {
  const upgrade = upgradeById(id);
  const value = level === 0 ? upgrade.base : upgrade.levels[level - 1]?.value;
  if (value === undefined) {
    throw new Error(`Upgrade "${id}" has no value at level ${level}`);
  }
  return value;
}

/**
 * @param {Cost} cost
 * @returns {string} For example "120 sardines, 15 crabs".
 */
export function costText(cost) {
  return KINDS.filter((kind) => cost[kind] !== undefined)
    .map((kind) => `${cost[kind]} ${kind === 'tuna' ? kind : `${kind}s`}`)
    .join(', ');
}

export const STARTER_SCRIPT = `// Press Run, or Ctrl+Enter.
// A run starts at the dock: x 0, y 0.
// Fish count after unload() there.

move(east)
cast()
move(west)
unload()
`;

/** @type {ReadonlyArray<GuideSection>} */
export const GUIDE = [
  {
    title: 'The boat',
    intro:
      'Sardine shoals appear in random cells. A shoal grows up to 8 fish and swims away after ' +
      'about half a minute. An empty net wastes time, so look before you cast.',
    entries: [
      {
        code: 'move(dir)',
        text: 'Sail one cell: north, east, south or west. Returns false at the edge.',
      },
      {
        code: 'cast()',
        text: 'Throw the net. Returns how many fish you caught. Takes 1 second, or 2 when the net comes back empty.',
      },
      {
        code: 'unload()',
        text: 'At the dock, move the cargo to your stock. Stock pays for upgrades.',
      },
      { code: 'scan()', text: 'What swims under the boat: sardine, tuna or null.' },
      { code: 'shoalSize()', text: 'How many sardines are under the boat.' },
      { code: 'cargo()  capacity()', text: 'Fish on board, and how many fit.' },
      { code: 'posX()  posY()  seaSize()', text: 'Where the boat is and how wide the sea is.' },
      { code: 'terrain()', text: 'The cell under the boat: "dock", "water" or "reef".' },
      { code: 'now()  wait(seconds)', text: 'The game clock in seconds, and a pause.' },
      { code: 'print(value)', text: 'Write a line to the console.' },
    ],
  },
  {
    title: 'Flow',
    entries: [
      {
        code: 'while (test) { ... }',
        text: 'Repeat while the test is true. break leaves the loop.',
      },
      { code: 'if (test) { ... } else { ... }', text: 'Choose what to do.' },
      { code: '==  !=  <  <=  >  >=', text: 'Compare two values.' },
      { code: '&&  ||  !', text: 'And, or, not.' },
      { code: '+  -  *  /  %', text: 'Math. Also abs(), min(), max(), floor() and random().' },
    ],
    example: `while (cargo() < capacity()) {
  if (scan() == sardine) {
    cast()
  } else {
    move(east)
  }
}`,
  },
  {
    title: 'Variables',
    requires: 'variables',
    entries: [
      { code: 'let n = 0', text: 'Create a variable.' },
      { code: 'n = n + 1   n += 1   n++', text: 'Change it.' },
    ],
    example: `let steps = 0
while (move(east)) {
  steps++
}
print("the sea is " + steps + " cells wide")`,
  },
  {
    title: 'Functions',
    requires: 'functions',
    entries: [
      { code: 'fn name(a, b) { ... }', text: 'Declare a function. Call it with name(1, 2).' },
      { code: 'return value', text: 'Leave the function and give a value back.' },
    ],
    example: `fn goHome() {
  while (posX() > 0) { move(west) }
  while (posY() > 0) { move(south) }
  unload()
}`,
  },
  {
    title: 'Lists',
    requires: 'lists',
    entries: [
      { code: '[1, 2, 3]', text: 'A list. Read an item with list[0], change it with list[0] = 5.' },
      { code: 'len(list)  list.length', text: 'How many items it has.' },
      { code: 'push(list, value)  pop(list)', text: 'Add to the end, or take the last item.' },
      { code: 'range(n)  range(a, b)', text: 'The numbers 0 to n - 1, or a to b - 1.' },
      { code: 'for (item of list) { ... }', text: 'Run the block once for every item.' },
    ],
    example: `for (i of range(seaSize() - 1)) {
  move(north)
}`,
  },
  {
    title: 'Sonar',
    requires: 'sonar',
    entries: [
      { code: 'sonar()', text: 'A list with one record for every shoal in the sea.' },
      {
        code: '.x  .y  .kind  .size',
        text: 'Fields of a record. Tuna also have .dir, where they swim.',
      },
    ],
    example: `for (shoal of sonar()) {
  print(shoal.kind + " at " + shoal.x + ", " + shoal.y)
}`,
  },
  {
    title: 'Crab pots',
    requires: 'pots',
    intro:
      'Reefs are the pale pink cells with rocks. A pot on a reef catches one crab every 4 seconds, ' +
      'up to 5. No sardine shoals live on a reef.',
    entries: [
      {
        code: 'dropPot()',
        text: 'Put a pot on the reef under the boat. Uses 1 sardine from the cargo as bait.',
      },
      { code: 'haulPot()', text: 'Take the pot back with its crabs. Returns the number of crabs.' },
      {
        code: 'potsLeft()  potCrabs()',
        text: 'Pots on board, and crabs in the pot under the boat.',
      },
      { code: 'cargoOf(kind)  stock(kind)', text: 'One kind of catch on board, or in your stock.' },
    ],
  },
  {
    title: 'Tuna',
    requires: 'tuna',
    intro:
      'A tuna shoal swims one cell every 2 seconds in a straight line and turns back at the edge. ' +
      'After a catch, a new shoal arrives somewhere else.',
    entries: [
      { code: 'cast()', text: 'On a tuna cell it uses 1 crab as bait and catches 3 tuna.' },
      { code: 'shoal.dir', text: 'In a sonar() record: north, east, south or west.' },
    ],
  },
];
