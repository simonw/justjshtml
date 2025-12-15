export class SelectorError extends Error {
  constructor(message) {
    super(message);
    this.name = "SelectorError";
  }
}

const TokenType = {
  TAG: "TAG",
  ID: "ID",
  CLASS: "CLASS",
  UNIVERSAL: "UNIVERSAL",
  ATTR_START: "ATTR_START",
  ATTR_END: "ATTR_END",
  ATTR_OP: "ATTR_OP",
  STRING: "STRING",
  COMBINATOR: "COMBINATOR",
  COMMA: "COMMA",
  COLON: "COLON",
  PAREN_OPEN: "PAREN_OPEN",
  PAREN_CLOSE: "PAREN_CLOSE",
  EOF: "EOF",
};

class Token {
  constructor(type, value = null) {
    this.type = type;
    this.value = value;
  }

  toString() {
    return `Token(${this.type}, ${JSON.stringify(this.value)})`;
  }
}

class SelectorTokenizer {
  constructor(selector) {
    this.selector = selector;
    this.pos = 0;
    this.length = selector.length;
  }

  _peek(offset = 0) {
    const pos = this.pos + offset;
    if (pos < this.length) return this.selector[pos];
    return "";
  }

  _skipWhitespace() {
    while (this.pos < this.length && " \t\n\r\f".includes(this.selector[this.pos])) this.pos += 1;
  }

