import { decodeEntitiesInText } from "./entities.js";
import { CharacterToken, CommentToken, Doctype, DoctypeToken, EOFToken, Tag, TokenSinkResult } from "./tokens.js";

function isWhitespace(c) {
  return c === "\t" || c === "\n" || c === "\f" || c === " " || c === "\r";
}

function isAsciiAlpha(c) {
  const code = c.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
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

const RCDATA_ELEMENTS = new Set(["title", "textarea"]);
const RAWTEXT_SWITCH_TAGS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "textarea", "title"]);

// Compact representation of characters that cause state transitions.
// Each entry is a string of characters that trigger a state change for that state.
// null means the state has complex logic (all chars potentially change state).
// These are expanded to lookup tables in the Tokenizer constructor.
const STATE_CHANGE_CHARS = [
  "<",        // DATA (0)
  null,       // TAG_OPEN (1)
  null,       // END_TAG_OPEN (2)
  " />",      // TAG_NAME (3)
  null,       // BEFORE_ATTRIBUTE_NAME (4)
  " /=>",     // ATTRIBUTE_NAME (5)
  null,       // AFTER_ATTRIBUTE_NAME (6)
  null,       // BEFORE_ATTRIBUTE_VALUE (7)
  "\"&",      // ATTRIBUTE_VALUE_DOUBLE (8)
  "'&",       // ATTRIBUTE_VALUE_SINGLE (9)
  " >&",      // ATTRIBUTE_VALUE_UNQUOTED (10)
  null,       // AFTER_ATTRIBUTE_VALUE_QUOTED (11)
  null,       // SELF_CLOSING_START_TAG (12)
  null,       // MARKUP_DECLARATION_OPEN (13)
  null,       // COMMENT_START (14)
  null,       // COMMENT_START_DASH (15)
  "-",        // COMMENT (16)
  null,       // COMMENT_END_DASH (17)
  null,       // COMMENT_END (18)
  null,       // COMMENT_END_BANG (19)
  ">",        // BOGUS_COMMENT (20)
  null,       // DOCTYPE (21)
  null,       // BEFORE_DOCTYPE_NAME (22)
  " >",       // DOCTYPE_NAME (23)
  null,       // AFTER_DOCTYPE_NAME (24)
  ">",        // BOGUS_DOCTYPE (25)
  null,       // AFTER_DOCTYPE_PUBLIC_KEYWORD (26)
  null,       // AFTER_DOCTYPE_SYSTEM_KEYWORD (27)
  null,       // BEFORE_DOCTYPE_PUBLIC_IDENTIFIER (28)
  "\">",      // DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED (29)
  "'>",       // DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED (30)
  null,       // AFTER_DOCTYPE_PUBLIC_IDENTIFIER (31)
  null,       // BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS (32)
  null,       // BEFORE_DOCTYPE_SYSTEM_IDENTIFIER (33)
  "\">",      // DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED (34)
  "'>",       // DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED (35)
  null,       // AFTER_DOCTYPE_SYSTEM_IDENTIFIER (36)
  "]",        // CDATA_SECTION (37)
  null,       // CDATA_SECTION_BRACKET (38)
  null,       // CDATA_SECTION_END (39)
  "<",        // RCDATA (40)
  null,       // RCDATA_LESS_THAN_SIGN (41)
  null,       // RCDATA_END_TAG_OPEN (42)
  null,       // RCDATA_END_TAG_NAME (43)
  "<",        // RAWTEXT (44)
  null,       // RAWTEXT_LESS_THAN_SIGN (45)
  null,       // RAWTEXT_END_TAG_OPEN (46)
  null,       // RAWTEXT_END_TAG_NAME (47)
  "",         // PLAINTEXT (48) - nothing changes state
  null,       // SCRIPT_DATA_ESCAPED (49) - complex NUL handling
  null,       // SCRIPT_DATA_ESCAPED_DASH (50)
  null,       // SCRIPT_DATA_ESCAPED_DASH_DASH (51)
  null,       // SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN (52)
  null,       // SCRIPT_DATA_ESCAPED_END_TAG_OPEN (53)
  null,       // SCRIPT_DATA_ESCAPED_END_TAG_NAME (54)
  null,       // SCRIPT_DATA_DOUBLE_ESCAPE_START (55)
  null,       // SCRIPT_DATA_DOUBLE_ESCAPED (56) - complex NUL handling
  null,       // SCRIPT_DATA_DOUBLE_ESCAPED_DASH (57)
  null,       // SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH (58)
  null,       // SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN (59)
  null,       // SCRIPT_DATA_DOUBLE_ESCAPE_END (60)
];

