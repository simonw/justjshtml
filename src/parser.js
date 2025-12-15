import { Node } from "./node.js";

function isAsciiWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function readTagName(s, start) {
  let i = start;
  while (i < s.length && isAsciiWhitespace(s[i])) i++;
  const nameStart = i;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ">" || ch === "/" || isAsciiWhitespace(ch)) break;
    i++;
  }
  return { name: s.slice(nameStart, i).toLowerCase(), end: i };
}

export function parseDocument(html) {
  const root = new Node("#document", { namespace: null });
  const stack = [root];

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      const text = html.slice(i);
      if (text) stack[stack.length - 1].appendChild(new Node("#text", { data: text, namespace: null }));
      break;
    }

    if (lt > i) {
      const text = html.slice(i, lt);
      if (text) stack[stack.length - 1].appendChild(new Node("#text", { data: text, namespace: null }));
    }

    // We're at '<'
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const data = end === -1 ? html.slice(lt + 4) : html.slice(lt + 4, end);
      stack[stack.length - 1].appendChild(new Node("#comment", { data, namespace: null }));
      i = end === -1 ? html.length : end + 3;
      continue;
    }

    if (html.startsWith("</", lt)) {
      const { name, end } = readTagName(html, lt + 2);
      const gt = html.indexOf(">", end);
      i = gt === -1 ? html.length : gt + 1;
      if (!name) continue;
      if (stack.length > 1 && stack[stack.length - 1].name === name) {
        stack.pop();
      } else {
        // Minimal recovery: pop until we find a match.
        for (let j = stack.length - 1; j >= 1; j--) {
          if (stack[j].name === name) {
            stack.splice(j);
            break;
          }
        }
      }
      continue;
    }

    if (html.startsWith("<!DOCTYPE", lt) || html.startsWith("<!doctype", lt)) {
      const gt = html.indexOf(">", lt + 9);
      i = gt === -1 ? html.length : gt + 1;
      stack[stack.length - 1].appendChild(new Node("!doctype", { data: { name: "html" }, namespace: null }));
      continue;
    }

    // Start tag.
    const { name, end } = readTagName(html, lt + 1);
    const gt = html.indexOf(">", end);
    if (!name) {
      i = gt === -1 ? html.length : gt + 1;
      continue;
    }

    const tagText = gt === -1 ? html.slice(lt) : html.slice(lt, gt + 1);
    const selfClosing = tagText.endsWith("/>");

    const el = new Node(name, { attrs: {}, namespace: "html" });
    stack[stack.length - 1].appendChild(el);
    i = gt === -1 ? html.length : gt + 1;

    if (!selfClosing) stack.push(el);
  }

  return root;
}