  _isNameStart(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0) ?? 0;
    if (code > 127) return true;
    if (ch === "_" || ch === "-") return true;
    return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
  }

  _isNameChar(ch) {
    if (this._isNameStart(ch)) return true;
    return ch >= "0" && ch <= "9";
  }

  _readName() {
    const start = this.pos;
    while (this.pos < this.length && this._isNameChar(this.selector[this.pos])) this.pos += 1;
    return this.selector.slice(start, this.pos);
  }

  _readString(quote) {
    this.pos += 1;
    let start = this.pos;
    const parts = [];

    while (this.pos < this.length) {
      const ch = this.selector[this.pos];
      if (ch === quote) {
        if (this.pos > start) parts.push(this.selector.slice(start, this.pos));
        this.pos += 1;
        return parts.join("");
      }
      if (ch === "\\") {
        if (this.pos > start) parts.push(this.selector.slice(start, this.pos));
        this.pos += 1;
        if (this.pos < this.length) {
          parts.push(this.selector[this.pos]);
          this.pos += 1;
          start = this.pos;
        } else {
          start = this.pos;
        }
      } else {
        this.pos += 1;
      }
    }

    throw new SelectorError(`Unterminated string in selector: ${JSON.stringify(this.selector)}`);
  }

  _readUnquotedAttrValue() {
    const start = this.pos;
    while (this.pos < this.length) {
      const ch = this.selector[this.pos];
      if (" \t\n\r\f]".includes(ch)) break;
      this.pos += 1;
    }
    return this.selector.slice(start, this.pos);
  }

  tokenize() {
    const tokens = [];
    let pendingWhitespace = false;

    while (this.pos < this.length) {
      const ch = this.selector[this.pos];

      if (" \t\n\r\f".includes(ch)) {
        pendingWhitespace = true;
        this._skipWhitespace();
        continue;
      }

      if (">+~".includes(ch)) {
        pendingWhitespace = false;
        this.pos += 1;
        this._skipWhitespace();
        tokens.push(new Token(TokenType.COMBINATOR, ch));
        continue;
      }

      if (pendingWhitespace && tokens.length && ch !== ",") {
        tokens.push(new Token(TokenType.COMBINATOR, " "));
      }
      pendingWhitespace = false;

      if (ch === "*") {
        this.pos += 1;
        tokens.push(new Token(TokenType.UNIVERSAL));
        continue;
      }

      if (ch === "#") {
        this.pos += 1;
        const name = this._readName();
        if (!name) throw new SelectorError(`Expected identifier after # at position ${this.pos}`);
        tokens.push(new Token(TokenType.ID, name));
        continue;
      }

      if (ch === ".") {
        this.pos += 1;
        const name = this._readName();
        if (!name) throw new SelectorError(`Expected identifier after . at position ${this.pos}`);
        tokens.push(new Token(TokenType.CLASS, name));
        continue;
      }

      if (ch === "[") {
        this.pos += 1;
        tokens.push(new Token(TokenType.ATTR_START));
        this._skipWhitespace();

        const attrName = this._readName();
        if (!attrName) throw new SelectorError(`Expected attribute name at position ${this.pos}`);
        tokens.push(new Token(TokenType.TAG, attrName));
        this._skipWhitespace();

        const ch2 = this._peek();
        if (ch2 === "]") {
          this.pos += 1;
          tokens.push(new Token(TokenType.ATTR_END));
          continue;
        }

        if (ch2 === "=") {
          this.pos += 1;
          tokens.push(new Token(TokenType.ATTR_OP, "="));
        } else if ("~|^$*".includes(ch2)) {
          const opChar = ch2;
          this.pos += 1;
          if (this._peek() !== "=") throw new SelectorError(`Expected = after ${opChar} at position ${this.pos}`);
          this.pos += 1;
          tokens.push(new Token(TokenType.ATTR_OP, `${opChar}=`));
        } else {
          throw new SelectorError(`Unexpected character in attribute selector: ${JSON.stringify(ch2)}`);
        }

        this._skipWhitespace();

        const ch3 = this._peek();
        let value;
        if (ch3 === '"' || ch3 === "'") value = this._readString(ch3);
        else value = this._readUnquotedAttrValue();
        tokens.push(new Token(TokenType.STRING, value));

        this._skipWhitespace();
        if (this._peek() !== "]") throw new SelectorError(`Expected ] at position ${this.pos}`);
        this.pos += 1;
        tokens.push(new Token(TokenType.ATTR_END));
        continue;
      }

      if (ch === ",") {
        this.pos += 1;
        this._skipWhitespace();
        tokens.push(new Token(TokenType.COMMA));
        continue;
      }

      if (ch === ":") {
        this.pos += 1;
        tokens.push(new Token(TokenType.COLON));

        const name = this._readName();
        if (!name) throw new SelectorError(`Expected pseudo-class name after : at position ${this.pos}`);
        tokens.push(new Token(TokenType.TAG, name));

        if (this._peek() === "(") {
          this.pos += 1;
          tokens.push(new Token(TokenType.PAREN_OPEN));
          this._skipWhitespace();

          let parenDepth = 1;
          const argStart = this.pos;
          while (this.pos < this.length && parenDepth > 0) {
            const c = this.selector[this.pos];
            if (c === "(") parenDepth += 1;
            else if (c === ")") parenDepth -= 1;
            if (parenDepth > 0) this.pos += 1;
          }

          const arg = this.selector.slice(argStart, this.pos).trim();
          if (arg) tokens.push(new Token(TokenType.STRING, arg));

          if (this._peek() !== ")") throw new SelectorError(`Expected ) at position ${this.pos}`);
          this.pos += 1;
          tokens.push(new Token(TokenType.PAREN_CLOSE));
        }

        continue;
      }

      if (this._isNameStart(ch)) {
        const name = this._readName().toLowerCase();
        tokens.push(new Token(TokenType.TAG, name));
        continue;
      }

      throw new SelectorError(`Unexpected character ${JSON.stringify(ch)} at position ${this.pos}`);
    }

    tokens.push(new Token(TokenType.EOF));
    return tokens;
  }
}

class SimpleSelector {
  static TYPE_TAG = "tag";
  static TYPE_ID = "id";
  static TYPE_CLASS = "class";
  static TYPE_UNIVERSAL = "universal";
  static TYPE_ATTR = "attr";
  static TYPE_PSEUDO = "pseudo";

  constructor(selectorType, { name = null, operator = null, value = null, arg = null } = {}) {
    this.type = selectorType;
    this.name = name;
    this.operator = operator;
    this.value = value;
    this.arg = arg;
  }
}

class CompoundSelector {
  constructor(selectors = []) {
    this.selectors = selectors;
  }
}

class ComplexSelector {
  constructor() {
    this.parts = [];
  }
}

class SelectorList {
  constructor(selectors = []) {
    this.selectors = selectors;
  }
}

class SelectorParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  _peek() {
    if (this.pos < this.tokens.length) return this.tokens[this.pos];
    return new Token(TokenType.EOF);
  }

  _advance() {
    const token = this._peek();
    this.pos += 1;
    return token;
  }

  _expect(tokenType) {
    const token = this._peek();
    if (token.type !== tokenType) throw new SelectorError(`Expected ${tokenType}, got ${token.type}`);
    return this._advance();
  }

  parse() {
    const selectors = [];
    selectors.push(this._parseComplexSelector());

    while (this._peek().type === TokenType.COMMA) {
      this._advance();
      const selector = this._parseComplexSelector();
      if (selector) selectors.push(selector);
    }

    if (this._peek().type !== TokenType.EOF) throw new SelectorError(`Unexpected token: ${this._peek()}`);

    if (selectors.length === 1) return selectors[0];
    return new SelectorList(selectors);
  }

  _parseComplexSelector() {
    const complexSel = new ComplexSelector();

    const compound = this._parseCompoundSelector();
    if (!compound) return null;
    complexSel.parts.push([null, compound]);

    while (this._peek().type === TokenType.COMBINATOR) {
      const combinator = this._advance().value;
      const nextCompound = this._parseCompoundSelector();
      if (!nextCompound) throw new SelectorError("Expected selector after combinator");
      complexSel.parts.push([combinator, nextCompound]);
    }

    return complexSel;
  }

  _parseCompoundSelector() {
    const simpleSelectors = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = this._peek();

      if (token.type === TokenType.TAG) {
        this._advance();
        simpleSelectors.push(new SimpleSelector(SimpleSelector.TYPE_TAG, { name: token.value }));
      } else if (token.type === TokenType.UNIVERSAL) {
        this._advance();
        simpleSelectors.push(new SimpleSelector(SimpleSelector.TYPE_UNIVERSAL));
      } else if (token.type === TokenType.ID) {
        this._advance();
        simpleSelectors.push(new SimpleSelector(SimpleSelector.TYPE_ID, { name: token.value }));
      } else if (token.type === TokenType.CLASS) {
        this._advance();
        simpleSelectors.push(new SimpleSelector(SimpleSelector.TYPE_CLASS, { name: token.value }));
      } else if (token.type === TokenType.ATTR_START) {
        simpleSelectors.push(this._parseAttributeSelector());
      } else if (token.type === TokenType.COLON) {
        simpleSelectors.push(this._parsePseudoSelector());
      } else {
        break;
      }
    }

    if (!simpleSelectors.length) return null;
    return new CompoundSelector(simpleSelectors);
  }

  _parseAttributeSelector() {
    this._expect(TokenType.ATTR_START);
    const attrName = this._expect(TokenType.TAG).value;

    const token = this._peek();
    if (token.type === TokenType.ATTR_END) {
      this._advance();
      return new SimpleSelector(SimpleSelector.TYPE_ATTR, { name: attrName });
    }

    const operator = this._expect(TokenType.ATTR_OP).value;
    const value = this._expect(TokenType.STRING).value;
    this._expect(TokenType.ATTR_END);

    return new SimpleSelector(SimpleSelector.TYPE_ATTR, { name: attrName, operator, value });
  }

  _parsePseudoSelector() {
    this._expect(TokenType.COLON);
    const name = this._expect(TokenType.TAG).value;

    if (this._peek().type === TokenType.PAREN_OPEN) {
      this._advance();
      let arg = null;
      if (this._peek().type === TokenType.STRING) arg = this._advance().value;
      this._expect(TokenType.PAREN_CLOSE);
      return new SimpleSelector(SimpleSelector.TYPE_PSEUDO, { name, arg });
    }

    return new SimpleSelector(SimpleSelector.TYPE_PSEUDO, { name });
  }
}

function isElementNode(node) {
  return node != null && typeof node.name === "string" && !node.name.startsWith("#") && node.name !== "!doctype";
}

class SelectorMatcher {
  matches(node, selector) {
    if (selector instanceof SelectorList) return selector.selectors.some((sel) => this.matches(node, sel));
    if (selector instanceof ComplexSelector) return this._matchesComplex(node, selector);
    if (selector instanceof CompoundSelector) return this._matchesCompound(node, selector);
    if (selector instanceof SimpleSelector) return this._matchesSimple(node, selector);
    return false;
  }