// Build expanded lookup tables (128 entries for ASCII 0-127).
// true = character causes state change, false = character stays in state.
// Entries 0-31 are always true (control chars always need special handling).
function buildStateTables() {
  const tables = [];
  for (let state = 0; state < STATE_CHANGE_CHARS.length; state++) {
    const chars = STATE_CHANGE_CHARS[state];
    if (chars === null) {
      tables.push(null);
    } else {
      // Create a 128-entry array for ASCII 0-127
      const table = new Array(128).fill(false);
      // Control chars (0-31) always cause state changes
      for (let i = 0; i < 32; i++) table[i] = true;
      for (const c of chars) {
        const code = c.charCodeAt(0);
        if (code < 128) {
          table[code] = true;
        }
      }
      tables.push(table);
    }
  }
  return tables;
}

const STATE_TABLES = buildStateTables();

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
    this.stateTables = STATE_TABLES;

    this.errors = [];

    this.state = Tokenizer.DATA;
    this.buffer = "";
    this.length = 0;
    this.pos = 0;
    this.reconsume = false;
    this.currentChar = null;
    this.ignoreLF = false;

    this.textBuffer = "";
    this.currentTagName = "";
    this.currentTagAttrs = {};
    this.currentAttrName = "";
    this.currentAttrValue = "";
    this.currentAttrValueHasAmp = false;
    this.currentTagSelfClosing = false;
    this.currentTagKind = Tag.START;
    this.currentComment = "";

    this.currentDoctypeName = "";
    this.currentDoctypePublic = null;
    this.currentDoctypeSystem = null;
    this.currentDoctypeForceQuirks = false;

    this.lastStartTagName = null;
    this.rawtextTagName = null;
    this.tempBuffer = "";
    this.originalTagName = "";

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

    this.textBuffer = "";
    this.currentTagName = "";
    this.currentTagAttrs = {};
    this.currentAttrName = "";
    this.currentAttrValue = "";
    this.currentAttrValueHasAmp = false;
    this.currentTagSelfClosing = false;
    this.currentTagKind = Tag.START;
    this.currentComment = "";

    this.currentDoctypeName = "";
    this.currentDoctypePublic = null;
    this.currentDoctypeSystem = null;
    this.currentDoctypeForceQuirks = false;

    this.rawtextTagName = this.opts.initialRawtextTag;
    this.tempBuffer = "";
    this.originalTagName = "";
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
      case Tokenizer.CDATA_SECTION:
        return this._stateCdataSection();
      case Tokenizer.CDATA_SECTION_BRACKET:
        return this._stateCdataSectionBracket();
      case Tokenizer.CDATA_SECTION_END:
        return this._stateCdataSectionEnd();
      case Tokenizer.RCDATA:
        return this._stateRcdata();
      case Tokenizer.RCDATA_LESS_THAN_SIGN:
        return this._stateRcdataLessThanSign();
      case Tokenizer.RCDATA_END_TAG_OPEN:
        return this._stateRcdataEndTagOpen();
      case Tokenizer.RCDATA_END_TAG_NAME:
        return this._stateRcdataEndTagName();
      case Tokenizer.RAWTEXT:
        return this._stateRawtext();
      case Tokenizer.RAWTEXT_LESS_THAN_SIGN:
        return this._stateRawtextLessThanSign();
      case Tokenizer.RAWTEXT_END_TAG_OPEN:
        return this._stateRawtextEndTagOpen();
      case Tokenizer.RAWTEXT_END_TAG_NAME:
        return this._stateRawtextEndTagName();
      case Tokenizer.PLAINTEXT:
        return this._statePlaintext();
      case Tokenizer.SCRIPT_DATA_ESCAPED:
        return this._stateScriptDataEscaped();
      case Tokenizer.SCRIPT_DATA_ESCAPED_DASH:
        return this._stateScriptDataEscapedDash();
      case Tokenizer.SCRIPT_DATA_ESCAPED_DASH_DASH:
        return this._stateScriptDataEscapedDashDash();
      case Tokenizer.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN:
        return this._stateScriptDataEscapedLessThanSign();
      case Tokenizer.SCRIPT_DATA_ESCAPED_END_TAG_OPEN:
        return this._stateScriptDataEscapedEndTagOpen();
      case Tokenizer.SCRIPT_DATA_ESCAPED_END_TAG_NAME:
        return this._stateScriptDataEscapedEndTagName();
      case Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPE_START:
        return this._stateScriptDataDoubleEscapeStart();
      case Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED:
        return this._stateScriptDataDoubleEscaped();
      case Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED_DASH:
        return this._stateScriptDataDoubleEscapedDash();
      case Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH:
        return this._stateScriptDataDoubleEscapedDashDash();
      case Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN:
        return this._stateScriptDataDoubleEscapedLessThanSign();
      case Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPE_END:
        return this._stateScriptDataDoubleEscapeEnd();
      default:
        // Not yet ported; fall back to DATA semantics to keep the runner usable.
        this.state = Tokenizer.DATA;
        return false;
    }
  }

  // Only called after _peekChar confirmed the character - just advance and return it.
  _getChar() {
    return this.buffer[this.pos++];
  }

  _getString() {
    // Handle reconsume - return the previous char
    if (this.reconsume) {
      this.reconsume = false;
      return this.currentChar;
    }

    var c = ""
    while (true) {
      // EOF check
      if (this.pos >= this.length) {
        this.currentChar = null;
        return null;
      }

      c = this.buffer[this.pos];
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
      break;
    }

    // Try to batch multiple characters if state supports it.
    // Control chars 0-31 (including CR/LF) are always state-change chars in the table,
    // so batching will stop before them and they'll be handled on the next call.
    const table = this.stateTables[this.state];
    if (table !== null) {
      const code = c.charCodeAt(0);
      // Only batch if first char is in the "stay" set:
      // - chars >= 128 are always batchable (non-ASCII text)
      // - chars 0-127 use table lookup
      if (code >= 128 || !table[code]) {
        // First char stays in state - try to grab more
        const startPos = this.pos - 1;

        // Scan ahead for more characters that stay in this state
        while (this.pos < this.length) {
          const nextC = this.buffer[this.pos];
          const nextCode = nextC.charCodeAt(0);
          if (nextCode < 128 && table[nextCode]) break;
          this.pos += 1;
        }

        // Return substring if we got multiple chars
        if (this.pos > startPos + 1) {
          const result = this.buffer.substring(startPos, this.pos);
          this.currentChar = result[result.length - 1];
          return result;
        }
      }
    }

    this.currentChar = c;
    return c;
  }

  _reconsumeCurrent() {
    this.reconsume = true;
  }

  _peekChar(offset) {
    const pos = this.pos + offset;
    if (pos < 0 || pos >= this.length) return null;
    return this.buffer[pos];
  }

  _appendText(s) {
    if (s) this.textBuffer += s;
  }

  _flushText() {
    if (!this.textBuffer) return;
    let data = this.textBuffer;
    this.textBuffer = "";

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
    this.currentAttrName = "";
    this.currentAttrValue = "";
    this.currentAttrValueHasAmp = false;
  }

  _finishAttribute() {
    if (!this.currentAttrName) return;
    const name = this.currentAttrName;
    this.currentAttrName = "";

    if (Object.prototype.hasOwnProperty.call(this.currentTagAttrs, name)) {
      this._emitError("duplicate-attribute");
      this.currentAttrValue = "";
      this.currentAttrValueHasAmp = false;
      return;
    }

    let value = this.currentAttrValue;
    this.currentAttrValue = "";

    if (this.currentAttrValueHasAmp) value = decodeEntitiesInText(value, { inAttribute: true });
    this.currentAttrValueHasAmp = false;

    this.currentTagAttrs[name] = value;
  }

  _emitCurrentTag() {
    const name = this.currentTagName;
    const attrs = this.currentTagAttrs;

    const tag = this._tagToken;
    tag.kind = this.currentTagKind;
    tag.name = name;
    tag.attrs = attrs;
    tag.selfClosing = this.currentTagSelfClosing;

    let switchedToRawtext = false;
    if (this.currentTagKind === Tag.START) {
      this.lastStartTagName = name;

      const needsRawtextCheck = RAWTEXT_SWITCH_TAGS.has(name) || name === "plaintext";
      if (needsRawtextCheck) {
        const stack = this.sink.openElements || this.sink.open_elements || [];
        const currentNode = stack.length ? stack[stack.length - 1] : null;
        const namespace = currentNode ? currentNode.namespace : null;

        if (namespace == null || namespace === "html") {
          if (RCDATA_ELEMENTS.has(name)) {
            this.state = Tokenizer.RCDATA;
            this.rawtextTagName = name;
            switchedToRawtext = true;
          } else if (RAWTEXT_SWITCH_TAGS.has(name)) {
            this.state = Tokenizer.RAWTEXT;
            this.rawtextTagName = name;
            switchedToRawtext = true;
          } else {
            this.state = Tokenizer.PLAINTEXT;
            switchedToRawtext = true;
          }
        }
      }
    }

    const result = this.sink.processToken(tag);
    if (result === TokenSinkResult.Plaintext) {
      this.state = Tokenizer.PLAINTEXT;
      switchedToRawtext = true;
    }

    this.currentTagName = "";
    this.currentTagAttrs = {};
    this.currentAttrName = "";
    this.currentAttrValue = "";
    this.currentAttrValueHasAmp = false;
    this.currentTagSelfClosing = false;
    this.currentTagKind = Tag.START;
    return switchedToRawtext;
  }

  _emitComment() {
    let data = this.currentComment;
    this.currentComment = "";
    if (this.opts.xmlCoercion) data = coerceCommentForXML(data);
    this._commentToken.data = data;
    this._emitToken(this._commentToken);
  }

  _emitDoctype() {
    const name = this.currentDoctypeName || null;
    const publicId = this.currentDoctypePublic;
    const systemId = this.currentDoctypeSystem;

    const doctype = new Doctype({
      name,
      publicId,
      systemId,
      forceQuirks: this.currentDoctypeForceQuirks,
    });

    this.currentDoctypeName = "";
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
    const c = this._getString();
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
    const c = this._getString();
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
    const c = this._getString();

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
      this.currentComment = "";
      this._reconsumeCurrent();
      this.state = Tokenizer.BOGUS_COMMENT;
      return false;
    }

    if (isAsciiAlpha(c)) {
      this.currentTagKind = Tag.START;
      this.currentTagName = "";
      this.currentTagName += c.toLowerCase();
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
    const c = this._getString(this.state);

    if (c == null) {
      this._emitError("eof-before-tag-name");
      this._appendText("</");
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }

    if (isAsciiAlpha(c)) {
      this.currentTagKind = Tag.END;
      this.currentTagName = "";
      this.currentTagName += c.toLowerCase();
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
    this.currentComment = "";
    this._reconsumeCurrent();
    this.state = Tokenizer.BOGUS_COMMENT;
    return false;
  }

  _stateTagName() {
    const c = this._getString();
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
      if (!this._emitCurrentTag()) this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentTagName += "\ufffd";
      return false;
    }

    this.currentTagName += c.toLowerCase();
    return false;
  }

  _stateBeforeAttributeName() {
    const c = this._getString();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }

    if (isWhitespace(c)) return false;

    if (c === "/") {
      this.state = Tokenizer.SELF_CLOSING_START_TAG;
      return false;
    }

    if (c === ">") {
      if (!this._emitCurrentTag()) this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "=") {
      this._emitError("unexpected-equals-sign-before-attribute-name");
      this._startNewAttribute();
      this.currentAttrName += "=";
      this.state = Tokenizer.ATTRIBUTE_NAME;
      return false;
    }
    this._startNewAttribute();
    this._reconsumeCurrent();
    this.state = Tokenizer.ATTRIBUTE_NAME;
    return false;
  }

  _stateAttributeName() {
    const c = this._getString();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._flushText();
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
      if (!this._emitCurrentTag()) this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentAttrName += "\ufffd";
      return false;
    }

    this.currentAttrName += c.toLowerCase();
    return false;
  }

  _stateAfterAttributeName() {
    const c = this._getString();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._flushText();
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
      if (!this._emitCurrentTag()) this.state = Tokenizer.DATA;
      return false;
    }

    this._startNewAttribute();
    this._reconsumeCurrent();
    this.state = Tokenizer.ATTRIBUTE_NAME;
    return false;
  }

  _stateBeforeAttributeValue() {
    const c = this._getString();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._flushText();
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
      if (!this._emitCurrentTag()) this.state = Tokenizer.DATA;
      return false;
    }

    this._reconsumeCurrent();
    this.state = Tokenizer.ATTRIBUTE_VALUE_UNQUOTED;
    return false;
  }

  _stateAttributeValueDouble() {
    const c = this._getString();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._flushText();
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
      this.currentAttrValue += "\ufffd";
      return false;
    }
    this.currentAttrValue += c;
    return false;
  }

  _stateAttributeValueSingle() {
    const c = this._getString();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._flushText();
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
      this.currentAttrValue += "\ufffd";
      return false;
    }
    this.currentAttrValue += c;
    return false;
  }

  _stateAttributeValueUnquoted() {
    const c = this._getString();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._flushText();
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
      if (!this._emitCurrentTag()) this.state = Tokenizer.DATA;
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentAttrValue += "\ufffd";
      return false;
    }
    this.currentAttrValue += c;
    return false;
  }

  _stateAfterAttributeValueQuoted() {
    const c = this._getString();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._flushText();
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
      if (!this._emitCurrentTag()) this.state = Tokenizer.DATA;
      return false;
    }

    this._emitError("missing-whitespace-between-attributes");
    this._reconsumeCurrent();
    this.state = Tokenizer.BEFORE_ATTRIBUTE_NAME;
    return false;
  }

  _stateSelfClosingStartTag() {
    const c = this._getString();
    if (c == null) {
      this._emitError("eof-in-tag");
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === ">") {
      this.currentTagSelfClosing = true;
      if (!this._emitCurrentTag()) this.state = Tokenizer.DATA;
      return false;
    }

    this._emitError("unexpected-character-after-solidus-in-tag");
    this._reconsumeCurrent();
    this.state = Tokenizer.BEFORE_ATTRIBUTE_NAME;
    return false;
  }

  _stateMarkupDeclarationOpen() {
    if (this._consumeIf("--")) {
      this.currentComment = "";
      this.state = Tokenizer.COMMENT_START;
      return false;
    }

    if (this._consumeCaseInsensitive("DOCTYPE")) {
      this.currentDoctypeName = "";
      this.currentDoctypePublic = null;
      this.currentDoctypeSystem = null;
      this.currentDoctypeForceQuirks = false;
      this.state = Tokenizer.DOCTYPE;
      return false;
    }

    if (this._consumeIf("[CDATA[")) {
      // CDATA sections are only valid in foreign content (SVG/MathML).
      // Tokenizer consults the current treebuilder stack to decide.
      const stack = this.sink?.open_elements;
      if (Array.isArray(stack) && stack.length) {
        const current = stack[stack.length - 1];
        const ns = current?.namespace ?? null;
        if (ns && ns !== "html") {
          this.state = Tokenizer.CDATA_SECTION;
          return false;
        }
      }

      // Treat as bogus comment in HTML context, preserving "[CDATA[" prefix.
      this._emitError("cdata-in-html-content");
      this.currentComment = "";
      this.currentComment += "[CDATA[";
      this.state = Tokenizer.BOGUS_COMMENT;
      return false;
    }

    this._emitError("incorrectly-opened-comment");
    this.currentComment = "";
    this.state = Tokenizer.BOGUS_COMMENT;
    return false;
  }

  _stateCommentStart() {
    const replacement = "\ufffd";
    const c = this._getString();
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
      this.currentComment += replacement;
    } else {
      this.currentComment += c;
    }
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateCommentStartDash() {
    const replacement = "\ufffd";
    const c = this._getString(this.state);
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
      this.currentComment += "-" + replacement;
    } else {
      this.currentComment += "-" + c;
    }
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateComment() {
    const replacement = "\ufffd";
    const c = this._getString(this.state);
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
      this.currentComment += replacement;
      this.state = Tokenizer.COMMENT;
      return false;
    }

    this.currentComment += c;
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateCommentEndDash() {
    const replacement = "\ufffd";
    const c = this._getString();
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
      this.currentComment += "-" + replacement;
      this.state = Tokenizer.COMMENT;
      return false;
    }

    this.currentComment += "-" + c;
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateCommentEnd() {
    const replacement = "\ufffd";
    const c = this._getString();
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
      this.currentComment += "-";
      return false;
    }

    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this.currentComment += "--" + replacement;
      this.state = Tokenizer.COMMENT;
      return false;
    }

    this._emitError("incorrectly-closed-comment");
    this.currentComment += "--" + c;
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateCommentEndBang() {
    const replacement = "\ufffd";
    const c = this._getString();
    if (c == null) {
      this._emitError("eof-in-comment");
      this._emitComment();
      this._emitToken(new EOFToken());
      return true;
    }

    if (c === "-") {
      this.currentComment += "--!";
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
      this.currentComment += "--!" + replacement;
      this.state = Tokenizer.COMMENT;
      return false;
    }

    this.currentComment += "--!" + c;
    this.state = Tokenizer.COMMENT;
    return false;
  }

  _stateBogusComment() {
    const replacement = "\ufffd";
    const c = this._getString();
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

    if (c === "\0") this.currentComment += replacement;
    else this.currentComment += c;
    return false;
  }

  _stateDoctype() {
    const c = this._getString();
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
      const c = this._getString(this.state);
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
      if (c === "\0") {
        this._emitError("unexpected-null-character");
        this.currentDoctypeName += "\ufffd";
      } else {
        this.currentDoctypeName += c.toLowerCase();
      }
      this.state = Tokenizer.DOCTYPE_NAME;
      return false;
    }
  }

  _stateDoctypeName() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getString(this.state);
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
      if (c === "\0") {
        this._emitError("unexpected-null-character");
        this.currentDoctypeName += "\ufffd";
        continue;
      }
      this.currentDoctypeName += c.toLowerCase();
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
      const c = this._getString(this.state);
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
      const c = this._getString(this.state);
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
        this.currentDoctypePublic = "";
        this.state = Tokenizer.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this._emitError("missing-whitespace-before-doctype-public-identifier");
        this.currentDoctypePublic = "";
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
      const c = this._getString();
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
        this.currentDoctypeSystem = "";
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this._emitError("missing-whitespace-after-doctype-public-identifier");
        this.currentDoctypeSystem = "";
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
      const c = this._getString();
      if (c == null) {
        this._emitError("missing-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") continue;
      if (c === '"') {
        this.currentDoctypePublic = "";
        this.state = Tokenizer.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this.currentDoctypePublic = "";
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
      const c = this._getString();
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
        this.currentDoctypePublic += "\ufffd";
        continue;
      }
      if (c === ">") {
        this._emitError("abrupt-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this.currentDoctypePublic += c;
    }
  }

  _stateDoctypePublicIdentifierSingleQuoted() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getString();
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
        this.currentDoctypePublic += "\ufffd";
        continue;
      }
      if (c === ">") {
        this._emitError("abrupt-doctype-public-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this.currentDoctypePublic += c;
    }
  }

  _stateAfterDoctypePublicIdentifier() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getString();
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
        this.currentDoctypeSystem = "";
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this._emitError("missing-whitespace-between-doctype-public-and-system-identifiers");
        this.currentDoctypeSystem = "";
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
      const c = this._getString();
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
        this.currentDoctypeSystem = "";
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this.currentDoctypeSystem = "";
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
      const c = this._getString();
      if (c == null) {
        this._emitError("missing-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "\t" || c === "\n" || c === "\f" || c === " ") continue;
      if (c === '"') {
        this.currentDoctypeSystem = "";
        this.state = Tokenizer.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
        return false;
      }
      if (c === "'") {
        this.currentDoctypeSystem = "";
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
      const c = this._getString();
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
        this.currentDoctypeSystem += "\ufffd";
        continue;
      }
      if (c === ">") {
        this._emitError("abrupt-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this.currentDoctypeSystem += c;
    }
  }

  _stateDoctypeSystemIdentifierSingleQuoted() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getString();
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
        this.currentDoctypeSystem += "\ufffd";
        continue;
      }
      if (c === ">") {
        this._emitError("abrupt-doctype-system-identifier");
        this.currentDoctypeForceQuirks = true;
        this._emitDoctype();
        this.state = Tokenizer.DATA;
        return false;
      }
      this.currentDoctypeSystem += c;
    }
  }

  _stateAfterDoctypeSystemIdentifier() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getString();
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
      const c = this._getString(this.state);
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

  _stateCdataSection() {
    // Consume characters until we see ']'.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getString();
      if (c == null) {
        this._emitError("eof-in-cdata");
        this._flushText();
        this._emitToken(new EOFToken());
        return true;
      }
      if (c === "]") {
        this.state = Tokenizer.CDATA_SECTION_BRACKET;
        return false;
      }
      this._appendText(c);
    }
  }

  _stateCdataSectionBracket() {
    const c = this._getString();
    if (c === "]") {
      this.state = Tokenizer.CDATA_SECTION_END;
      return false;
    }

    this._appendText("]");
    if (c == null) {
      this._emitError("eof-in-cdata");
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }
    this._reconsumeCurrent();
    this.state = Tokenizer.CDATA_SECTION;
    return false;
  }

  _stateCdataSectionEnd() {
    const c = this._getString();
    if (c === ">") {
      this._flushText();
      this.state = Tokenizer.DATA;
      return false;
    }

    this._appendText("]");
    if (c == null) {
      this._appendText("]");
      this._emitError("eof-in-cdata");
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }
    if (c === "]") {
      return false;
    }
    this._appendText("]");
    this._reconsumeCurrent();
    this.state = Tokenizer.CDATA_SECTION;
    return false;
  }

  _stateRcdata() {
    const c = this._getString();
    if (c == null) {
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }
    if (c === "<") {
      this.state = Tokenizer.RCDATA_LESS_THAN_SIGN;
      return false;
    }
    if (c === "&") {
      this._appendText("&");
      return false;
    }
    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this._appendText("\ufffd");
      return false;
    }
    this._appendText(c);
    return false;
  }

  _stateRcdataLessThanSign() {
    const c = this._getString();
    if (c === "/") {
      this.currentTagName = "";
      this.originalTagName = "";
      this.state = Tokenizer.RCDATA_END_TAG_OPEN;
      return false;
    }
    this._appendText("<");
    this._reconsumeCurrent();
    this.state = Tokenizer.RCDATA;
    return false;
  }

  _stateRcdataEndTagOpen() {
    const c = this._getString();
    if (c != null && isAsciiAlpha(c)) {
      this.currentTagName += c.toLowerCase();
      this.originalTagName += c;
      this.state = Tokenizer.RCDATA_END_TAG_NAME;
      return false;
    }
    this.textBuffer += "</";
    this._reconsumeCurrent();
    this.state = Tokenizer.RCDATA;
    return false;
  }

  _stateRcdataEndTagName() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getString();
      if (c != null && isAsciiAlpha(c)) {
        this.currentTagName += c.toLowerCase();
        this.originalTagName += c;
        continue;
      }

      const tagName = this.currentTagName;
      if (tagName === this.rawtextTagName) {
        if (c === ">") {
          this._flushText();
          this._emitToken(new Tag(Tag.END, tagName, {}, false));
          this.rawtextTagName = null;
          this.currentTagName = "";
          this.originalTagName = "";
          this.state = Tokenizer.DATA;
          return false;
        }
        if (isWhitespace(c)) {
          this._flushText();
          this.currentTagKind = Tag.END;
          this.currentTagAttrs = {};
          this.state = Tokenizer.BEFORE_ATTRIBUTE_NAME;
          return false;
        }
        if (c === "/") {
          this._flushText();
          this.currentTagKind = Tag.END;
          this.currentTagAttrs = {};
          this.state = Tokenizer.SELF_CLOSING_START_TAG;
          return false;
        }
      }

      if (c == null) {
        this.textBuffer += "</";
        for (const ch of this.originalTagName) this._appendText(ch);
        this.currentTagName = "";
        this.originalTagName = "";
        this._flushText();
        this._emitToken(new EOFToken());
        return true;
      }

      this.textBuffer += "</";
      for (const ch of this.originalTagName) this._appendText(ch);
      this.currentTagName = "";
      this.originalTagName = "";
      this._reconsumeCurrent();
      this.state = Tokenizer.RCDATA;
      return false;
    }
  }

  _stateRawtext() {
    const c = this._getString(this.state);
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
    if (c === "<") {
      if (this.rawtextTagName === "script") {
        const next1 = this._peekChar(0);
        const next2 = this._peekChar(1);
        const next3 = this._peekChar(2);
        if (next1 === "!" && next2 === "-" && next3 === "-") {
          this.textBuffer += "<!--";
          this._getChar();
          this._getChar();
          this._getChar();
          this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
          return false;
        }
      }
      this.state = Tokenizer.RAWTEXT_LESS_THAN_SIGN;
      return false;
    }
    this._appendText(c);
    this.state = Tokenizer.RAWTEXT;
    return false;
  }

  _stateRawtextLessThanSign() {
    const c = this._getString();
    if (c === "/") {
      this.currentTagName = "";
      this.originalTagName = "";
      this.state = Tokenizer.RAWTEXT_END_TAG_OPEN;
      return false;
    }
    this._appendText("<");
    this._reconsumeCurrent();
    this.state = Tokenizer.RAWTEXT;
    return false;
  }

  _stateRawtextEndTagOpen() {
    const c = this._getString();
    if (c != null && isAsciiAlpha(c)) {
      this.currentTagName += c.toLowerCase();
      this.originalTagName += c;
      this.state = Tokenizer.RAWTEXT_END_TAG_NAME;
      return false;
    }
    this.textBuffer += "</";
    this._reconsumeCurrent();
    this.state = Tokenizer.RAWTEXT;
    return false;
  }

  _stateRawtextEndTagName() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const c = this._getString();
      if (c != null && isAsciiAlpha(c)) {
        this.currentTagName += c.toLowerCase();
        this.originalTagName += c;
        continue;
      }

      const tagName = this.currentTagName;
      if (tagName === this.rawtextTagName) {
        if (c === ">") {
          this._flushText();
          this._emitToken(new Tag(Tag.END, tagName, {}, false));
          this.rawtextTagName = null;
          this.currentTagName = "";
          this.originalTagName = "";
          this.state = Tokenizer.DATA;
          return false;
        }
        if (isWhitespace(c)) {
          this._flushText();
          this.currentTagKind = Tag.END;
          this.currentTagAttrs = {};
          this.state = Tokenizer.BEFORE_ATTRIBUTE_NAME;
          return false;
        }
        if (c === "/") {
          this._flushText();
          this.currentTagKind = Tag.END;
          this.currentTagAttrs = {};
          this.state = Tokenizer.SELF_CLOSING_START_TAG;
          return false;
        }
      }

      if (c == null) {
        this.textBuffer += "</";
        for (const ch of this.originalTagName) this._appendText(ch);
        this.currentTagName = "";
        this.originalTagName = "";
        this._flushText();
        this._emitToken(new EOFToken());
        return true;
      }

      this.textBuffer += "</";
      for (const ch of this.originalTagName) this._appendText(ch);
      this.currentTagName = "";
      this.originalTagName = "";
      this._reconsumeCurrent();
      this.state = Tokenizer.RAWTEXT;
      return false;
    }
  }

  _stateScriptDataEscaped() {
    const c = this._getString();
    if (c == null) {
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }
    if (c === "-") {
      this._appendText("-");
      this.state = Tokenizer.SCRIPT_DATA_ESCAPED_DASH;
      return false;
    }
    if (c === "<") {
      this.state = Tokenizer.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN;
      return false;
    }
    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this._appendText("\ufffd");
      return false;
    }
    this._appendText(c);
    return false;
  }

  _stateScriptDataEscapedDash() {
    const c = this._getString();
    if (c == null) {
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }
    if (c === "-") {
      this._appendText("-");
      this.state = Tokenizer.SCRIPT_DATA_ESCAPED_DASH_DASH;
      return false;
    }
    if (c === "<") {
      this.state = Tokenizer.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN;
      return false;
    }
    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this._appendText("\ufffd");
      this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
      return false;
    }
    this._appendText(c);
    this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
    return false;
  }

  _stateScriptDataEscapedDashDash() {
    const c = this._getString();
    if (c == null) {
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }
    if (c === "-") {
      this._appendText("-");
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH;
      return false;
    }
    if (c === "<") {
      this._appendText("<");
      this.state = Tokenizer.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN;
      return false;
    }
    if (c === ">") {
      this._appendText(">");
      this.state = Tokenizer.RAWTEXT;
      return false;
    }
    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this._appendText("\ufffd");
      this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
      return false;
    }
    this._appendText(c);
    this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
    return false;
  }

  _stateScriptDataEscapedLessThanSign() {
    const c = this._getString();
    if (c === "/") {
      this.tempBuffer = "";
      this.state = Tokenizer.SCRIPT_DATA_ESCAPED_END_TAG_OPEN;
      return false;
    }
    if (c != null && isAsciiAlpha(c)) {
      this.tempBuffer = "";
      this._appendText("<");
      this._reconsumeCurrent();
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPE_START;
      return false;
    }
    this._appendText("<");
    this._reconsumeCurrent();
    this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
    return false;
  }

  _stateScriptDataEscapedEndTagOpen() {
    const c = this._getString();
    if (c != null && isAsciiAlpha(c)) {
      this.currentTagName = "";
      this.originalTagName = "";
      this._reconsumeCurrent();
      this.state = Tokenizer.SCRIPT_DATA_ESCAPED_END_TAG_NAME;
      return false;
    }
    this.textBuffer += "</";
    this._reconsumeCurrent();
    this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
    return false;
  }

  _stateScriptDataEscapedEndTagName() {
    const c = this._getString();
    if (c != null && isAsciiAlpha(c)) {
      this.currentTagName += c.toLowerCase();
      this.originalTagName += c;
      this.tempBuffer += c;
      return false;
    }

    const tagName = this.currentTagName;
    const isAppropriate = tagName === this.rawtextTagName;

    if (isAppropriate) {
      if (isWhitespace(c)) {
        this._flushText();
        this.currentTagKind = Tag.END;
        this.currentTagAttrs = {};
        this.state = Tokenizer.BEFORE_ATTRIBUTE_NAME;
        return false;
      }
      if (c === "/") {
        this._flushText();
        this.currentTagKind = Tag.END;
        this.currentTagAttrs = {};
        this.state = Tokenizer.SELF_CLOSING_START_TAG;
        return false;
      }
      if (c === ">") {
        this._flushText();
        this._emitToken(new Tag(Tag.END, tagName, {}, false));
        this.rawtextTagName = null;
        this.currentTagName = "";
        this.originalTagName = "";
        this.tempBuffer = "";
        this.state = Tokenizer.DATA;
        return false;
      }
    }

    this.textBuffer += "</";
    for (const ch of this.tempBuffer) this._appendText(ch);
    this.currentTagName = "";
    this.originalTagName = "";
    this.tempBuffer = "";
    this._reconsumeCurrent();
    this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
    return false;
  }

  _stateScriptDataDoubleEscapeStart() {
    const c = this._getString();
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "/" || c === ">") {
      const temp = this.tempBuffer.toLowerCase();
      this._appendText(c);
      if (temp === "script") {
        this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED;
        return false;
      } else {
        this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
        return false;
      }
    }
    if (c != null && isAsciiAlpha(c)) {
      this.tempBuffer += c;
      this._appendText(c);
      return false;
    }
    this._reconsumeCurrent();
    this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
    return false;
  }

  _stateScriptDataDoubleEscaped() {
    const c = this._getString();
    if (c == null) {
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }
    if (c === "-") {
      this._appendText("-");
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED_DASH;
      return false;
    }
    if (c === "<") {
      this._appendText("<");
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN;
      return false;
    }
    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this._appendText("\ufffd");
      return false;
    }
    this._appendText(c);
    return false;
  }

  _stateScriptDataDoubleEscapedDash() {
    const c = this._getString();
    if (c == null) {
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }
    if (c === "-") {
      this._appendText("-");
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH;
      return false;
    }
    if (c === "<") {
      this._appendText("<");
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN;
      return false;
    }
    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this._appendText("\ufffd");
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED;
      return false;
    }
    this._appendText(c);
    this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED;
    return false;
  }

  _stateScriptDataDoubleEscapedDashDash() {
    const c = this._getString();
    if (c == null) {
      this._flushText();
      this._emitToken(new EOFToken());
      return true;
    }
    if (c === "-") {
      this._appendText("-");
      return false;
    }
    if (c === "<") {
      this._appendText("<");
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN;
      return false;
    }
    if (c === ">") {
      this._appendText(">");
      this.state = Tokenizer.RAWTEXT;
      return false;
    }
    if (c === "\0") {
      this._emitError("unexpected-null-character");
      this._appendText("\ufffd");
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED;
      return false;
    }
    this._appendText(c);
    this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED;
    return false;
  }

  _stateScriptDataDoubleEscapedLessThanSign() {
    const c = this._getString();
    if (c === "/") {
      this.tempBuffer = "";
      this._appendText("/");
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPE_END;
      return false;
    }
    if (c != null && isAsciiAlpha(c)) {
      this.tempBuffer = "";
      this._reconsumeCurrent();
      this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPE_START;
      return false;
    }
    this._reconsumeCurrent();
    this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED;
    return false;
  }

  _stateScriptDataDoubleEscapeEnd() {
    const c = this._getString();
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "/" || c === ">") {
      const temp = this.tempBuffer.toLowerCase();
      this._appendText(c);
      // No tail call: next state depends on runtime condition
      if (temp === "script") {
        this.state = Tokenizer.SCRIPT_DATA_ESCAPED;
        return false;
      } else {
        this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED;
        return false;
      }
    }
    if (c != null && isAsciiAlpha(c)) {
      this.tempBuffer += c;
      this._appendText(c);
      return false;
    }
    this._reconsumeCurrent();
    this.state = Tokenizer.SCRIPT_DATA_DOUBLE_ESCAPED;
    return false;
  }
}
