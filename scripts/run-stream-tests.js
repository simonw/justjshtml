import assert from "node:assert/strict";

import { stream } from "../src/index.js";

function collect(gen) {
  return Array.from(gen);
}

function test(name, fn) {
  try {
    fn();
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, err };
  }
}

const results = [];

results.push(
  test("basic stream", () => {
    const html = '<div class="container">Hello <b>World</b></div>';
    const events = collect(stream(html));
    const expected = [
      ["start", ["div", { class: "container" }]],
      ["text", "Hello "],
      ["start", ["b", {}]],
      ["text", "World"],
      ["end", "b"],
      ["end", "div"],
    ];
    assert.deepEqual(events, expected);
  })
);

results.push(
  test("comments", () => {
    const events = collect(stream("<!-- comment -->"));
    assert.deepEqual(events, [["comment", " comment "]]);
  })
);

results.push(
  test("doctype", () => {
    const events = collect(stream("<!DOCTYPE html>"));
    assert.deepEqual(events, [["doctype", ["html", null, null]]]);
  })
);

results.push(
  test("void elements", () => {
    const events = collect(stream("<br><hr>"));
    assert.deepEqual(events, [
      ["start", ["br", {}]],
      ["start", ["hr", {}]],
    ]);
  })
);

results.push(
  test("text coalescing", () => {
    const events = collect(stream("abc"));
    assert.deepEqual(events, [["text", "abc"]]);
  })
);

results.push(
  test("script rawtext", () => {
    const events = collect(stream("<script>console.log('<');</script>"));
    assert.deepEqual(events, [
      ["start", ["script", {}]],
      ["text", "console.log('<');"],
      ["end", "script"],
    ]);
  })
);

results.push(
  test("unmatched end tag", () => {
    const events = collect(stream("</div>"));
    assert.deepEqual(events, [["end", "div"]]);
  })
);

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  for (const r of failed) {
    console.error(`stream FAIL: ${r.name}`);
    console.error(r.err);
  }
  console.error(`stream: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
  process.exit(1);
}

console.log(`stream: ${results.length}/${results.length} passed`);

