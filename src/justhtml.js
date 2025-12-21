import { decodeHTML } from "./encoding.js";
import { parseDocument } from "./parser.js";

export class StrictModeError extends SyntaxError {
  constructor(error) {
    super(error?.message || String(error?.code || "parse-error"));
    this.error = error;
  }
}

export class JustHTML {
  constructor(input, options = {}) {
    const {
      collectErrors = false,
      encoding = null,
      strict = false,
      fragmentContext = null,
      iframeSrcdoc = false,
      tokenizerOpts = null,
    } = options;

    this.encoding = null;
    this.errors = [];
    this.fragmentContext = fragmentContext;

    let html = input;
    if (html == null) html = "";

    if (typeof html === "string") {
      // Already decoded.
    } else if (html instanceof ArrayBuffer) {
      const bytes = new Uint8Array(html);
      const decoded = decodeHTML(bytes, { transportEncoding: encoding });
      this.encoding = decoded.encoding;
      html = decoded.text;
    } else if (html instanceof Uint8Array) {
      const decoded = decodeHTML(html, { transportEncoding: encoding });
      this.encoding = decoded.encoding;
      html = decoded.text;
    } else {
      html = String(html);
    }

    const shouldCollect = Boolean(collectErrors) || Boolean(strict);
    const parsed = parseDocument(html, {
      fragmentContext,
      iframeSrcdoc: Boolean(iframeSrcdoc),
      collectErrors: shouldCollect,
      tokenizerOpts,
    });
    this.root = parsed.root;
    this.errors = parsed.errors;

    this.collectErrors = Boolean(collectErrors);
    this.strict = Boolean(strict);
    this.iframeSrcdoc = Boolean(iframeSrcdoc);

    if (this.strict && this.errors.length) {
      throw new StrictModeError(this.errors[0]);
    }
  }

  toText(options) {
    return this.root.toText(options);
  }

  toHTML(options) {
    return this.root.toHTML(options);
  }

  query(selector) {
    return this.root.query(selector);
  }

  toMarkdown() {
    return this.root.toMarkdown();
  }
}
