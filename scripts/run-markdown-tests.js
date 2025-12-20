import assert from "node:assert/strict";

import { JustHTML, Node } from "../src/index.js";

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
  test("headings + paragraphs + inline", () => {
    const doc = new JustHTML("<h1>Title</h1><p>Hello <b>world</b> <em>ok</em> <a href='https://e.com'>link</a> a*b</p>");
    const md = doc.toMarkdown();
    assert.ok(md.startsWith("# Title\n\n"));
    assert.ok(md.includes("Hello **world** *ok* [link](https://e.com) a\\*b"));
  })
);

results.push(
  test("code inline + block", () => {
    const doc = new JustHTML("<pre>code`here\n</pre><p>inline <code>a`b</code></p>");
    const md = doc.toMarkdown();
    assert.ok(md.includes("```\ncode`here\n```"));
    assert.ok(md.includes("inline ``a`b``"));
  })
);

results.push(
  test("blockquote + br", () => {
    const doc = new JustHTML("<blockquote><p>Q<br>R</p></blockquote>");
    assert.equal(doc.toMarkdown(), "> Q\n> R");
  })
);

results.push(
  test("lists", () => {
    const doc = new JustHTML("<ul><li>One</li><li>Two</li></ul><ol><li>A</li><li>B</li></ol>");
    const md = doc.toMarkdown();
    assert.ok(md.includes("- One\n- Two"));
    assert.ok(md.includes("1. A\n2. B"));
  })
);

results.push(
  test("tables + images preserved as HTML", () => {
    const doc = new JustHTML("<p>Hi<img src=x alt=y>there</p><table><tr><td>A</td></tr></table>");
    const md = doc.toMarkdown();
    assert.ok(md.includes("<img src=x alt=y>"));
    assert.ok(md.includes("<table"));
    assert.ok(md.includes("<td>A</td>"));
    assert.ok(md.includes("</table>"));
  })
);

results.push(
  test("ignores comment + doctype", () => {
    const root = new Node("div");
    root.appendChild(new Node("#comment", { data: "nope", namespace: null }));
    root.appendChild(new Node("!doctype", { data: "html", namespace: null }));
    root.appendChild(new Node("#text", { data: "ok", namespace: null }));
    assert.equal(root.toMarkdown(), "ok");
  })
);

results.push(
  test("preserves script/style whitespace", () => {
    const root = new Node("div");
    const script = new Node("script");
    script.appendChild(new Node("#text", { data: "var x = 1;\nvar y = 2;\n", namespace: null }));
    root.appendChild(script);
    assert.equal(root.toMarkdown(), "var x = 1;\nvar y = 2;");
  })
);

results.push(
  test("text node escaping", () => {
    const t = new Node("#text", { data: "a*b", namespace: null });
    assert.equal(t.toMarkdown(), "a\\*b");
  })
);

results.push(
  test("empty text node", () => {
    const t = new Node("#text", { data: "", namespace: null });
    assert.equal(t.toMarkdown(), "");
  })
);

results.push(
  test("br on empty buffer", () => {
    const doc = new JustHTML("<br><br><br>");
    assert.equal(doc.toMarkdown(), "");
  })
);

results.push(
  test("empty blocks + hr", () => {
    const doc = new JustHTML("<hr><h2></h2><p></p><pre></pre><blockquote></blockquote>");
    const md = doc.toMarkdown();
    assert.ok(md.includes("---"));
    assert.ok(md.includes("##"));
    assert.ok(md.includes("```\n```"));
  })
);

results.push(
  test("list skips non-li children", () => {
    const doc = new JustHTML("<ul>\n<li>One</li>\n</ul>");
    assert.equal(doc.toMarkdown(), "- One");
  })
);

results.push(
  test("link without href", () => {
    const doc = new JustHTML("<p><a>text</a></p>");
    assert.equal(doc.toMarkdown(), "[text]");
  })
);

results.push(
  test("link with title attribute", () => {
    const doc = new JustHTML('<a href="/example" title="foo">Link with a title</a>');
    assert.equal(doc.toMarkdown(), '[Link with a title](/example "foo")');
  })
);

results.push(
  test("link with title containing quotes", () => {
    const doc = new JustHTML('<a href="/url" title="He said &quot;hello&quot;">text</a>');
    const md = doc.toMarkdown();
    assert.ok(md.includes('[text](/url "He said \\"hello\\"")'));
  })
);

results.push(
  test("link with title containing backslash", () => {
    const doc = new JustHTML('<a href="/url" title="path\\to\\file">text</a>');
    const md = doc.toMarkdown();
    assert.ok(md.includes('[text](/url "path\\\\to\\\\file")'));
  })
);

results.push(
  test("link with nested block element breaks link", () => {
    const doc = new JustHTML('<a href="/url">text<ul><li>item</li></ul></a>');
    const md = doc.toMarkdown();
    assert.ok(md.includes('[text](/url)'));
    assert.ok(md.includes('- item'));
    assert.ok(!md.includes('<a'));
  })
);

results.push(
  test("link with deeply nested block element", () => {
    const doc = new JustHTML('<a href="/url"><span><div>block</div></span></a>');
    const md = doc.toMarkdown();
    assert.ok(md.includes('block'));
    assert.ok(!md.includes('<a'));
  })
);

results.push(
  test("link with inline elements only", () => {
    const doc = new JustHTML('<a href="/url"><strong>Bold</strong> and <em>italic</em></a>');
    assert.equal(doc.toMarkdown(), '[**Bold** and *italic*](/url)');
  })
);


results.push(
  test("template includes templateContent", () => {
    const doc = new JustHTML("<template>T</template>");
    const html = doc.root.children[0];
    const head = html.children[0];
    const template = head.children[0];
    assert.equal(template.toMarkdown(), "T");
  })
);

results.push(
  test("document container direct", () => {
    const doc = new Node("#document", { namespace: null });
    doc.appendChild(new Node("p"));
    assert.equal(doc.toMarkdown(), "");
  })
);

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  for (const r of failed) {
    console.error(`markdown FAIL: ${r.name}`);
    console.error(r.err);
  }
  console.error(`markdown: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
  process.exit(1);
}

console.log(`markdown: ${results.length}/${results.length} passed`);

