import assert from "node:assert/strict";
import { JustHTML } from "../src/index.js";

const html = "<html><head></head><body><p>Hello</p></body></html>";
const doc = new JustHTML(html);

assert.equal(doc.errors.length, 0);
assert.equal(doc.toText(), "Hello");

assert.equal(doc.root.name, "#document");
assert.equal(doc.root.children.length, 1);

const htmlNode = doc.root.children[0];
assert.equal(htmlNode.name, "html");
assert.equal(htmlNode.parent, doc.root);

assert.equal(htmlNode.children.length, 2);
const head = htmlNode.children[0];
const body = htmlNode.children[1];

assert.equal(head.name, "head");
assert.equal(head.parent, htmlNode);
assert.equal(head.children.length, 0);

assert.equal(body.name, "body");
assert.equal(body.parent, htmlNode);
assert.equal(body.children.length, 1);

const p = body.children[0];
assert.equal(p.name, "p");
assert.equal(p.parent, body);
assert.equal(p.children.length, 1);

const text = p.children[0];
assert.equal(text.name, "#text");
assert.equal(text.parent, p);
assert.equal(text.data, "Hello");

console.log("smoke: ok");

