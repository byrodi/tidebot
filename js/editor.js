// @ts-check
/** A small code editor: a textarea on top of a highlighted copy of its text. */

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
const INDENT = '  ';
/** Comment, text, number, word, or any other single character. */
const TOKEN =
  /(\/\/.*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\d+(?:\.\d+)?)|([A-Za-z_]\w*)|([\s\S])/g;

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {string} tag
 * @param {string} className
 * @returns {HTMLElement}
 */
function create(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** The script editor with line numbers, syntax colors and line marks. */
export class Editor {
  /**
   * @param {HTMLElement} root
   * @param {{ onChange: () => void, onRun: () => void }} options
   */
  constructor(root, options) {
    this.onChange = options.onChange;
    this.onRun = options.onRun;
    /** @type {ReadonlySet<string>} Names of built-ins, colored as functions. */
    this.words = new Set();
    this.activeLine = 0;
    this.errorLine = 0;
    /** @type {HTMLElement[]} */
    this.lineNodes = [];
    /** @type {HTMLElement[]} */
    this.numberNodes = [];

    this.numbers = create('div', 'editor-numbers');
    this.gutter = create('div', 'editor-gutter');
    this.gutter.append(this.numbers);
    this.layer = create('pre', 'editor-layer');
    this.layer.setAttribute('aria-hidden', 'true');
    this.input = document.createElement('textarea');
    this.input.className = 'editor-input';
    this.input.spellcheck = false;
    this.input.wrap = 'off';
    this.input.autocapitalize = 'off';
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('aria-label', 'Boat script');
    const code = create('div', 'editor-code');
    code.append(this.layer, this.input);
    root.append(this.gutter, code);

    this.input.addEventListener('input', () => {
      this.render();
      this.onChange();
    });
    this.input.addEventListener('scroll', () => {
      this.syncScroll();
    });
    this.input.addEventListener('keydown', (event) => {
      this.onKey(event);
    });
    this.render();
  }

  /** @returns {string} */
  get value() {
    return this.input.value;
  }

  /** @param {string} text */
  set value(text) {
    this.input.value = text;
    this.render();
  }

  /** @param {ReadonlySet<string>} words */
  setWords(words) {
    this.words = words;
    this.render();
  }

  /**
   * @param {number} active Line the script is running, 0 for none.
   * @param {number} error Line with an error, 0 for none.
   */
  setMarks(active, error) {
    if (active === this.activeLine && error === this.errorLine) {
      return;
    }
    this.mark(this.activeLine, 'active', false);
    this.mark(this.errorLine, 'error', false);
    this.activeLine = active;
    this.errorLine = error;
    this.mark(active, 'active', true);
    this.mark(error, 'error', true);
  }

  /**
   * @param {number} line
   * @param {string} name
   * @param {boolean} on
   */
  mark(line, name, on) {
    this.lineNodes[line - 1]?.classList.toggle(name, on);
    this.numberNodes[line - 1]?.classList.toggle(name, on);
  }

  render() {
    const lines = this.input.value.split('\n');
    this.lineNodes = [];
    this.numberNodes = [];
    lines.forEach((line, index) => {
      const row = create('div', 'editor-line');
      // An empty block has no height, so an empty line keeps one invisible character.
      row.innerHTML = line === '' ? '\u200b' : this.highlight(line);
      this.lineNodes.push(row);
      const number = create('div', 'editor-number');
      number.textContent = String(index + 1);
      this.numberNodes.push(number);
    });
    this.layer.replaceChildren(...this.lineNodes);
    this.numbers.replaceChildren(...this.numberNodes);
    this.mark(this.activeLine, 'active', true);
    this.mark(this.errorLine, 'error', true);
    this.syncScroll();
  }

  /**
   * @param {string} line
   * @returns {string} The line as HTML with colored tokens.
   */
  highlight(line) {
    return line.replace(TOKEN, (match, comment, text, number, word) => {
      const safe = escapeHtml(match);
      if (comment !== undefined) {
        return `<span class="tok-comment">${safe}</span>`;
      }
      if (text !== undefined) {
        return `<span class="tok-text">${safe}</span>`;
      }
      if (number !== undefined) {
        return `<span class="tok-number">${safe}</span>`;
      }
      if (word !== undefined && KEYWORDS.has(match)) {
        return `<span class="tok-keyword">${safe}</span>`;
      }
      if (word !== undefined && this.words.has(match)) {
        return `<span class="tok-builtin">${safe}</span>`;
      }
      return safe;
    });
  }

  syncScroll() {
    const { scrollLeft, scrollTop } = this.input;
    this.layer.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    this.numbers.style.transform = `translateY(${-scrollTop}px)`;
  }

  /** @param {KeyboardEvent} event */
  onKey(event) {
    const input = this.input;
    const before = input.value.slice(0, input.selectionStart);
    const line = before.slice(before.lastIndexOf('\n') + 1);
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.onRun();
    } else if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      this.insert(INDENT);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      this.insert(`\n${indent}${/\{\s*$/.test(line) ? INDENT : ''}`);
    } else if (event.key === '}' && /^[ \t]+$/.test(line) && line.endsWith(INDENT)) {
      // A closing brace on an empty line steps back one indent.
      event.preventDefault();
      input.setSelectionRange(input.selectionStart - INDENT.length, input.selectionEnd);
      this.insert('}');
    }
  }

  /** @param {string} text Replaces the selection and keeps the undo history. */
  insert(text) {
    // execCommand is deprecated, but it is the only insert that the browser can undo.
    if (!document.execCommand('insertText', false, text)) {
      this.input.setRangeText(text, this.input.selectionStart, this.input.selectionEnd, 'end');
      this.input.dispatchEvent(new Event('input'));
    }
  }
}
