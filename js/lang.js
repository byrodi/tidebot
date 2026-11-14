// @ts-check
/**
 * The boat's script language: a tokenizer, a parser and an interpreter that
 * pauses after every step, so the game decides how fast a script runs.
 */

/** Upgrade names shown when a script uses a locked language feature. */
const FEATURE_TITLES = { variables: 'Variables', functions: 'Functions', lists: 'Lists' };

const KEYWORDS = new Set([
  'let',
  'if',
  'else',
  'while',
  'for',
  'of',
  'fn',
  'function',
  'return',
  'break',
  'continue',
  'true',
  'false',
  'null',
]);
const TWO_CHAR_OPS = new Set([
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '++',
  '--',
]);
const ONE_CHAR_OPS = '+-*/%<>=!(){}[],;.';
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=']);
/** @type {Readonly<Record<string, number>>} */
const PRECEDENCE = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};
const MAX_CALL_DEPTH = 100;
const NUMBER_PATTERN = /\d+(?:\.\d+)?/y;
const WORD_PATTERN = /[A-Za-z_]\w*/y;

/** @typedef {keyof typeof FEATURE_TITLES} Feature */
/** @typedef {number | string | boolean | null | Fn | ValueList | ValueRecord} Value */
/** @typedef {Value[]} ValueList */
/** @typedef {{ [key: string]: Value }} ValueRecord */

/**
 * @typedef {object} Token
 * @property {'num' | 'str' | 'name' | 'kw' | 'op' | 'eof'} kind
 * @property {string} text
 * @property {number} line
 * @property {boolean} newline True when the token is the first one on its line.
 */

/**
 * @typedef {(
 *   | { kind: 'literal', line: number, value: number | string | boolean | null }
 *   | { kind: 'name', line: number, name: string }
 *   | { kind: 'list', line: number, items: Expr[] }
 *   | { kind: 'unary', line: number, op: string, arg: Expr }
 *   | { kind: 'binary', line: number, op: string, left: Expr, right: Expr }
 *   | { kind: 'index', line: number, target: Expr, index: Expr }
 *   | { kind: 'member', line: number, target: Expr, name: string }
 *   | { kind: 'call', line: number, callee: Expr, args: Expr[] }
 * )} Expr
 */

/**
 * @typedef {(
 *   | { kind: 'expr', line: number, expr: Expr }
 *   | { kind: 'let', line: number, name: string, value: Expr }
 *   | { kind: 'assign', line: number, target: Expr, op: string, value: Expr }
 *   | { kind: 'if', line: number, test: Expr, then: Stmt[], otherwise: Stmt[] | undefined }
 *   | { kind: 'while', line: number, test: Expr, body: Stmt[] }
 *   | { kind: 'for', line: number, name: string, iter: Expr, body: Stmt[] }
 *   | { kind: 'fn', line: number, name: string, params: string[], body: Stmt[] }
 *   | { kind: 'return', line: number, value: Expr | undefined }
 *   | { kind: 'break', line: number }
 *   | { kind: 'continue', line: number }
 * )} Stmt
 */

/** @typedef {{ kind: 'break' } | { kind: 'continue' } | { kind: 'return', value: Value }} Signal */

/**
 * What the interpreter needs from the game.
 *
 * @typedef {object} Host
 * @property {Map<string, Value>} globals Built-in functions and constants.
 * @property {() => number} stepCost Seconds one statement takes.
 * @property {(name: string) => string | undefined} lockedHint Extra help for an unknown name.
 */

/** A mistake in the player's script. `line` is 1-based, 0 when unknown. */
export class ScriptError extends Error {
  /**
   * @param {string} message
   * @param {number} [line]
   */
  constructor(message, line = 0) {
    super(message);
    this.name = 'ScriptError';
    /** @type {number} */
    this.line = line;
  }
}

/** Returned by a built-in that takes game time: the script pauses, then gets `value`. */
export class Wait {
  /**
   * @param {number} seconds
   * @param {Value} value
   */
  constructor(seconds, value) {
    this.seconds = seconds;
    this.value = value;
  }
}

/** Base of everything a script can call. */
export class Fn {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
  }
}

