import { toHTML } from "./serialize.js";

function markdownEscapeText(s) {
  if (!s) return "";
  const out = [];
  for (const ch of String(s)) {
    if ("\\`*_[]".includes(ch)) out.push("\\");
    out.push(ch);
  }
  return out.join("");
}

function markdownCodeSpan(s) {
  if (s == null) s = "";
  const text = String(s);

  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }

  const fence = "`".repeat(longest + 1);
  const needsSpace = text.startsWith("`") || text.endsWith("`");
  if (needsSpace) return `${fence} ${text} ${fence}`;
  return `${fence}${text}${fence}`;
}

class MarkdownBuilder {
  constructor() {
    this._buf = [];
    this._newlineCount = 0;
    this._pendingSpace = false;
  }

  _rstripLastSegment() {
    if (!this._buf.length) return;
    const last = this._buf[this._buf.length - 1];
    const stripped = last.replace(/[ \t]+$/, "");
    if (stripped !== last) this._buf[this._buf.length - 1] = stripped;
  }

  newline(count = 1) {
    for (let i = 0; i < count; i += 1) {
      this._pendingSpace = false;
      this._rstripLastSegment();
      this._buf.push("\n");
      if (this._newlineCount < 2) this._newlineCount += 1;
    }
  }

  ensureNewlines(count) {
    while (this._newlineCount < count) this.newline(1);
  }

  raw(s) {
    if (!s) return;
    const text = String(s);

    if (this._pendingSpace) {
      const first = text[0];
      if (!" \t\n\r\f".includes(first) && this._buf.length && this._newlineCount === 0) {
        this._buf.push(" ");
      }
      this._pendingSpace = false;
    }

    this._buf.push(text);

    if (text.includes("\n")) {
      let trailing = 0;
      for (let i = text.length - 1; i >= 0 && text[i] === "\n"; i -= 1) trailing += 1;
      this._newlineCount = Math.min(2, trailing);
      if (trailing) this._pendingSpace = false;
    } else {
      this._newlineCount = 0;
    }
  }

  text(s, preserveWhitespace = false) {
    if (!s) return;
    const text = String(s);

    if (preserveWhitespace) {
      this.raw(text);
      return;
    }

    for (const ch of text) {
      if (" \t\n\r\f".includes(ch)) {
        this._pendingSpace = true;
        continue;
      }

      if (this._pendingSpace) {
        if (this._buf.length && this._newlineCount === 0) this._buf.push(" ");
        this._pendingSpace = false;
      }

      this._buf.push(ch);
      this._newlineCount = 0;
    }
  }

  finish() {
    const out = this._buf.join("");
    return out.replace(/^[ \t\n]+/, "").replace(/[ \t\n]+$/, "");
  }
}

const MARKDOWN_BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
]);

