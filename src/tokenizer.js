import { decodeEntitiesInText } from "./entities.js";
import { CharacterToken, CommentToken, Doctype, DoctypeToken, EOFToken, Tag, TokenSinkResult } from "./tokens.js";

function isWhitespace(c) {
  return c === "\t" || c === "\n" || c === "\f" || c === " " || c === "\r";
}

function isAsciiAlpha(c) {
  const code = c.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function asciiLower(c) {
  const code = c.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code + 0x20);
  return c;
}

function coerceTextForXML(text) {
  if (!text) return text;

  let changed = false;
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0c) {
      out += " ";
      changed = true;
      continue;
    }
    if (cp >= 0xfdd0 && cp <= 0xfdef) {
      out += "\ufffd";
      changed = true;
      continue;
    }
    const low16 = cp & 0xffff;
    if (low16 === 0xfffe || low16 === 0xffff) {
      out += "\ufffd";
      changed = true;
      continue;
    }
    out += ch;
  }

  return changed ? out : text;
}

function coerceCommentForXML(text) {
  if (!text) return text;
  if (!text.includes("--")) return text;
  return text.replaceAll("--", "- -");
}

export class TokenizerOpts {
  constructor({ initialState = null, initialRawtextTag = null, discardBom = true, xmlCoercion = false } = {}) {
    this.initialState = initialState;
    this.initialRawtextTag = initialRawtextTag;
    this.discardBom = Boolean(discardBom);
    this.xmlCoercion = Boolean(xmlCoercion);
  }
}

// Minimal HTML5 tokenizer, ported incrementally from ~/dev/justhtml.
export class Tokenizer {
  // State constants (match Python justhtml for easier porting)
  static DATA = 0;
  static TAG_OPEN = 1;
  static END_TAG_OPEN = 2;
  static TAG_NAME = 3;
  static BEFORE_ATTRIBUTE_NAME = 4;
  static ATTRIBUTE_NAME = 5;
  static AFTER_ATTRIBUTE_NAME = 6;
  static BEFORE_ATTRIBUTE_VALUE = 7;
  static ATTRIBUTE_VALUE_DOUBLE = 8;
  static ATTRIBUTE_VALUE_SINGLE = 9;
  static ATTRIBUTE_VALUE_UNQUOTED = 10;
  static AFTER_ATTRIBUTE_VALUE_QUOTED = 11;
  static SELF_CLOSING_START_TAG = 12;
  static MARKUP_DECLARATION_OPEN = 13;
  static COMMENT_START = 14;
  static COMMENT_START_DASH = 15;
  static COMMENT = 16;
  static COMMENT_END_DASH = 17;
  static COMMENT_END = 18;
  static COMMENT_END_BANG = 19;
  static BOGUS_COMMENT = 20;
  static DOCTYPE = 21;
  static BEFORE_DOCTYPE_NAME = 22;
  static DOCTYPE_NAME = 23;
  static AFTER_DOCTYPE_NAME = 24;
  static BOGUS_DOCTYPE = 25;
  static AFTER_DOCTYPE_PUBLIC_KEYWORD = 26;
  static AFTER_DOCTYPE_SYSTEM_KEYWORD = 27;
  static BEFORE_DOCTYPE_PUBLIC_IDENTIFIER = 28;
  static DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED = 29;
  static DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED = 30;
  static AFTER_DOCTYPE_PUBLIC_IDENTIFIER = 31;
  static BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS = 32;
  static BEFORE_DOCTYPE_SYSTEM_IDENTIFIER = 33;
  static DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED = 34;
  static DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED = 35;
  static AFTER_DOCTYPE_SYSTEM_IDENTIFIER = 36;
  static CDATA_SECTION = 37;
  static CDATA_SECTION_BRACKET = 38;
  static CDATA_SECTION_END = 39;
  static RCDATA = 40;
  static RCDATA_LESS_THAN_SIGN = 41;
  static RCDATA_END_TAG_OPEN = 42;
  static RCDATA_END_TAG_NAME = 43;
  static RAWTEXT = 44;
  static RAWTEXT_LESS_THAN_SIGN = 45;
  static RAWTEXT_END_TAG_OPEN = 46;
  static RAWTEXT_END_TAG_NAME = 47;
  static PLAINTEXT = 48;
  static SCRIPT_DATA_ESCAPED = 49;
  static SCRIPT_DATA_ESCAPED_DASH = 50;
  static SCRIPT_DATA_ESCAPED_DASH_DASH = 51;
  static SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN = 52;
  static SCRIPT_DATA_ESCAPED_END_TAG_OPEN = 53;
  static SCRIPT_DATA_ESCAPED_END_TAG_NAME = 54;
  static SCRIPT_DATA_DOUBLE_ESCAPE_START = 55;
  static SCRIPT_DATA_DOUBLE_ESCAPED = 56;
  static SCRIPT_DATA_DOUBLE_ESCAPED_DASH = 57;
  static SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH = 58;
  static SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN = 59;
  static SCRIPT_DATA_DOUBLE_ESCAPE_END = 60;