  _matchesComplex(node, selector) {
    const parts = selector.parts;
    if (!parts.length) return false;

    const [, compound] = parts[parts.length - 1];
    if (!this._matchesCompound(node, compound)) return false;

    let current = node;
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      const [combinator] = parts[i + 1];
      const [, prevCompound] = parts[i];

      if (combinator === " ") {
        let found = false;
        let ancestor = current.parent;
        while (ancestor) {
          if (this._matchesCompound(ancestor, prevCompound)) {
            current = ancestor;
            found = true;
            break;
          }
          ancestor = ancestor.parent;
        }
        if (!found) return false;
      } else if (combinator === ">") {
        const parent = current.parent;
        if (!parent || !this._matchesCompound(parent, prevCompound)) return false;
        current = parent;
      } else if (combinator === "+") {
        const sibling = this._getPreviousSibling(current);
        if (!sibling || !this._matchesCompound(sibling, prevCompound)) return false;
        current = sibling;
      } else {
        let found = false;
        let sibling = this._getPreviousSibling(current);
        while (sibling) {
          if (this._matchesCompound(sibling, prevCompound)) {
            current = sibling;
            found = true;
            break;
          }
          sibling = this._getPreviousSibling(sibling);
        }
        if (!found) return false;
      }
    }

    return true;
  }

  _matchesCompound(node, compound) {
    return compound.selectors.every((simple) => this._matchesSimple(node, simple));
  }

  _matchesSimple(node, selector) {
    if (!isElementNode(node)) return false;

    if (selector.type === SimpleSelector.TYPE_UNIVERSAL) return true;

    if (selector.type === SimpleSelector.TYPE_TAG) return node.name.toLowerCase() === String(selector.name).toLowerCase();

    if (selector.type === SimpleSelector.TYPE_ID) return (node.attrs?.id ?? "") === selector.name;

    if (selector.type === SimpleSelector.TYPE_CLASS) {
      const classAttr = node.attrs?.class ?? "";
      const classes = classAttr ? String(classAttr).split(/\s+/).filter(Boolean) : [];
      return classes.includes(selector.name);
    }

    if (selector.type === SimpleSelector.TYPE_ATTR) return this._matchesAttribute(node, selector);

    if (selector.type === SimpleSelector.TYPE_PSEUDO) return this._matchesPseudo(node, selector);

    return false;
  }

  _matchesAttribute(node, selector) {
    const attrs = node.attrs || {};
    const attrName = String(selector.name || "").toLowerCase();

    let found = false;
    let attrValue = null;
    for (const [name, value] of Object.entries(attrs)) {
      if (name.toLowerCase() === attrName) {
        found = true;
        attrValue = value;
        break;
      }
    }
    if (!found) return false;

    if (selector.operator == null) return true;

    const op = selector.operator;
    const value = selector.value;
    const s = attrValue == null ? "" : String(attrValue);

    if (op === "=") return s === value;
    if (op === "~=") return (s ? s.split(/\s+/).filter(Boolean) : []).includes(value);
    if (op === "|=") return s === value || (value ? s.startsWith(`${value}-`) : false);
    if (op === "^=") return value ? s.startsWith(value) : false;
    if (op === "$=") return value ? s.endsWith(value) : false;
    if (op === "*=") return value ? s.includes(value) : false;

    return false;
  }

  _matchesPseudo(node, selector) {
    const name = String(selector.name || "").toLowerCase();

    if (name === "first-child") return this._isFirstChild(node);
    if (name === "last-child") return this._isLastChild(node);
    if (name === "nth-child") return this._matchesNthChild(node, selector.arg);

    if (name === "not") {
      if (!selector.arg) return true;
      const inner = parseSelector(selector.arg);
      return !this.matches(node, inner);
    }

    if (name === "only-child") return this._isFirstChild(node) && this._isLastChild(node);

    if (name === "empty") {
      const children = node.children || [];
      for (const child of children) {
        if (child?.name === "#text") {
          if (child.data && String(child.data).trim()) return false;
        } else if (isElementNode(child)) {
          return false;
        }
      }
      return true;
    }

    if (name === "root") {
      const parent = node.parent;
      return parent != null && (parent.name === "#document" || parent.name === "#document-fragment");
    }

    if (name === "first-of-type") return this._isFirstOfType(node);
    if (name === "last-of-type") return this._isLastOfType(node);
    if (name === "nth-of-type") return this._matchesNthOfType(node, selector.arg);
    if (name === "only-of-type") return this._isFirstOfType(node) && this._isLastOfType(node);

    throw new SelectorError(`Unsupported pseudo-class: :${name}`);
  }

  _getElementChildren(parent) {
    if (!parent || !Array.isArray(parent.children) || !parent.children.length) return [];
    return parent.children.filter((c) => isElementNode(c));
  }

  _getPreviousSibling(node) {
    const parent = node.parent;
    if (!parent || !Array.isArray(parent.children)) return null;

    let prev = null;
    for (const child of parent.children) {
      if (child === node) return prev;
      if (isElementNode(child)) prev = child;
    }
    return null;
  }

  _isFirstChild(node) {
    const parent = node.parent;
    if (!parent) return false;
    const elements = this._getElementChildren(parent);
    return elements.length ? elements[0] === node : false;
  }

  _isLastChild(node) {
    const parent = node.parent;
    if (!parent) return false;
    const elements = this._getElementChildren(parent);
    return elements.length ? elements[elements.length - 1] === node : false;
  }

  _isFirstOfType(node) {
    const parent = node.parent;
    if (!parent) return false;
    const nodeName = node.name.toLowerCase();
    for (const child of this._getElementChildren(parent)) {
      if (child.name.toLowerCase() === nodeName) return child === node;
    }
    return false;
  }

  _isLastOfType(node) {
    const parent = node.parent;
    if (!parent) return false;
    const nodeName = node.name.toLowerCase();
    let lastOfType = null;
    for (const child of this._getElementChildren(parent)) {
      if (child.name.toLowerCase() === nodeName) lastOfType = child;
    }
    return lastOfType === node;
  }

  _parseNthExpression(expr) {
    if (!expr) return null;

    let s = String(expr).trim().toLowerCase();
    if (s === "odd") return [2, 1];
    if (s === "even") return [2, 0];

    s = s.replaceAll(" ", "");

    let a = 0;
    let b = 0;

    if (s.includes("n")) {
      const parts = s.split("n");
      const aPart = parts[0];
      const bPart = parts.length > 1 ? parts[1] : "";

      if (aPart === "" || aPart === "+") a = 1;
      else if (aPart === "-") a = -1;
      else {
        a = Number.parseInt(aPart, 10);
        if (Number.isNaN(a)) return null;
      }

      if (bPart) {
        b = Number.parseInt(bPart, 10);
        if (Number.isNaN(b)) return null;
      }
    } else {
      b = Number.parseInt(s, 10);
      if (Number.isNaN(b)) return null;
    }

    return [a, b];
  }

  _matchesNth(index, a, b) {
    if (a === 0) return index === b;
    const diff = index - b;
    if (a > 0) return diff >= 0 && diff % a === 0;
    return diff <= 0 && diff % a === 0;
  }

  _matchesNthChild(node, arg) {
    const parent = node.parent;
    if (!parent) return false;

    const parsed = this._parseNthExpression(arg);
    if (parsed == null) return false;
    const [a, b] = parsed;

    const elements = this._getElementChildren(parent);
    for (let i = 0; i < elements.length; i += 1) {
      if (elements[i] === node) return this._matchesNth(i + 1, a, b);
    }
    return false;
  }

  _matchesNthOfType(node, arg) {
    const parent = node.parent;
    if (!parent) return false;

    const parsed = this._parseNthExpression(arg);
    if (parsed == null) return false;
    const [a, b] = parsed;

    const nodeName = node.name.toLowerCase();
    const elements = this._getElementChildren(parent);
    let typeIndex = 0;
    for (const child of elements) {
      if (child.name.toLowerCase() === nodeName) {
        typeIndex += 1;
        if (child === node) return this._matchesNth(typeIndex, a, b);
      }
    }
    return false;
  }
}

function parseSelector(selectorString) {
  if (!selectorString || !String(selectorString).trim()) throw new SelectorError("Empty selector");

  const tokenizer = new SelectorTokenizer(String(selectorString).trim());
  const tokens = tokenizer.tokenize();
  const parser = new SelectorParser(tokens);
  return parser.parse();
}

const matcher = new SelectorMatcher();

function queryDescendants(node, selector, results) {
  if (!node || !Array.isArray(node.children)) return;

  for (const child of node.children) {
    if (isElementNode(child) && matcher.matches(child, selector)) results.push(child);
    queryDescendants(child, selector, results);
  }

  const templateContent = node.templateContent ?? node.template_content ?? null;
  if (templateContent) queryDescendants(templateContent, selector, results);
}

export function query(root, selectorString) {
  const selector = parseSelector(selectorString);
  const results = [];
  queryDescendants(root, selector, results);
  return results;
}

export function matches(node, selectorString) {
  const selector = parseSelector(selectorString);
  return matcher.matches(node, selector);
}

