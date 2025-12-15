export class Node {
  constructor(name, { attrs = null, data = null, namespace = "html" } = {}) {
    this.name = name;
    this.namespace = name.startsWith("#") || name === "!doctype" ? namespace : namespace || "html";
    this.parent = null;
    this.data = data;
    this.attrs = attrs ?? {};
    this.children = [];
  }

  appendChild(node) {
    this.children.push(node);
    node.parent = this;
  }

  get text() {
    if (this.name === "#text") return this.data || "";
    return "";
  }

  toText({ separator = " ", strip = true } = {}) {
    const parts = [];

    const walk = (node) => {
      if (node.name === "#text") {
        let data = node.data ?? "";
        if (strip) data = data.trim();
        if (data) parts.push(data);
        return;
      }
      for (const child of node.children) walk(child);
    };

    walk(this);
    return parts.join(separator);
  }
}