  constructor(sink, opts = new TokenizerOpts(), { collectErrors = false } = {}) {
    this.sink = sink;
    this.opts = opts;
    this.collectErrors = Boolean(collectErrors);

    this.errors = [];

    this.state = Tokenizer.DATA;
    this.buffer = "";
    this.length = 0;
    this.pos = 0;
    this.reconsume = false;
    this.currentChar = null;
    this.ignoreLF = false;

    this.textBuffer = [];
    this.currentTagName = [];
    this.currentTagAttrs = {};
    this.currentAttrName = [];
    this.currentAttrValue = [];
    this.currentAttrValueHasAmp = false;
    this.currentTagSelfClosing = false;
    this.currentTagKind = Tag.START;
    this.currentComment = [];

    this.currentDoctypeName = [];
    this.currentDoctypePublic = null;
    this.currentDoctypeSystem = null;
    this.currentDoctypeForceQuirks = false;

    this.lastStartTagName = null;
    this.rawtextTagName = null;
    this.tempBuffer = [];

    this._tagToken = new Tag(Tag.START, "", {}, false);
    this._commentToken = new CommentToken("");
  }

  initialize(html) {
    let input = html || "";
    if (this.opts.discardBom && input && input[0] === "\ufeff") input = input.slice(1);

    this.buffer = input;
    this.length = input.length;
    this.pos = 0;
    this.reconsume = false;
    this.currentChar = null;
    this.ignoreLF = false;
    this.errors = [];

    this.textBuffer.length = 0;
    this.currentTagName.length = 0;
    this.currentTagAttrs = {};
    this.currentAttrName.length = 0;
    this.currentAttrValue.length = 0;
    this.currentAttrValueHasAmp = false;
    this.currentTagSelfClosing = false;
    this.currentTagKind = Tag.START;
    this.currentComment.length = 0;

    this.currentDoctypeName.length = 0;
    this.currentDoctypePublic = null;
    this.currentDoctypeSystem = null;
    this.currentDoctypeForceQuirks = false;

    this.rawtextTagName = this.opts.initialRawtextTag;
    this.tempBuffer.length = 0;
    this.lastStartTagName = null;

    if (typeof this.opts.initialState === "number") this.state = this.opts.initialState;
    else this.state = Tokenizer.DATA;
  }

