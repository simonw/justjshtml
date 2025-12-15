import { decodeHTML } from "./encoding.js";
import { parseDocument } from "./parser.js";

export class JustHTML {
  constructor(input, options = {}) {
    const { collectErrors = false, encoding = null, strict = false } = options;

    this.encoding = null;
    this.errors = [];

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

    this.root = parseDocument(html);

    // Placeholders for later milestones.
    this.collectErrors = Boolean(collectErrors);
    this.strict = Boolean(strict);
  }

  toText(options) {
    return this.root.toText(options);
  }
}