/** A function the game provides. */
export class Builtin extends Fn {
  /**
   * @param {string} name
   * @param {number} min Fewest arguments.
   * @param {number} max Most arguments.
   * @param {(args: Value[]) => Value | Wait} run
   */
  constructor(name, min, max, run) {
    super(name);
    this.min = min;
    this.max = max;
    this.run = run;
  }
}

class UserFn extends Fn {
  /**
   * @param {string} name
   * @param {string[]} params
   * @param {Stmt[]} body
   * @param {Scope} scope Scope the function was declared in.
   */
  constructor(name, params, body, scope) {
    super(name);
    this.params = params;
    this.body = body;
    this.scope = scope;
  }
}

class Scope {
  /**
   * @param {Scope | undefined} parent
   * @param {Map<string, Value>} [vars]
   */
  constructor(parent, vars = new Map()) {
    this.parent = parent;
    this.vars = vars;
  }

  /**
   * @param {string} name
   * @returns {Scope | undefined} The scope that holds the name.
   */
  find(name) {
    /** @type {Scope | undefined} */
    let scope = this;
    while (scope !== undefined) {
      if (scope.vars.has(name)) {
        return scope;
      }
      scope = scope.parent;
    }
    return undefined;
  }
}

/** @type {Signal} */
const BREAK = { kind: 'break' };
/** @type {Signal} */
const CONTINUE = { kind: 'continue' };

/**
 * @param {string} source
 * @returns {Token[]}
 */
function tokenize(source) {
  /** @type {Token[]} */
  const tokens = [];
  let pos = 0;
  let line = 1;
  let newline = true;

  /**
   * @param {Token['kind']} kind
   * @param {string} text
   */
  const push = (kind, text) => {
    tokens.push({ kind, text, line, newline });
    newline = false;
  };

  while (pos < source.length) {
    const ch = source.charAt(pos);
    if (ch === '\n') {
      line += 1;
      newline = true;
      pos += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      pos += 1;
      continue;
    }
    if (source.startsWith('//', pos)) {
      const end = source.indexOf('\n', pos);
      pos = end === -1 ? source.length : end;
      continue;
    }

    NUMBER_PATTERN.lastIndex = pos;
    const number = NUMBER_PATTERN.exec(source);
    if (number !== null) {
      push('num', number[0]);
      pos += number[0].length;
      continue;
    }

    WORD_PATTERN.lastIndex = pos;
    const word = WORD_PATTERN.exec(source);
    if (word !== null) {
      push(KEYWORDS.has(word[0]) ? 'kw' : 'name', word[0]);
      pos += word[0].length;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let text = '';
      let end = pos + 1;
      for (;;) {
        const next = source.charAt(end);
        if (next === '' || next === '\n') {
          throw new ScriptError('This text is missing its closing quote', line);
        }
        if (next === ch) {
          break;
        }
        if (next === '\\') {
          const escaped = source.charAt(end + 1);
          text += escaped === 'n' ? '\n' : escaped;
          end += 2;
          continue;
        }
        text += next;
        end += 1;
      }
      push('str', text);
      pos = end + 1;
      continue;
    }

    const two = source.slice(pos, pos + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push('op', two);
      pos += 2;
    } else if (ONE_CHAR_OPS.includes(ch)) {
      push('op', ch);
      pos += 1;
    } else {
      throw new ScriptError(`Unexpected character "${ch}"`, line);
    }
  }
  tokens.push({ kind: 'eof', text: '', line, newline: true });
  return tokens;
}

/**
 * @param {Token} token
 * @returns {string}
 */
function describeToken(token) {
  return token.kind === 'eof' ? 'the end of the script' : `"${token.text}"`;
}

class Parser {
  /**
   * @param {Token[]} tokens
   * @param {ReadonlySet<string> | undefined} features Unlocked features, undefined for all.
   */
  constructor(tokens, features) {
    this.tokens = tokens;
    this.features = features;
    this.pos = 0;
    this.fnDepth = 0;
    this.loopDepth = 0;
  }