  run(html) {
    this.initialize(html);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.step()) break;
    }
  }

  step() {
    switch (this.state) {
      case Tokenizer.DATA:
        return this._stateData();
      case Tokenizer.TAG_OPEN:
        return this._stateTagOpen();
      case Tokenizer.END_TAG_OPEN:
        return this._stateEndTagOpen();
      case Tokenizer.TAG_NAME:
        return this._stateTagName();
      case Tokenizer.BEFORE_ATTRIBUTE_NAME:
        return this._stateBeforeAttributeName();
      case Tokenizer.ATTRIBUTE_NAME:
        return this._stateAttributeName();
      case Tokenizer.AFTER_ATTRIBUTE_NAME:
        return this._stateAfterAttributeName();
      case Tokenizer.BEFORE_ATTRIBUTE_VALUE:
        return this._stateBeforeAttributeValue();
      case Tokenizer.ATTRIBUTE_VALUE_DOUBLE:
        return this._stateAttributeValueDouble();
      case Tokenizer.ATTRIBUTE_VALUE_SINGLE:
        return this._stateAttributeValueSingle();
      case Tokenizer.ATTRIBUTE_VALUE_UNQUOTED:
        return this._stateAttributeValueUnquoted();
      case Tokenizer.AFTER_ATTRIBUTE_VALUE_QUOTED:
        return this._stateAfterAttributeValueQuoted();
      case Tokenizer.SELF_CLOSING_START_TAG:
        return this._stateSelfClosingStartTag();
      case Tokenizer.MARKUP_DECLARATION_OPEN:
        return this._stateMarkupDeclarationOpen();
      case Tokenizer.COMMENT_START:
        return this._stateCommentStart();
      case Tokenizer.COMMENT_START_DASH:
        return this._stateCommentStartDash();
      case Tokenizer.COMMENT:
        return this._stateComment();
      case Tokenizer.COMMENT_END_DASH:
        return this._stateCommentEndDash();
      case Tokenizer.COMMENT_END:
        return this._stateCommentEnd();
      case Tokenizer.COMMENT_END_BANG:
        return this._stateCommentEndBang();
      case Tokenizer.BOGUS_COMMENT:
        return this._stateBogusComment();
      case Tokenizer.DOCTYPE:
        return this._stateDoctype();
      case Tokenizer.BEFORE_DOCTYPE_NAME:
        return this._stateBeforeDoctypeName();
      case Tokenizer.DOCTYPE_NAME:
        return this._stateDoctypeName();
      case Tokenizer.AFTER_DOCTYPE_NAME:
        return this._stateAfterDoctypeName();
      case Tokenizer.BOGUS_DOCTYPE:
        return this._stateBogusDoctype();
      case Tokenizer.AFTER_DOCTYPE_PUBLIC_KEYWORD:
        return this._stateAfterDoctypePublicKeyword();
      case Tokenizer.AFTER_DOCTYPE_SYSTEM_KEYWORD:
        return this._stateAfterDoctypeSystemKeyword();
      case Tokenizer.BEFORE_DOCTYPE_PUBLIC_IDENTIFIER:
        return this._stateBeforeDoctypePublicIdentifier();
      case Tokenizer.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED:
        return this._stateDoctypePublicIdentifierDoubleQuoted();
      case Tokenizer.DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED:
        return this._stateDoctypePublicIdentifierSingleQuoted();
      case Tokenizer.AFTER_DOCTYPE_PUBLIC_IDENTIFIER:
        return this._stateAfterDoctypePublicIdentifier();
      case Tokenizer.BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS:
        return this._stateBetweenDoctypePublicAndSystemIdentifiers();
      case Tokenizer.BEFORE_DOCTYPE_SYSTEM_IDENTIFIER:
        return this._stateBeforeDoctypeSystemIdentifier();
      case Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED:
        return this._stateDoctypeSystemIdentifierDoubleQuoted();
      case Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED:
        return this._stateDoctypeSystemIdentifierSingleQuoted();
      case Tokenizer.AFTER_DOCTYPE_SYSTEM_IDENTIFIER:
        return this._stateAfterDoctypeSystemIdentifier();
      case Tokenizer.PLAINTEXT:
        return this._statePlaintext();
      default:
        // Not yet ported; fall back to DATA semantics to keep the runner usable.
        this.state = Tokenizer.DATA;
        return false;
    }
  }

  _getChar() {
    if (this.reconsume) {
      this.reconsume = false;
      return this.currentChar;
    }

    while (true) {
      if (this.pos >= this.length) {
        this.currentChar = null;
        return null;
      }

      let c = this.buffer[this.pos];
      this.pos += 1;

      if (c === "\r") {
        this.ignoreLF = true;
        c = "\n";
      } else if (c === "\n" && this.ignoreLF) {
        this.ignoreLF = false;
        continue;
      } else {
        this.ignoreLF = false;
      }

      this.currentChar = c;
      return c;
    }
  }

  _reconsumeCurrent() {
    this.reconsume = true;
  }

  _appendText(s) {
    if (s) this.textBuffer.push(s);
  }

  _flushText() {
    if (!this.textBuffer.length) return;
    let data = this.textBuffer.join("");
    this.textBuffer.length = 0;

    // Per HTML5 spec (and Python port):
    // - decode character references in DATA/RCDATA and similar (< RAWTEXT)
    // - do not decode in RAWTEXT/PLAINTEXT/script states or CDATA
    const state = this.state;
    const inCDATA = state >= Tokenizer.CDATA_SECTION && state <= Tokenizer.CDATA_SECTION_END;
    if (!inCDATA && state < Tokenizer.RAWTEXT && state < Tokenizer.PLAINTEXT) {
      if (data.includes("&")) data = decodeEntitiesInText(data);
    }

    if (this.opts.xmlCoercion) data = coerceTextForXML(data);

    this.sink.processCharacters(data);
  }

  _emitToken(token) {
    this.sink.processToken(token);
  }

  _emitError(_code) {
    // Tokenizer tests are currently token-only (errors ignored in our harness).
  }

  _startNewAttribute() {
    this.currentAttrName.length = 0;
    this.currentAttrValue.length = 0;
    this.currentAttrValueHasAmp = false;
  }

  _finishAttribute() {
    if (!this.currentAttrName.length) return;
    const name = this.currentAttrName.join("");
    this.currentAttrName.length = 0;

    if (Object.prototype.hasOwnProperty.call(this.currentTagAttrs, name)) {
      this._emitError("duplicate-attribute");
      this.currentAttrValue.length = 0;
      this.currentAttrValueHasAmp = false;
      return;
    }

    let value = "";
    if (this.currentAttrValue.length) value = this.currentAttrValue.join("");
    this.currentAttrValue.length = 0;

    if (this.currentAttrValueHasAmp) value = decodeEntitiesInText(value, { inAttribute: true });
    this.currentAttrValueHasAmp = false;

    this.currentTagAttrs[name] = value;
  }

  _emitCurrentTag() {
    const name = this.currentTagName.join("");
    const attrs = this.currentTagAttrs;

    const tag = this._tagToken;
    tag.kind = this.currentTagKind;
    tag.name = name;
    tag.attrs = attrs;
    tag.selfClosing = this.currentTagSelfClosing;

    if (this.currentTagKind === Tag.START) {
      this.lastStartTagName = name;
    }

    const result = this.sink.processToken(tag);
    if (result === TokenSinkResult.Plaintext) this.state = Tokenizer.PLAINTEXT;

    this.currentTagName.length = 0;
    this.currentTagAttrs = {};
    this.currentAttrName.length = 0;
    this.currentAttrValue.length = 0;
    this.currentAttrValueHasAmp = false;
    this.currentTagSelfClosing = false;
    this.currentTagKind = Tag.START;
  }

  _emitComment() {
    let data = this.currentComment.join("");
    this.currentComment.length = 0;
    if (this.opts.xmlCoercion) data = coerceCommentForXML(data);
    this._commentToken.data = data;
    this._emitToken(this._commentToken);
  }

  _emitDoctype() {
    const name = this.currentDoctypeName.length ? this.currentDoctypeName.join("") : null;
    const publicId = this.currentDoctypePublic != null ? this.currentDoctypePublic.join("") : null;
    const systemId = this.currentDoctypeSystem != null ? this.currentDoctypeSystem.join("") : null;

    const doctype = new Doctype({
      name,
      publicId,
      systemId,
      forceQuirks: this.currentDoctypeForceQuirks,
    });

    this.currentDoctypeName.length = 0;
    this.currentDoctypePublic = null;
    this.currentDoctypeSystem = null;
    this.currentDoctypeForceQuirks = false;

    this._emitToken(new DoctypeToken(doctype));
  }

  _consumeIf(literal) {
    const end = this.pos + literal.length;
    if (end > this.length) return false;
    if (this.buffer.slice(this.pos, end) !== literal) return false;
    this.pos = end;
    return true;
  }

  _consumeCaseInsensitive(literal) {
    const end = this.pos + literal.length;
    if (end > this.length) return false;
    const segment = this.buffer.slice(this.pos, end);
    if (segment.toLowerCase() !== literal.toLowerCase()) return false;
    this.pos = end;
    return true;
  }

  // -----------------
  // State handlers
  // -----------------

  _stateData() {
    const c = this._getChar();
    if (c == null) {
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === "<") {
      this._flushText();
      this.state = Tokenizer.TAG_OPEN;
      return false;
    }

    this._appendText(c);
    return false;
  }

  _statePlaintext() {
    const c = this._getChar();
    if (c == null) {
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }
    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this._appendText("\ufffd");
      return false;
    }
    this._appendText(c);
    return false;
  }

  _stateTagOpen() {
    const c = this._getChar();

    if (c == null) {
      this._appendText("<");
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === "!") {
      this.state = Tokenizer.MARKUP_DECLARATION_OPEN;
      return false;
    }

    if (c === "/") {
      this.state = Tokenizer.END_TAG_OPEN;
      return false;
    }

    if (c === "?") {
      this._emitError("unexpected-question-mark-instead-of-tag-name");
      this.currentComment.length = 0;
      this._reconsumeCurrent();
      this.state = Tokenizer.BOGUS_COMMENT;
      return false;
    }

    if (isAsciiAlpha(c)) {
      this.currentTagKind = Tag.START;
      this.currentTagName.length = 0;
      this.currentTagName.push(asciiLower(c));
      this.currentTagAttrs = {};
      this.currentTagSelfClosing = false;
      this.state = Tokenizer.TAG_NAME;
      return false;
    }

    this._emitError("invalid-first-character-of-tag-name");
    this._appendText("<");
    this._reconsumeCurrent();
    this.state = Tokenizer.DATA;
    return false;
  }

  _stateEndTagOpen() {
    const c = this._getChar();

    if (c == null) {
      this._emitError("eof-before-tag-name");
      this._appendText("</");
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }

    if (isAsciiAlpha(c)) {
      this.currentTagKind = Tag.END;
      this.currentTagName.length = 0;
      this.currentTagName.push(asciiLower(c));
      this.currentTagAttrs = {};
      this.currentTagSelfClosing = false;
      this.state = Tokenizer.TAG_NAME;
      return false;
    }

    if (c === ">") {
      this._emitError("missing-end-tag-name");
      this.state = Tokenizer.DATA;
      return false;
    }

    this._emitError("invalid-first-character-of-tag-name");
    this.currentComment.length = 0;
    this._reconsumeCurrent();
    this.state = Tokenizer.BOGUS_COMMENT;
    return false;
  }

  _stateTagName() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._emitToken(new EOFToken());
      return true;
    }

    if (isWhitespace(c)) {
      if (this.currentTagKind === Tag.END) this._emitError("end-tag-with-attributes");
      this.state = Tokenizer.BEFORE_ATTRIBUTE_NAME;
      return false;
    }

    if (c === "/") {
      this.state = Tokenizer.SELF_CLOSING_START_TAG;
      return false;
    }

    if (c === ">") {
      this._emitCurrentTag();
      this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentTagName.push("\ufffd");
      return false;
    }

    this.currentTagName.push(asciiLower(c));
    return false;
  }

  _stateBeforeAttributeName() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._emitToken(new EOFToken());
      return true;
    }

    if (isWhitespace(c)) return false;

    if (c === "/") {
      this.state = Tokenizer.SELF_CLOSING_START_TAG;
      return false;
    }

    if (c === ">") {
      this._emitCurrentTag();
      this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "=") {
      this._emitError("unexpected-equals-sign-before-attribute-name");
      this._startNewAttribute();
      this.currentAttrName.push("=");
      this.state = Tokenizer.ATTRIBUTE_NAME;
      return false;
    }

    this._startNewAttribute();
    this._reconsumeCurrent();
    this.state = Tokenizer.ATTRIBUTE_NAME;
    return false;
  }

  _stateAttributeName() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._emitToken(new EOFToken());
      return true;
    }

    if (isWhitespace(c)) {
      this._finishAttribute();
      this.state = Tokenizer.AFTER_ATTRIBUTE_NAME;
      return false;
    }

    if (c === "/") {
      this._finishAttribute();
      this.state = Tokenizer.SELF_CLOSING_START_TAG;
      return false;
    }

    if (c === "=") {
      this.state = Tokenizer.BEFORE_ATTRIBUTE_VALUE;
      return false;
    }

    if (c === ">") {
      this._finishAttribute();
      this._emitCurrentTag();
      this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentAttrName.push("\ufffd");
      return false;
    }

    this.currentAttrName.push(asciiLower(c));
    return false;
  }

  _stateAfterAttributeName() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._emitToken(new EOFToken());
      return true;
    }

    if (isWhitespace(c)) return false;

    if (c === "/") {
      this.state = Tokenizer.SELF_CLOSING_START_TAG;
      return false;
    }

    if (c === "=") {
      this.state = Tokenizer.BEFORE_ATTRIBUTE_VALUE;
      return false;
    }

    if (c === ">") {
      this._emitCurrentTag();
      this.state = Tokenizer.DATA;
      return false;
    }

    this._startNewAttribute();
    this._reconsumeCurrent();
    this.state = Tokenizer.ATTRIBUTE_NAME;
    return false;
  }

  _stateBeforeAttributeValue() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._emitToken(new EOFToken());
      return true;
    }

    if (isWhitespace(c)) return false;

    if (c === '"') {
      this.state = Tokenizer.ATTRIBUTE_VALUE_DOUBLE;
      return false;
    }

    if (c === "'") {
      this.state = Tokenizer.ATTRIBUTE_VALUE_SINGLE;
      return false;
    }

    if (c === ">") {
      this._emitError("missing-attribute-value");
      this._finishAttribute();
      this._emitCurrentTag();
      this.state = Tokenizer.DATA;
      return false;
    }

    this._reconsumeCurrent();
    this.state = Tokenizer.ATTRIBUTE_VALUE_UNQUOTED;
    return false;
  }

  _stateAttributeValueDouble() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === '"') {
      this._finishAttribute();
      this.state = Tokenizer.AFTER_ATTRIBUTE_VALUE_QUOTED;
      return false;
    }

    if (c === "&") this.currentAttrValueHasAmp = true;
    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentAttrValue.push("\ufffd");
      return false;
    }
    this.currentAttrValue.push(c);
    return false;
  }

  _stateAttributeValueSingle() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === "'") {
      this._finishAttribute();
      this.state = Tokenizer.AFTER_ATTRIBUTE_VALUE_QUOTED;
      return false;
    }

    if (c === "&") this.currentAttrValueHasAmp = true;
    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentAttrValue.push("\ufffd");
      return false;
    }
    this.currentAttrValue.push(c);
    return false;
  }

  _stateAttributeValueUnquoted() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._emitToken(new EOFToken());
      return true;
    }

    if (isWhitespace(c)) {
      this._finishAttribute();
      this.state = Tokenizer.BEFORE_ATTRIBUTE_NAME;
      return false;
    }

    if (c === "&") this.currentAttrValueHasAmp = true;

    if (c === ">") {
      this._finishAttribute();
      this._emitCurrentTag();
      this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentAttrValue.push("\ufffd");
      return false;
    }
    this.currentAttrValue.push(c);
    return false;
  }

  _stateAfterAttributeValueQuoted() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._emitToken(new EOFToken());
      return true;
    }

    if (isWhitespace(c)) {
      this.state = Tokenizer.BEFORE_ATTRIBUTE_NAME;
      return false;
    }

    if (c === "/") {
      this.state = Tokenizer.SELF_CLOSING_START_TAG;
      return false;
    }

    if (c === ">") {
      this._emitCurrentTag();
      this.state = Tokenizer.DATA;
      return false;
    }

    this._emitError("missing-whitespace-between-attributes");
    this._reconsumeCurrent();
    this.state = Tokenizer.BEFORE_ATTRIBUTE_NAME;
    return false;
  }

  _stateSelfClosingStartTag() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === ">") {
      this.currentTagSelfClosing = true;
      this._emitCurrentTag();
      this.state = Tokenizer.DATA;
      return false;
    }

    this._emitError("unexpected-character-after-solidus-in-tag");
    this._reconsumeCurrent();
    this.state = Tokenizer.BEFORE_ATTRIBUTE_NAME;
    return false;
  }

  _stateMarkupDeclarationOpen() {
    if (this._consumeIf("--")) {
      this.currentComment.length = 0;
      this.state = Tokenizer.COMMENT_START;
      return false;
    }

    if (this._consumeCaseInsensitive("DOCTYPE")) {
      this.currentDoctypeName.length = 0;
      this.currentDoctypePublic = null;
      this.currentDoctypeSystem = null;
      this.currentDoctypeForceQuirks = false;
      this.state = Tokenizer.DOCTYPE;
      return false;
    }

    if (this._consumeIf("[CDATA[")) {
      // Only valid in foreign content; treat as bogus comment in HTML context.
      this._emitError("cdata-in-html-content");
      this.currentComment.length = 0;
      this.currentComment.push(..."[CDATA[");
      this.state = Tokenizer.BOGUS_COMMENT;
      return false;
    }

    this._emitError("incorrectly-opened-comment");
    this.currentComment.length = 0;
    this.state = Tokenizer.BOGUS_COMMENT;
    return false;
  }

  _stateCommentStart() {
    const replacement = "\ufffd";
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-comment");
      this._emitComment();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === "-") {
      this.state = Tokenizer.COMMENT_START_DASH;
      return false;
    }

    if (c === ">") {
      this._emitError("abrupt-closing-of-empty-comment");
      this._emitComment();
      this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentComment.push(replacement);
    } else {
      this.currentComment.push(c);
    }
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateCommentStartDash() {
    const replacement = "\ufffd";
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-comment");
      this._emitComment();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === "-") {
      this.state = Tokenizer.COMMENT_END;
      return false;
    }

    if (c === ">") {
      this._emitError("abrupt-closing-of-empty-comment");
      this._emitComment();
      this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentComment.push("-", replacement);
    } else {
      this.currentComment.push("-", c);
    }
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateComment() {
    const replacement = "\ufffd";
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-comment");
      this._emitComment();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === "-") {
      this.state = Tokenizer.COMMENT_END_DASH;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentComment.push(replacement);
      return false;
    }

    this.currentComment.push(c);
    return false;
  }

  _stateCommentEndDash() {
    const replacement = "\ufffd";
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-comment");
      this._emitComment();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === "-") {
      this.state = Tokenizer.COMMENT_END;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentComment.push("-", replacement);
      this.state = Tokenizer.COMMENT;
      return false;
    }

    this.currentComment.push("-", c);
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateCommentEnd() {
    const replacement = "\ufffd";
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-comment");
      this._emitComment();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === ">") {
      this._emitComment();
      this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "!") {
      this.state = Tokenizer.COMMENT_END_BANG;
      return false;
    }

    if (c === "-") {
      this.currentComment.push("-");
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentComment.push("-", "-", replacement);
      this.state = Tokenizer.COMMENT;
      return false;
    }

    this._emitError("incorrectly-closed-comment");
    this.currentComment.push("-", "-", c);
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateCommentEndBang() {
    const replacement = "\ufffd";
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-comment");
      this._emitComment();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === "-") {
      this.currentComment.push("-", "-", "!");
      this.state = Tokenizer.COMMENT_END_DASH;
      return false;
    }

    if (c === ">") {
      this._emitError("incorrectly-closed-comment");
      this._emitComment();
      this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentComment.push("-", "-", "!", replacement);
      this.state = Tokenizer.COMMENT;
      return false;
    }

    this.currentComment.push("-", "-", "!", c);
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateBogusComment() {
    const replacement = "\ufffd";
    const c = this._getChar();
    if (c == null) {
      this._emitComment();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === ">") {
      this._emitComment();
      this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "\0") this.currentComment.push(replacement);
    else this.currentComment.push(c);
    return false;
  }

  _stateDoctype() {
    const c = this._getChar();
    if (c == null) {
      this._emitError("eof-in-doctype");
      this.currentDoctypeForceQuirks = true;
      this._emitDoctype();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === "\t" || c === "\n" || c === "\f" || c === " ") {
      this.state = Tokenizer.BEFORE_DOCTYPE_NAME;
      return false;
    }

    if (c === ">") {
      this._emitError("expected-doctype-name-but-got-right-bracket");
      this.currentDoctypeForceQuirks = true;
      this._emitDoctype();
      this.state = Tokenizer.DATA;
      return false;
    }

    this._emitError("missing-whitespace-before-doctype-name");
    this._reconsumeCurrent();
    this.state = Tokenizer.BEFORE_DOCTYPE_NAME;
    return false;
  }

  _stateBeforeDoctypeName() {
    // Skip whitespace
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("eof-in-doctype-name");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") continue;
      if (c === ">") {
        this._emitError("expected-doctype-name-but-got-right-bracket");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      if (c >= "A" && c <= "Z") this.currentDoctypeName.push(String.fromCharCode(c.charCodeAt(0) + 32));
      else if (c === "\0") {
        this._emitError("unexpected-null-character");
        this.currentDoctypeName.push("\ufffd");
      } else {
        this.currentDoctypeName.push(c);
      }
      this.state = Tokenizer.DOCTYPE_NAME;
      return false;
    }
  }

  _stateDoctypeName() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("eof-in-doctype-name");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") {
        this.state = Tokenizer.AFTER_DOCTYPE_NAME;
        return false;
      }
      if (c === ">") {
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      if (c >= "A" && c <= "Z") {
        this.currentDoctypeName.push(String.fromCharCode(c.charCodeAt(0) + 32));
        continue;
      }
      if (c === "\0") {
        this._emitError("unexpected-null-character");
        this.currentDoctypeName.push("\ufffd");
        continue;
      }
      this.currentDoctypeName.push(c);
    }
  }

  _stateAfterDoctypeName() {
    if (this._consumeCaseInsensitive("PUBLIC")) {
      this.state = Tokenizer.AFTER_DOCTYPE_PUBLIC_KEYWORD;
      return false;
    }
    if (this._consumeCaseInsensitive("SYSTEM")) {
      this.state = Tokenizer.AFTER_DOCTYPE_SYSTEM_KEYWORD;
      return false;
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("eof-in-doctype");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") continue;
      if (c === ">") {
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this._emitError("missing-whitespace-after-doctype-name");
      this.currentDoctypeForceQuirks = true;
      this._reconsumeCurrent();
      this.state = Tokenizer.BOGUS_DOCTYPE;
      return false;
    }
  }

  _stateAfterDoctypePublicKeyword() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("missing-quote-before-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") {
        this.state = Tokenizer.BEFORE_DOCTYPE_PUBLIC_IDENTIFIER;
        return false;
      }
      if (c === '"') {
        this._emitError("missing-whitespace-before-doctype-public-identifier");
        this.currentDoctypePublic = [];
        this.state = Tokenizer.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this._emitError("missing-whitespace-before-doctype-public-identifier");
        this.currentDoctypePublic = [];
        this.state = Tokenizer.DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED;
        return false;
      }
      if (c === ">") {
        this._emitError("missing-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this._emitError("unexpected-character-after-doctype-public-keyword");
      this.currentDoctypeForceQuirks = true;
      this._reconsumeCurrent();
      this.state = Tokenizer.BOGUS_DOCTYPE;
      return false;
    }
  }

  _stateAfterDoctypeSystemKeyword() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("missing-quote-before-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") {
        this.state = Tokenizer.BEFORE_DOCTYPE_SYSTEM_IDENTIFIER;
        return false;
      }
      if (c === '"') {
        this._emitError("missing-whitespace-after-doctype-public-identifier");
        this.currentDoctypeSystem = [];
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this._emitError("missing-whitespace-after-doctype-public-identifier");
        this.currentDoctypeSystem = [];
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;
        return false;
      }
      if (c === ">") {
        this._emitError("missing-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this._emitError("unexpected-character-after-doctype-system-keyword");
      this.currentDoctypeForceQuirks = true;
      this._reconsumeCurrent();
      this.state = Tokenizer.BOGUS_DOCTYPE;
      return false;
    }
  }

  _stateBeforeDoctypePublicIdentifier() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("missing-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") continue;
      if (c === '"') {
        this.currentDoctypePublic = [];
        this.state = Tokenizer.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this.currentDoctypePublic = [];
        this.state = Tokenizer.DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED;
        return false;
      }
      if (c === ">") {
        this._emitError("missing-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this._emitError("missing-quote-before-doctype-public-identifier");
      this.currentDoctypeForceQuirks = true;
      this._reconsumeCurrent();
      this.state = Tokenizer.BOGUS_DOCTYPE;
      return false;
    }
  }

  _stateDoctypePublicIdentifierDoubleQuoted() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("eof-in-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === '"') {
        this.state = Tokenizer.AFTER_DOCTYPE_PUBLIC_IDENTIFIER;
        return false;
      }
      if (c === "\0") {
        this._emitError("unexpected-null-character");
        this.currentDoctypePublic.push("\ufffd");
        continue;
      }
      if (c === ">") {
        this._emitError("abrupt-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this.currentDoctypePublic.push(c);
    }
  }

  _stateDoctypePublicIdentifierSingleQuoted() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("eof-in-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "'") {
        this.state = Tokenizer.AFTER_DOCTYPE_PUBLIC_IDENTIFIER;
        return false;
      }
      if (c === "\0") {
        this._emitError("unexpected-null-character");
        this.currentDoctypePublic.push("\ufffd");
        continue;
      }
      if (c === ">") {
        this._emitError("abrupt-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this.currentDoctypePublic.push(c);
    }
  }

  _stateAfterDoctypePublicIdentifier() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("missing-whitespace-between-doctype-public-and-system-identifiers");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") {
        this.state = Tokenizer.BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS;
        return false;
      }
      if (c === ">") {
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      if (c === '"') {
        this._emitError("missing-whitespace-between-doctype-public-and-system-identifiers");
        this.currentDoctypeSystem = [];
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this._emitError("missing-whitespace-between-doctype-public-and-system-identifiers");
        this.currentDoctypeSystem = [];
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;
        return false;
      }
      this._emitError("unexpected-character-after-doctype-public-identifier");
      this.currentDoctypeForceQuirks = true;
      this._reconsumeCurrent();
      this.state = Tokenizer.BOGUS_DOCTYPE;
      return false;
    }
  }

  _stateBetweenDoctypePublicAndSystemIdentifiers() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("missing-quote-before-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") continue;
      if (c === ">") {
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      if (c === '"') {
        this.currentDoctypeSystem = [];
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this.currentDoctypeSystem = [];
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;
        return false;
      }
      this._emitError("missing-quote-before-doctype-system-identifier");
      this.currentDoctypeForceQuirks = true;
      this._reconsumeCurrent();
      this.state = Tokenizer.BOGUS_DOCTYPE;
      return false;
    }
  }

  _stateBeforeDoctypeSystemIdentifier() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("missing-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") continue;
      if (c === '"') {
        this.currentDoctypeSystem = [];
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this.currentDoctypeSystem = [];
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;
        return false;
      }
      if (c === ">") {
        this._emitError("missing-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this._emitError("missing-quote-before-doctype-system-identifier");
      this.currentDoctypeForceQuirks = true;
      this._reconsumeCurrent();
      this.state = Tokenizer.BOGUS_DOCTYPE;
      return false;
    }
  }

  _stateDoctypeSystemIdentifierDoubleQuoted() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("eof-in-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === '"') {
        this.state = Tokenizer.AFTER_DOCTYPE_SYSTEM_IDENTIFIER;
        return false;
      }
      if (c === "\0") {
        this._emitError("unexpected-null-character");
        this.currentDoctypeSystem.push("\ufffd");
        continue;
      }
      if (c === ">") {
        this._emitError("abrupt-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this.currentDoctypeSystem.push(c);
    }
  }

  _stateDoctypeSystemIdentifierSingleQuoted() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("eof-in-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "'") {
        this.state = Tokenizer.AFTER_DOCTYPE_SYSTEM_IDENTIFIER;
        return false;
      }
      if (c === "\0") {
        this._emitError("unexpected-null-character");
        this.currentDoctypeSystem.push("\ufffd");
        continue;
      }
      if (c === ">") {
        this._emitError("abrupt-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this.currentDoctypeSystem.push(c);
    }
  }

  _stateAfterDoctypeSystemIdentifier() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitError("eof-in-doctype");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") continue;
      if (c === ">") {
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this._emitError("unexpected-character-after-doctype-system-identifier");
      this._reconsumeCurrent();
      this.state = Tokenizer.BOGUS_DOCTYPE;
      return false;
    }
  }

  _stateBogusDoctype() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getChar();
      if (c == null) {
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === ">") {
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
    }
  }
}
