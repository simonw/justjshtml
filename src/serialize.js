import { Doctype } from "./tokens.js";

// Mirrors justhtml.serialize.to_test_format.

function qualifiedName(node) {
  const ns = node.namespace ?? null;
  if (ns && ns !== "html") return `${ns} ${node.name}`;
  return node.name;
}

function doctypeToTestFormat(node) {
  const doctype = node.data;
  if (!(doctype instanceof Doctype)) return "| <!DOCTYPE >";

  const name = doctype.name || "";
  const publicId = doctype.publicId;
  const systemId = doctype.systemId;

  const parts = ["| <!DOCTYPE"];
  if (name) parts.push(` ${name}`);
  else parts.push(" ");

  if (publicId != null || systemId != null) {
    const pub = publicId != null ? publicId : "";
    const sys = systemId != null ? systemId : "";
    parts.push(` "${pub}"`);
    parts.push(` "${sys}"`);
  }

  parts.push(">");
  return parts.join("");
}

function attrsToTestFormat(node, indent, { foreignAttributeAdjustments = null } = {}) {
  const attrs = node.attrs || {};
  const keys = Object.keys(attrs);
  if (!keys.length) return [];

  const padding = " ".repeat(indent + 2);
  const namespace = node.namespace ?? null;

  const displayAttrs = [];
  for (const attrName of keys) {
    const value = attrs[attrName] ?? "";
    let displayName = attrName;
    if (namespace && namespace !== "html") {
      const lowerName = attrName.toLowerCase();
      if (foreignAttributeAdjustments && foreignAttributeAdjustments[lowerName]) {
        displayName = attrName.replaceAll(":", " ");
      }
    }
    displayAttrs.push([displayName, String(value)]);
  }

  displayAttrs.sort((a, b) => a[0].localeCompare(b[0]));
  return displayAttrs.map(([name, value]) => `| ${padding}${name}="${value}"`);
}

function nodeToTestFormat(node, indent, options) {
  if (node.name === "#comment") {
    const comment = node.data || "";
    return `| ${" ".repeat(indent)}<!-- ${comment} -->`;
  }

  if (node.name === "!doctype") return doctypeToTestFormat(node);

  if (node.name === "#text") {
    const text = node.data || "";
    return `| ${" ".repeat(indent)}"${text}"`;
  }

  const line = `| ${" ".repeat(indent)}<${qualifiedName(node)}>`;
  const attributeLines = attrsToTestFormat(node, indent, options);

  const templateContent = node.templateContent ?? node.template_content ?? null;
  if (node.name === "template" && (node.namespace == null || node.namespace === "html") && templateContent) {
    const sections = [line];
    if (attributeLines.length) sections.push(...attributeLines);
    sections.push(`| ${" ".repeat(indent + 2)}content`);
    for (const child of templateContent.children || []) sections.push(nodeToTestFormat(child, indent + 4, options));
    return sections.join("\n");
  }

  const sections = [line];
  if (attributeLines.length) sections.push(...attributeLines);
  for (const child of node.children || []) sections.push(nodeToTestFormat(child, indent + 2, options));
  return sections.join("\n");
}

export function toTestFormat(node, options = {}) {
  const { foreignAttributeAdjustments = null } = options;
  const opts = { foreignAttributeAdjustments };

  if (node.name === "#document" || node.name === "#document-fragment") {
    return (node.children || []).map((child) => nodeToTestFormat(child, 0, opts)).join("\n");
  }

  return nodeToTestFormat(node, 0, opts);
}