  /** @returns {Stmt[]} */
  program() {
    /** @type {Stmt[]} */
    const body = [];
    for (;;) {
      this.skipSemicolons();
      const token = this.peek();
      if (token.kind === 'eof') {
        return body;
      }
      if (this.at('}')) {
        throw new ScriptError('This } has no matching {', token.line);
      }
      body.push(this.statement());
    }
  }

  /** @returns {Token} */
  peek() {
    const token = this.tokens[this.pos];
    if (token === undefined) {
      throw new Error('Parser moved past the end of the script');
    }
    return token;
  }

  /** @returns {Token} */
  next() {
    const token = this.peek();
    if (token.kind !== 'eof') {
      this.pos += 1;
    }
    return token;
  }

  /**
   * @param {string} text An operator or a keyword.
   * @returns {boolean}
   */
  at(text) {
    const token = this.peek();
    return (token.kind === 'op' || token.kind === 'kw') && token.text === text;
  }

  /**
   * @param {string} text
   * @returns {boolean}
   */
  eat(text) {
    if (this.at(text)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  /** @param {string} text */
  expect(text) {
    if (!this.eat(text)) {
      const token = this.peek();
      throw new ScriptError(`Expected "${text}" but found ${describeToken(token)}`, token.line);
    }
  }

  skipSemicolons() {
    while (this.eat(';')) {
      // A stray ";" is harmless.
    }
  }

  /**
   * @param {Feature} feature
   * @param {string} what Start of the error message.
   * @param {number} line
   */
  need(feature, what, line) {
    if (this.features !== undefined && !this.features.has(feature)) {
      const title = FEATURE_TITLES[feature];
      throw new ScriptError(`${what} locked. Buy "${title}" in the Workshop first`, line);
    }
  }

  /** @returns {Stmt[]} */
  block() {
    const open = this.peek();
    this.expect('{');
    /** @type {Stmt[]} */
    const body = [];
    for (;;) {
      this.skipSemicolons();
      if (this.eat('}')) {
        return body;
      }
      if (this.peek().kind === 'eof') {
        throw new ScriptError('This { is never closed with }', open.line);
      }
      body.push(this.statement());
    }
  }

  /** @returns {Stmt} */
  statement() {
    const token = this.peek();
    if (token.kind === 'kw') {
      switch (token.text) {
        case 'let':
          return this.letStatement();
        case 'if':
          return this.ifStatement();
        case 'while':
          return this.whileStatement();
        case 'for':
          return this.forStatement();
        case 'fn':
        case 'function':
          return this.fnStatement();
        case 'return':
          return this.returnStatement();
        case 'break':
        case 'continue':
          this.next();
          if (this.loopDepth === 0) {
            throw new ScriptError(`"${token.text}" only works inside a loop`, token.line);
          }
          this.eat(';');
          return token.text === 'break'
            ? { kind: 'break', line: token.line }
            : { kind: 'continue', line: token.line };
        case 'else':
          throw new ScriptError('"else" must come right after the } of an if', token.line);
        default:
          break;
      }
    }
    return this.simpleStatement();
  }

  /** @returns {Stmt} */
  letStatement() {
    const line = this.next().line;
    this.need('variables', 'Variables are', line);
    const name = this.next();
    if (name.kind !== 'name') {
      throw new ScriptError(`${describeToken(name)} cannot be a variable name`, name.line);
    }
    if (!this.eat('=')) {
      throw new ScriptError(`A new variable needs a value: let ${name.text} = 0`, name.line);
    }
    const value = this.expression();
    this.eat(';');
    return { kind: 'let', line, name: name.text, value };
  }

  /** @returns {Stmt} */
  ifStatement() {
    const line = this.next().line;
    const test = this.expression();
    const then = this.block();
    /** @type {Stmt[] | undefined} */
    let otherwise;
    if (this.eat('else')) {
      otherwise = this.at('if') ? [this.ifStatement()] : this.block();
    }
    return { kind: 'if', line, test, then, otherwise };
  }

  /** @returns {Stmt} */
  whileStatement() {
    const line = this.next().line;
    const test = this.expression();
    this.loopDepth += 1;
    const body = this.block();
    this.loopDepth -= 1;
    return { kind: 'while', line, test, body };
  }

  /** @returns {Stmt} */
  forStatement() {
    const line = this.next().line;
    this.need('lists', '"for" loops are', line);
    const paren = this.eat('(');
    this.eat('let');
    const name = this.next();
    if (name.kind !== 'name' || !this.eat('of')) {
      throw new ScriptError('Write a for loop like this: for (i of range(10)) { ... }', line);
    }
    const iter = this.expression();
    if (paren) {
      this.expect(')');
    }
    this.loopDepth += 1;
    const body = this.block();
    this.loopDepth -= 1;
    return { kind: 'for', line, name: name.text, iter, body };
  }

  /** @returns {Stmt} */
  fnStatement() {
    const line = this.next().line;
    this.need('functions', 'Functions are', line);
    const name = this.next();
    if (name.kind !== 'name') {
      throw new ScriptError('A function needs a name: fn goHome() { ... }', line);
    }
    this.expect('(');
    /** @type {string[]} */
    const params = [];
    if (!this.at(')')) {
      do {
        const param = this.next();
        if (param.kind !== 'name') {
          throw new ScriptError(`${describeToken(param)} cannot be a parameter name`, param.line);
        }
        params.push(param.text);
      } while (this.eat(','));
    }
    this.expect(')');
    const outerLoops = this.loopDepth;
    this.loopDepth = 0;
    this.fnDepth += 1;
    const body = this.block();
    this.fnDepth -= 1;
    this.loopDepth = outerLoops;
    return { kind: 'fn', line, name: name.text, params, body };
  }

  /** @returns {Stmt} */
  returnStatement() {
    const line = this.next().line;
    if (this.fnDepth === 0) {
      throw new ScriptError('"return" only works inside a function', line);
    }
    const token = this.peek();
    const bare = token.newline || token.kind === 'eof' || this.at('}') || this.at(';');
    const value = bare ? undefined : this.expression();
    this.eat(';');
    return { kind: 'return', line, value };
  }

  /** @returns {Stmt} */
  simpleStatement() {
    const line = this.peek().line;
    const expr = this.expression();
    const op = this.peek();
    /** @type {Stmt} */
    let stmt;
    if (op.kind === 'op' && (ASSIGN_OPS.has(op.text) || op.text === '++' || op.text === '--')) {
      this.need('variables', 'Variables are', op.line);
      if (expr.kind !== 'name' && expr.kind !== 'index') {
        throw new ScriptError('Only a variable or a list item can be changed', op.line);
      }
      this.next();
      if (op.text === '++' || op.text === '--') {
        const one = /** @type {Expr} */ ({ kind: 'literal', line, value: 1 });
        stmt = {
          kind: 'assign',
          line,
          target: expr,
          op: op.text === '++' ? '+=' : '-=',
          value: one,
        };
      } else {
        stmt = { kind: 'assign', line, target: expr, op: op.text, value: this.expression() };
      }
    } else if (expr.kind === 'name') {
      throw new ScriptError(
        `"${expr.name}" alone does nothing. To call it, write ${expr.name}()`,
        line
      );
    } else {
      stmt = { kind: 'expr', line, expr };
    }
    this.eat(';');
    return stmt;
  }

  /** @returns {Expr} */
  expression() {
    return this.binary(1);
  }

  /**
   * @param {number} minPrecedence
   * @returns {Expr}
   */
  binary(minPrecedence) {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      const precedence = token.kind === 'op' ? PRECEDENCE[token.text] : undefined;
      if (precedence === undefined || precedence < minPrecedence) {
        return left;
      }
      this.next();
      const right = this.binary(precedence + 1);
      left = { kind: 'binary', line: token.line, op: token.text, left, right };
    }
  }

  /** @returns {Expr} */
  unary() {
    const token = this.peek();
    if (token.kind === 'op' && (token.text === '!' || token.text === '-')) {
      this.next();
      return { kind: 'unary', line: token.line, op: token.text, arg: this.unary() };
    }
    return this.postfix();
  }

  /** @returns {Expr} */
  postfix() {
    let expr = this.primary();
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op') {
        return expr;
      }
      // "(" or "[" at the start of a line begins a new statement, not a call.
      if (token.text === '(' && !token.newline) {
        this.next();
        /** @type {Expr[]} */
        const args = [];
        if (!this.at(')')) {
          do {
            args.push(this.expression());
          } while (this.eat(','));
        }
        this.expect(')');
        expr = { kind: 'call', line: token.line, callee: expr, args };
      } else if (token.text === '[' && !token.newline) {
        this.need('lists', 'Lists are', token.line);
        this.next();
        const index = this.expression();
        this.expect(']');
        expr = { kind: 'index', line: token.line, target: expr, index };
      } else if (token.text === '.') {
        this.next();
        const name = this.next();
        if (name.kind !== 'name') {
          throw new ScriptError(
            `Expected a name after "." but found ${describeToken(name)}`,
            name.line
          );
        }
        expr = { kind: 'member', line: token.line, target: expr, name: name.text };
      } else {
        return expr;
      }
    }
  }

  /** @returns {Expr} */
  primary() {
    const token = this.next();
    const line = token.line;
    if (token.kind === 'num') {
      return { kind: 'literal', line, value: Number(token.text) };
    }
    if (token.kind === 'str') {
      return { kind: 'literal', line, value: token.text };
    }
    if (token.kind === 'name') {
      return { kind: 'name', line, name: token.text };
    }
    if (token.kind === 'kw') {
      if (token.text === 'true' || token.text === 'false') {
        return { kind: 'literal', line, value: token.text === 'true' };
      }
      if (token.text === 'null') {
        return { kind: 'literal', line, value: null };
      }
    }
    if (token.kind === 'op' && token.text === '(') {
      const inner = this.expression();
      this.expect(')');
      return inner;
    }
    if (token.kind === 'op' && token.text === '[') {
      this.need('lists', 'Lists are', line);
      /** @type {Expr[]} */
      const items = [];
      if (!this.at(']')) {
        do {
          items.push(this.expression());
        } while (this.eat(','));
      }
      this.expect(']');
      return { kind: 'list', line, items };
    }
    throw new ScriptError(`Unexpected ${describeToken(token)}`, line);
  }
}

