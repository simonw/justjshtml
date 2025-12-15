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
      this.encoding = encoding || "utf-8";
      html = new TextDecoder(this.encoding).decode(new Uint8Array(html));
    } else if (html instanceof Uint8Array) {
      this.encoding = encoding || "utf-8";
      html = new TextDecoder(this.encoding).decode(html);
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