function toMarkdownWalk(node, builder, preserveWhitespace, listDepth) {
  const name = node?.name;

  if (name === "#text") {
    if (preserveWhitespace) builder.raw(node.data || "");
    else builder.text(markdownEscapeText(node.data || ""), false);
    return;
  }

  if (name === "br") {
    builder.newline(1);
    return;
  }

  if (name === "#comment" || name === "!doctype") return;

  if (typeof name === "string" && name.startsWith("#")) {
    for (const child of node.children || []) toMarkdownWalk(child, builder, preserveWhitespace, listDepth);
    return;
  }

  const tag = String(name || "").toLowerCase();

  if (tag === "img") {
    builder.raw(toHTML(node, { indent: 0, indentSize: 2, pretty: false }));
    return;
  }

  if (tag === "table") {
    builder.ensureNewlines(builder._buf.length ? 2 : 0);
    builder.raw(toHTML(node, { indent: 0, indentSize: 2, pretty: false }));
    builder.ensureNewlines(2);
    return;
  }

  if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {
    builder.ensureNewlines(builder._buf.length ? 2 : 0);
    const level = Number.parseInt(tag[1], 10);
    builder.raw("#".repeat(level));
    builder.raw(" ");
    for (const child of node.children || []) toMarkdownWalk(child, builder, false, listDepth);
    builder.ensureNewlines(2);
    return;
  }

  if (tag === "hr") {
    builder.ensureNewlines(builder._buf.length ? 2 : 0);
    builder.raw("---");
    builder.ensureNewlines(2);
    return;
  }

  if (tag === "pre") {
    builder.ensureNewlines(builder._buf.length ? 2 : 0);
    let code = node.toText({ separator: "", strip: false });
    builder.raw("```");
    builder.newline(1);
    if (code) {
      code = code.replace(/\n+$/, "");
      builder.raw(code);
      builder.newline(1);
    }
    builder.raw("```");
    builder.ensureNewlines(2);
    return;
  }

  if (tag === "code" && !preserveWhitespace) {
    const code = node.toText({ separator: "", strip: false });
    builder.raw(markdownCodeSpan(code));
    return;
  }

  if (tag === "p") {
    builder.ensureNewlines(builder._buf.length ? 2 : 0);
    for (const child of node.children || []) toMarkdownWalk(child, builder, false, listDepth);
    builder.ensureNewlines(2);
    return;
  }

  if (tag === "blockquote") {
    builder.ensureNewlines(builder._buf.length ? 2 : 0);
    const inner = new MarkdownBuilder();
    for (const child of node.children || []) toMarkdownWalk(child, inner, false, listDepth);
    const text = inner.finish();
    if (text) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (i) builder.newline(1);
        builder.raw("> ");
        builder.raw(lines[i]);
      }
    }
    builder.ensureNewlines(2);
    return;
  }

  if (tag === "ul" || tag === "ol") {
    builder.ensureNewlines(builder._buf.length ? 2 : 0);
    const ordered = tag === "ol";
    let idx = 1;
    for (const child of node.children || []) {
      if (String(child?.name || "").toLowerCase() !== "li") continue;
      if (idx > 1) builder.newline(1);
      const indent = "  ".repeat(listDepth);
      const marker = ordered ? `${idx}. ` : "- ";
      builder.raw(indent);
      builder.raw(marker);
      for (const liChild of child.children || []) toMarkdownWalk(liChild, builder, false, listDepth + 1);
      idx += 1;
    }
    builder.ensureNewlines(2);
    return;
  }

  if (tag === "em" || tag === "i") {
    builder.raw("*");
    for (const child of node.children || []) toMarkdownWalk(child, builder, false, listDepth);
    builder.raw("*");
    return;
  }

  if (tag === "strong" || tag === "b") {
    builder.raw("**");
    for (const child of node.children || []) toMarkdownWalk(child, builder, false, listDepth);
    builder.raw("**");
    return;
  }


  // Helper to check if a node contains block elements (deep walk)
  function containsBlockElement(node) {
    if (!node || !node.name) return false;
    if (MARKDOWN_BLOCK_ELEMENTS.has(node.name)) return true;
    return (node.children || []).some(containsBlockElement);
  }

  if (tag === "a") {
    let href = "";
    let title = "";
    const attrs = node.attrs || {};
    if (Object.prototype.hasOwnProperty.call(attrs, "href") && attrs.href != null) href = String(attrs.href);
    if (Object.prototype.hasOwnProperty.call(attrs, "title") && attrs.title != null) title = String(attrs.title);
    
    // Split children into inline and block parts
    const inlineChildren = [];
    const blockChildren = [];
    
    for (const child of node.children || []) {
      if (containsBlockElement(child)) blockChildren.push(child);
      else inlineChildren.push(child);
    }
    
    // Render markdown link for inline children only
    if (inlineChildren.length > 0) {
      builder.raw("[");
      for (const child of inlineChildren) toMarkdownWalk(child, builder, false, listDepth);
      builder.raw("]");
      if (href) {
        builder.raw("(");
        builder.raw(href);
        if (title) {
          // escape backslashes, quotes, and newlines
          const escapedTitle = title
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\n/g, " ");
          builder.raw(" \"");
          builder.raw(escapedTitle);
          builder.raw("\"");
        }
        builder.raw(")");
      }
    }
    
    // Render block children separately (breaks the link)
    for (const child of blockChildren) {
      builder.ensureNewlines(2);
      toMarkdownWalk(child, builder, false, listDepth);
    }
    
    return;
  }

  const nextPreserve = preserveWhitespace || tag === "textarea" || tag === "script" || tag === "style";
  for (const child of node.children || []) toMarkdownWalk(child, builder, nextPreserve, listDepth);

  const templateContent = node.templateContent ?? node.template_content ?? null;
  if (templateContent) toMarkdownWalk(templateContent, builder, nextPreserve, listDepth);

  if (MARKDOWN_BLOCK_ELEMENTS.has(tag)) builder.ensureNewlines(2);
}

export function toMarkdown(node) {
  const builder = new MarkdownBuilder();
  toMarkdownWalk(node, builder, false, 0);
  return builder.finish();
}