/**
 * Parses a script.
 *
 * @param {string} source
 * @param {ReadonlySet<string>} [features] Unlocked language features. Leave out to allow all.
 * @returns {Stmt[]}
 * @throws {ScriptError} On a syntax error or a locked feature.
 */
export function compile(source, features) {
  return new Parser(tokenize(source), features).program();
}

/**
 * @param {Value} value
 * @returns {boolean}
 */
function truthy(value) {
  return value !== false && value !== null && value !== 0 && value !== '';
}

/**
 * @param {Value} value
 * @returns {value is ValueRecord}
 */
function isRecord(value) {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Fn)
  );
}

/**
 * @param {Value} value
 * @returns {string} The type as it reads in an error message.
 */
function typeName(value) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    return 'a number';
  }
  if (typeof value === 'string') {
    return 'text';
  }
  if (typeof value === 'boolean') {
    return 'true/false';
  }
  if (Array.isArray(value)) {
    return 'a list';
  }
  return value instanceof Fn ? 'a function' : 'a record';
}

/**
 * @param {Value} value
 * @param {boolean} [nested] Inside a list or record, text gets quotes.
 * @returns {string} The value as print() shows it.
 */
export function formatValue(value, nested = false) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    return String(Math.round(value * 1000) / 1000);
  }
  if (typeof value === 'string') {
    return nested ? JSON.stringify(value) : value;
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatValue(item, true)).join(', ')}]`;
  }
  if (value instanceof Fn) {
    return `<function ${value.name}>`;
  }
  const fields = Object.entries(value).map(([key, field]) => `${key}: ${formatValue(field, true)}`);
  return `{${fields.join(', ')}}`;
}

/**
 * @param {Value} left
 * @param {Value} right
 * @returns {boolean}
 */
function sameValue(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, i) => sameValue(item, right[i] ?? null))
    );
  }
  return left === right;
}

/**
 * @param {string} op
 * @param {Value} left
 * @param {Value} right
 * @param {number} line
 * @returns {Value}
 */
function applyBinary(op, left, right, line) {
  if (op === '==') {
    return sameValue(left, right);
  }
  if (op === '!=') {
    return !sameValue(left, right);
  }
  if (typeof left === 'number' && typeof right === 'number') {
    switch (op) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
      case '%':
        if (right === 0) {
          throw new ScriptError('Cannot divide by zero', line);
        }
        return op === '/' ? left / right : left % right;
      case '<':
        return left < right;
      case '<=':
        return left <= right;
      case '>':
        return left > right;
      case '>=':
        return left >= right;
      default:
        break;
    }
  }
  if (op === '+' && (typeof left === 'string' || typeof right === 'string')) {
    return formatValue(left) + formatValue(right);
  }
  throw new ScriptError(`Cannot use "${op}" with ${typeName(left)} and ${typeName(right)}`, line);
}

/**
 * @param {Value} list
 * @param {Value} index
 * @param {number} line
 * @returns {{ list: ValueList, slot: number }} A checked position in a list.
 */
function checkedSlot(list, index, line) {
  if (!Array.isArray(list)) {
    throw new ScriptError(`[ ] needs a list, got ${typeName(list)}`, line);
  }
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    throw new ScriptError(
      `A list position must be a whole number, got ${formatValue(index)}`,
      line
    );
  }
  if (index < 0 || index >= list.length) {
    const range = list.length === 0 ? 'the list is empty' : `the list has 0 to ${list.length - 1}`;
    throw new ScriptError(`There is no item ${index}: ${range}`, line);
  }
  return { list, slot: index };
}

/**
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @param {number} got
 * @returns {string}
 */
function arityMessage(name, min, max, got) {
  const want = min === max ? String(min) : `${min} to ${max}`;
  return `${name}() takes ${want} value${want === '1' ? '' : 's'}, got ${got}`;
}

/** Runs one compiled script step by step. */
export class Runner {
  /**
   * @param {Stmt[]} program
   * @param {Host} host
   */
  constructor(program, host) {
    this.host = host;
    /** Line of the statement that ran last, for the editor highlight. */
    this.line = 0;
    this.done = false;
    this.depth = 0;
    this.builtins = new Scope(undefined, host.globals);
    this.generator = this.block(program, new Scope(this.builtins));
  }

  /**
   * Runs the script up to its next pause.
   *
   * @returns {number} Seconds of game time the step took. 0 when the script has ended.
   * @throws {ScriptError} When the script fails. The runner is done after that.
   */
  step() {
    if (this.done) {
      return 0;
    }
    try {
      const result = this.generator.next();
      if (result.done === true) {
        this.done = true;
        return 0;
      }
      return result.value;
    } catch (error) {
      this.done = true;
      if (error instanceof ScriptError && error.line === 0) {
        error.line = this.line;
      }
      throw error;
    }
  }

  /**
   * @param {Stmt[]} body
   * @param {Scope} scope
   * @returns {Generator<number, Signal | undefined, void>}
   */
  *block(body, scope) {
    // Functions exist from the top of their block, so order does not matter.
    for (const stmt of body) {
      if (stmt.kind === 'fn') {
        scope.vars.set(stmt.name, new UserFn(stmt.name, stmt.params, stmt.body, scope));
      }
    }
    for (const stmt of body) {
      const signal = yield* this.statement(stmt, scope);
      if (signal !== undefined) {
        return signal;
      }
    }
    return undefined;
  }

  /**
   * @param {Stmt} stmt
   * @param {Scope} scope
   * @returns {Generator<number, Signal | undefined, void>}
   */
  *statement(stmt, scope) {
    if (stmt.kind === 'fn') {
      return undefined;
    }
    this.line = stmt.line;
    yield this.host.stepCost();
    switch (stmt.kind) {
      case 'expr':
        yield* this.evaluate(stmt.expr, scope);
        return undefined;
      case 'let': {
        const value = yield* this.evaluate(stmt.value, scope);
        if (scope.vars.has(stmt.name)) {
          const hint = `To change it, write ${stmt.name} = ... without let`;
          throw new ScriptError(`"${stmt.name}" already exists. ${hint}`, stmt.line);
        }
        scope.vars.set(stmt.name, value);
        return undefined;
      }
      case 'assign':
        yield* this.assign(stmt, scope);
        return undefined;
      case 'if': {
        const test = yield* this.evaluate(stmt.test, scope);
        if (truthy(test)) {
          return yield* this.block(stmt.then, new Scope(scope));
        }
        if (stmt.otherwise !== undefined) {
          return yield* this.block(stmt.otherwise, new Scope(scope));
        }
        return undefined;
      }
      case 'while': {
        while (truthy(yield* this.evaluate(stmt.test, scope))) {
          const signal = yield* this.block(stmt.body, new Scope(scope));
          if (signal?.kind === 'break') {
            break;
          }
          if (signal?.kind === 'return') {
            return signal;
          }
          this.line = stmt.line;
          yield this.host.stepCost();
        }
        return undefined;
      }
      case 'for': {
        const list = yield* this.evaluate(stmt.iter, scope);
        if (!Array.isArray(list)) {
          throw new ScriptError(`"for" needs a list, got ${typeName(list)}`, stmt.line);
        }
        // The length is read every turn, so a loop may grow its own list.
        for (let i = 0; i < list.length; i += 1) {
          const inner = new Scope(scope);
          inner.vars.set(stmt.name, list[i] ?? null);
          const signal = yield* this.block(stmt.body, inner);
          if (signal?.kind === 'break') {
            break;
          }
          if (signal?.kind === 'return') {
            return signal;
          }
          this.line = stmt.line;
          yield this.host.stepCost();
        }
        return undefined;
      }
      case 'return': {
        const value = stmt.value === undefined ? null : yield* this.evaluate(stmt.value, scope);
        return { kind: 'return', value };
      }
      case 'break':
        return BREAK;
      case 'continue':
        return CONTINUE;
      default:
        return unreachable(stmt);
    }
  }

  /**
   * @param {Extract<Stmt, { kind: 'assign' }>} stmt
   * @param {Scope} scope
   * @returns {Generator<number, void, void>}
   */
  *assign(stmt, scope) {
    const target = stmt.target;
    const arithmetic = stmt.op.charAt(0);
    if (target.kind === 'name') {
      const owner = scope.find(target.name);
      if (owner === undefined) {
        const hint = `Create it first: let ${target.name} = ...`;
        throw new ScriptError(`Unknown variable "${target.name}". ${hint}`, stmt.line);
      }
      if (owner === this.builtins) {
        throw new ScriptError(`"${target.name}" is built in and cannot be changed`, stmt.line);
      }
      let value = yield* this.evaluate(stmt.value, scope);
      if (stmt.op !== '=') {
        value = applyBinary(arithmetic, owner.vars.get(target.name) ?? null, value, stmt.line);
      }
      owner.vars.set(target.name, value);
    } else if (target.kind === 'index') {
      const container = yield* this.evaluate(target.target, scope);
      const index = yield* this.evaluate(target.index, scope);
      let value = yield* this.evaluate(stmt.value, scope);
      const { list, slot } = checkedSlot(container, index, stmt.line);
      if (stmt.op !== '=') {
        value = applyBinary(arithmetic, list[slot] ?? null, value, stmt.line);
      }
      list[slot] = value;
    }
  }

  /**
   * @param {Expr} expr
   * @param {Scope} scope
   * @returns {Generator<number, Value, void>}
   */
  *evaluate(expr, scope) {
    switch (expr.kind) {
      case 'literal':
        return expr.value;
      case 'name': {
        const owner = scope.find(expr.name);
        if (owner === undefined) {
          const hint = this.host.lockedHint(expr.name) ?? '';
          throw new ScriptError(`Unknown name "${expr.name}".${hint}`, expr.line);
        }
        return owner.vars.get(expr.name) ?? null;
      }
      case 'list': {
        /** @type {ValueList} */
        const items = [];
        for (const item of expr.items) {
          items.push(yield* this.evaluate(item, scope));
        }
        return items;
      }
      case 'unary': {
        const value = yield* this.evaluate(expr.arg, scope);
        if (expr.op === '!') {
          return !truthy(value);
        }
        if (typeof value !== 'number') {
          throw new ScriptError(`"-" needs a number, got ${typeName(value)}`, expr.line);
        }
        return -value;
      }
      case 'binary': {
        const left = yield* this.evaluate(expr.left, scope);
        if (expr.op === '&&') {
          return truthy(left) ? yield* this.evaluate(expr.right, scope) : left;
        }
        if (expr.op === '||') {
          return truthy(left) ? left : yield* this.evaluate(expr.right, scope);
        }
        const right = yield* this.evaluate(expr.right, scope);
        return applyBinary(expr.op, left, right, expr.line);
      }
      case 'index': {
        const container = yield* this.evaluate(expr.target, scope);
        const index = yield* this.evaluate(expr.index, scope);
        const { list, slot } = checkedSlot(container, index, expr.line);
        return list[slot] ?? null;
      }
      case 'member': {
        const target = yield* this.evaluate(expr.target, scope);
        if (Array.isArray(target)) {
          if (expr.name === 'length') {
            return target.length;
          }
          const hint = 'Use len(), push() and pop() for the rest';
          throw new ScriptError(`A list only has .length. ${hint}`, expr.line);
        }
        if (isRecord(target)) {
          const field = Object.hasOwn(target, expr.name) ? target[expr.name] : undefined;
          if (field === undefined) {
            const fields = Object.keys(target).join(', ');
            throw new ScriptError(`There is no .${expr.name} here. It has: ${fields}`, expr.line);
          }
          return field;
        }
        throw new ScriptError(`Cannot read .${expr.name} of ${typeName(target)}`, expr.line);
      }
      case 'call':
        return yield* this.call(expr, scope);
      default:
        return unreachable(expr);
    }
  }

  /**
   * @param {Extract<Expr, { kind: 'call' }>} expr
   * @param {Scope} scope
   * @returns {Generator<number, Value, void>}
   */
  *call(expr, scope) {
    const callee = yield* this.evaluate(expr.callee, scope);
    /** @type {Value[]} */
    const args = [];
    for (const arg of expr.args) {
      args.push(yield* this.evaluate(arg, scope));
    }
    this.line = expr.line;

    if (callee instanceof Builtin) {
      if (args.length < callee.min || args.length > callee.max) {
        const message = arityMessage(callee.name, callee.min, callee.max, args.length);
        throw new ScriptError(message, expr.line);
      }
      const result = callee.run(args);
      if (result instanceof Wait) {
        yield result.seconds;
        return result.value;
      }
      return result;
    }

    if (callee instanceof UserFn) {
      const count = callee.params.length;
      if (args.length !== count) {
        throw new ScriptError(arityMessage(callee.name, count, count, args.length), expr.line);
      }
      if (this.depth >= MAX_CALL_DEPTH) {
        const hint = 'Check its stop condition';
        throw new ScriptError(`${callee.name}() calls itself too deep. ${hint}`, expr.line);
      }
      const inner = new Scope(callee.scope);
      callee.params.forEach((param, i) => inner.vars.set(param, args[i] ?? null));
      this.depth += 1;
      const signal = yield* this.block(callee.body, inner);
      this.depth -= 1;
      this.line = expr.line;
      return signal?.kind === 'return' ? signal.value : null;
    }

    if (expr.callee.kind === 'name') {
      const name = expr.callee.name;
      const hidden = this.host.globals.get(name) instanceof Fn;
      const hint = hidden ? ` A variable named "${name}" hides the built-in ${name}()` : '';
      throw new ScriptError(`"${name}" is ${typeName(callee)}, not a function.${hint}`, expr.line);
    }
    throw new ScriptError(`Cannot call ${typeName(callee)}, it is not a function`, expr.line);
  }
}

/**
 * Marks a switch as complete: the compiler reports a missing case here.
 *
 * @param {never} value
 * @returns {never}
 */
function unreachable(value) {
  throw new Error(`Unhandled syntax node: ${JSON.stringify(value)}`);
}
