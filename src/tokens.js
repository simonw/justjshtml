import { getTagId, TagId } from "./tag_id.js";

export class Tag {
  static START = 0;
  static END = 1;

  constructor(kind, name, attrs, selfClosing = false, tagId = undefined) {
    this.kind = kind;
    this.name = name;
    this.attrs = attrs ?? {};
    this.selfClosing = Boolean(selfClosing);
    // Compute tagId lazily or use provided value
    this.tagId = tagId !== undefined ? tagId : getTagId(name);
  }
}

// Reprocess result - replaces ["reprocess", mode, token, forceHtml] arrays
export class Reprocess {
  constructor(mode, token, forceHtml = false) {
    this.mode = mode;
    this.token = token;
    this.forceHtml = forceHtml;
  }
}

// Export TagId for convenience
export { TagId };

export class CharacterToken {
  constructor(data) {
    this.data = data;
  }
}

export class CommentToken {
  constructor(data) {
    this.data = data;
  }
}

export class Doctype {
  constructor({ name = null, publicId = null, systemId = null, forceQuirks = false } = {}) {
    this.name = name;
    this.publicId = publicId;
    this.systemId = systemId;
    this.forceQuirks = Boolean(forceQuirks);
  }
}

export class DoctypeToken {
  constructor(doctype) {
    this.doctype = doctype;
  }
}

export class EOFToken {}

export class TokenSinkResult {
  static Continue = 0;
  static Plaintext = 1;
}

export class ParseError {
  constructor(code, { line = null, column = null, message = null } = {}) {
    this.code = code;
    this.line = line;
    this.column = column;
    this.message = message || code;
  }

  toString() {
    if (this.line != null && this.column != null) return `(${this.line},${this.column}): ${this.code}`;
    return this.code;
  }
}

