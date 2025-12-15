import assert from "node:assert/strict";

import { JustHTML, SelectorError, matches, query } from "../src/index.js";

function getSimpleDoc() {
  const html = `
    <html>
      <head><title>Test</title></head>
      <body>
        <div id="main" class="container">
          <h1>Title</h1>
          <p class="intro first">First paragraph</p>
          <p class="content">Second paragraph</p>
          <ul>
            <li>Item 1</li>
            <li class="special">Item 2</li>
            <li>Item 3</li>
          </ul>
        </div>
        <div id="sidebar" class="container secondary">
          <a href="http://example.com" data-id="123">Link</a>
        </div>
      </body>
    </html>
  `;
  return new JustHTML(html).root;
}

function getSiblingDoc() {
  const html = `
    <html><body>
      <div>
        <h1>Heading</h1>
        <p class="first">First</p>
        <p class="second">Second</p>
        <p class="third">Third</p>
        <span>Not a p</span>
        <p class="fourth">Fourth</p>
      </div>
    </body></html>
  `;
  return new JustHTML(html).root;
}

function getEmptyDoc() {
  const html = `
    <html><body>
      <div class="empty"></div>
      <div class="whitespace">   </div>
      <div class="text">content</div>
      <div class="nested"><span></span></div>
    </body></html>
  `;
  return new JustHTML(html).root;
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
  test("tag selector", () => {
    const root = getSimpleDoc();
    const out = query(root, "p");
    assert.equal(out.length, 2);
    assert.ok(out.every((n) => n.name === "p"));
  })
);

results.push(
  test("tag selector is case-insensitive", () => {
    const root = getSimpleDoc();
    assert.equal(query(root, "P").length, 2);
  })
);

results.push(
  test("id selector", () => {
    const root = getSimpleDoc();
    const out = query(root, "#main");
    assert.equal(out.length, 1);
    assert.equal(out[0].attrs.id, "main");
  })
);

results.push(
  test("class selector", () => {
    const root = getSimpleDoc();
    assert.equal(query(root, ".container").length, 2);
  })
);

results.push(
  test("compound selector (tag + classes)", () => {
    const root = getSimpleDoc();
    const out = query(root, "p.intro.first");
    assert.equal(out.length, 1);
    assert.equal(out[0].attrs.class, "intro first");
  })
);

results.push(
  test("attribute presence", () => {
    const root = getSimpleDoc();
    const out = query(root, "[href]");
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "a");
  })
);

results.push(
  test("attribute exact match", () => {
    const root = getSimpleDoc();
    const out = query(root, '[data-id="123"]');
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "a");
  })
);

results.push(
  test("descendant combinator", () => {
    const root = getSimpleDoc();
    const out = query(root, "div#main p.content");
    assert.equal(out.length, 1);
    assert.equal(out[0].attrs.class, "content");
  })
);

results.push(
  test("child combinator", () => {
    const root = getSimpleDoc();
    const out = query(root, "div#main > h1");
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "h1");
  })
);

results.push(
  test("adjacent sibling combinator", () => {
    const root = getSiblingDoc();
    const out = query(root, "p.first + p");
    assert.equal(out.length, 1);
    assert.equal(out[0].attrs.class, "second");
  })
);

results.push(
  test("general sibling combinator", () => {
    const root = getSiblingDoc();
    const out = query(root, "p.first ~ p");
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((n) => n.attrs.class),
      ["second", "third", "fourth"]
    );
  })
);

results.push(
  test(":first-child / :last-child", () => {
    const root = getSimpleDoc();
    const first = query(root, "li:first-child");
    const last = query(root, "li:last-child");
    assert.equal(first.length, 1);
    assert.equal(last.length, 1);
    assert.equal(first[0].toText({ separator: "", strip: true }), "Item 1");
    assert.equal(last[0].toText({ separator: "", strip: true }), "Item 3");
  })
);

results.push(
  test(":nth-child(2)", () => {
    const root = getSimpleDoc();
    const out = query(root, "li:nth-child(2)");
    assert.equal(out.length, 1);
    assert.equal(out[0].attrs.class, "special");
  })
);

results.push(
  test(":not(.special)", () => {
    const root = getSimpleDoc();
    const out = query(root, "li:not(.special)");
    assert.equal(out.length, 2);
  })
);

results.push(
  test(":empty matches whitespace-only text", () => {
    const root = getEmptyDoc();
    const out = query(root, "div:empty");
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((n) => n.attrs.class).sort(),
      ["empty", "whitespace"]
    );
  })
);

results.push(
  test(":root matches document element", () => {
    const root = getSimpleDoc();
    const out = query(root, ":root");
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "html");
  })
);

results.push(
  test("matches()", () => {
    const root = getSimpleDoc();
    const p = query(root, "p.intro")[0];
    assert.equal(matches(p, "p"), true);
    assert.equal(matches(p, ".intro"), true);
    assert.equal(matches(p, ".content"), false);
  })
);

results.push(
  test("invalid selector throws SelectorError", () => {
    const root = getSimpleDoc();
    assert.throws(() => query(root, "#"), SelectorError);
    assert.throws(() => query(root, ""), SelectorError);
  })
);

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  for (const r of failed) {
    console.error(`selector FAIL: ${r.name}`);
    console.error(r.err);
  }
  console.error(`selector: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
  process.exit(1);
}

console.log(`selector: ${results.length}/${results.length} passed`);

