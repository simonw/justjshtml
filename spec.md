# justjshtml – API Spec & Roadmap

This repository will become a dependency‑free JavaScript port of `~/dev/justhtml` (the pure‑Python HTML5 parser).
The primary success criterion is passing the full `~/dev/html5lib-tests` suite while keeping a small, browser+Node friendly API.

## Goals

- **Correctness first**: match the WHATWG HTML parsing algorithm closely enough to pass `html5lib-tests` (tokenizer, tree construction, encoding).
- **Zero runtime dependencies**: plain JavaScript only (no npm deps); run in Node.js and modern browsers.
- **Small, learnable API**: similar surface area to the Python `justhtml` API; easy DOM traversal + CSS selector querying + streaming.
- **Deterministic output for tests**: provide a `toTestFormat()` serializer matching `html5lib-tests` expectations.

## Non‑goals (initially)

- Implementing the full Web DOM / Web IDL APIs.
- Executing scripts; we only implement the **parser’s scripting flag** behavior (required by tests).
- Providing a fully‑featured HTML→Markdown converter beyond what `justhtml` already provides.

## Public API (proposed)

Package name: `justjshtml` (working title).

### Imports / exports

ESM:

```js
import {
  JustHTML,
  FragmentContext,
  ParseError,
  StrictModeError,
  SelectorError,
  stream,
  query,
  matches,
  toHTML,
  toTestFormat,
} from "justjshtml";
```

Notes:
- The library will ship as ESM first. A thin CJS wrapper can be added later if needed.
- The runtime exports are kept small; internal modules (tokenizer/treebuilder) are not part of the stable API.

## `new JustHTML(input, options?)`

Mirrors Python usage (`doc = JustHTML(html)`), adapted for JS.

```js
const doc = new JustHTML("<p class='intro'>Hello</p>");
doc.query("p.intro")[0].toHTML(); // "<p class=\"intro\">Hello</p>"
```

### Input types

- `string`
- `Uint8Array` / `ArrayBuffer` (and Node’s `Buffer`, since it’s a `Uint8Array`)

Byte input is decoded via HTML encoding sniffing (BOM, `<meta charset=...>`, fallback to `windows-1252`), matching `~/dev/justhtml/src/justhtml/encoding.py`.

### Options

```ts
type JustHTMLOptions = {
  strict?: boolean;          // default false
  collectErrors?: boolean;   // default false (enabled implicitly by strict)
  encoding?: string | null;  // transport override for byte input (e.g. "utf-8")

  fragmentContext?: FragmentContext | null; // default null
  scripting?: boolean;       // default false (parity with Python runner); tests will set as needed
  iframeSrcdoc?: boolean;    // default false (html5lib directive)

  // Advanced / primarily for tests and debugging (may stay internal):
  tokenizerOpts?: TokenizerOptions;
};
```

### Properties

- `doc.root: Node` — `#document` or `#document-fragment`
- `doc.errors: ParseError[]` — empty unless `collectErrors` or `strict`
- `doc.encoding: string | null` — chosen encoding when input is bytes; otherwise `null`
- `doc.fragmentContext: FragmentContext | null`

### Methods

- `doc.query(selector: string): Node[]`
- `doc.toHTML(options?): string`
- `doc.toText(options?): string`
- `doc.toMarkdown(): string`

## Nodes

The parser returns a small “simple DOM” tree compatible with the Python `SimpleDomNode` shape.

### Node shape (stable)

```ts
type Namespace = "html" | "svg" | "math" | null;

type AttrValue = string | null; // null used for boolean attributes; empty string allowed
type Attrs = Record<string, AttrValue>;

type NodeName =
  | "#document"
  | "#document-fragment"
  | "#text"
  | "#comment"
  | "!doctype"
  | string; // tag name (lowercase)

interface Node {
  name: NodeName;
  namespace: Namespace;
  parent: Node | null;
  children: Node[];          // text nodes return []
  attrs: Attrs;              // non-elements: {}
  data: string | null;       // only meaningful for #text/#comment/doctype payloads

  // Template elements (HTML namespace only):
  templateContent?: Node | null; // #document-fragment

  // Methods (DOM-ish + Python parity):
  query(selector: string): Node[];
  toHTML(options?): string;
  toText(options?): string;
  toMarkdown(): string;

  appendChild(node: Node): void;
  removeChild(node: Node): void;
  insertBefore(node: Node, referenceNode: Node | null): void;
  replaceChild(newNode: Node, oldNode: Node): Node;
  cloneNode(deep?: boolean): Node;

  readonly text: string; // node-local text; for #text => data, else ""
}
```

### Naming conventions

Primary JS API will be **camelCase** (`toHTML`, `toText`, `cloneNode`, …).
For parity with the Python docs, we may also expose snake_case aliases (`to_html`, `to_text`, …) as non-breaking conveniences.

## Fragment parsing: `new FragmentContext(tagName, namespace?)`

```js
const ctx = new FragmentContext("tbody"); // HTML fragment context
const frag = new JustHTML("<tr><td>x</td></tr>", { fragmentContext: ctx });
frag.root.name; // "#document-fragment"
```

`namespace` is `null`/omitted for HTML, or `"svg"` / `"math"` for foreign content contexts.

## Streaming API: `stream(input, options?)`

Memory‑efficient token/event stream. Mirrors Python’s `stream()` semantics.

```js
for (const [event, data] of stream("<p>Hello</p>")) {
  // event: "start" | "end" | "text" | "comment" | "doctype"
}
```

Events:
- `"start"` → `[tagName: string, attrs: Attrs]`
- `"end"` → `tagName: string`
- `"text"` → `text: string` (coalesced)
- `"comment"` → `text: string`
- `"doctype"` → `[name: string, publicId: string | null, systemId: string | null]`

## Selectors

- `doc.query(selector)` and `node.query(selector)` implement the same selector subset as `~/dev/justhtml/src/justhtml/selector.py`:
  - tag, `#id`, `.class`, `*`
  - attribute selectors: `[attr]`, `=`, `~=`, `|=`, `^=`, `$=`, `*=`
  - combinators: descendant, `>`, `+`, `~`
  - selector groups: `,`
  - pseudos: `:first-child`, `:last-child`, `:only-child`, `:nth-child`, `:nth-last-child`,
    `:first-of-type`, `:last-of-type`, `:only-of-type`, `:nth-of-type`, `:nth-last-of-type`,
    `:empty`, `:root`, `:not(...)`

Standalone helpers:

- `query(node, selector) -> Node[]`
- `matches(node, selector) -> boolean`

Errors:

- `SelectorError` thrown on invalid selectors.

## Serialization helpers

- `toHTML(node, options?) -> string` (pretty output by default, like Python)
- `toTestFormat(node) -> string` (exact `html5lib-tests` tree format)

## Errors

### `ParseError`

Represents a parse error with location information, mirroring Python’s `ParseError` in `tokens.py`.

Proposed shape:

```ts
class ParseError {
  code: string;      // kebab-case error code
  message: string;   // human-readable message (derived from code + context)
  line: number | null;   // 1-based
  column: number | null; // 1-based
}
```

### `StrictModeError`

Thrown when `strict: true` and the first parse error is encountered.

- `error: ParseError` (the underlying parse error)

## Roadmap / implementation plan

### Milestone 0 — Repository scaffold

- Create `src/` modules mirroring the Python architecture:
  - `encoding.js`, `tokens.js`, `errors.js`
  - `tokenizer.js`, `treebuilder.js`, `treebuilder_modes.js`, `constants.js`
  - `node.js`, `serialize.js`, `selector.js`, `stream.js`
  - `index.js` (public exports)
- Add a tiny Node-based test runner (no deps) under `scripts/`:
  - Loads `~/dev/html5lib-tests` fixtures from disk
  - Produces a per-file and overall summary similar to `~/dev/justhtml/run_tests.py`

### Milestone 0.5 — End-to-end smoke parse (single valid document)

- Implement the smallest end-to-end slice so the public API is real early:
  - `new JustHTML("<html><head></head><body><p>Hello</p></body></html>")` returns a tree with the expected tag structure and text nodes.
  - `doc.toText()` returns `"Hello"` and `doc.errors` is empty for this valid input.
- Add `scripts/smoke.js` (no deps) that runs the example and asserts the expected structure/output.
- Gate: `node scripts/smoke.js` passes.

### Milestone 1 — Encoding (html5lib encoding tests)

- Port `normalizeEncodingLabel()`, BOM sniffing, `<meta charset>` prescan, and fallback rules from `~/dev/justhtml/src/justhtml/encoding.py`.
- Decode via `TextDecoder` for the allowlisted encodings used by the Python port:
  - `utf-8`, `windows-1252`, `iso-8859-2`, `euc-jp`, `utf-16le`, `utf-16be`, `utf-16`
- Gate: `encoding/*.test` fixtures pass.

### Milestone 2 — Tokenizer (html5lib tokenizer tests)

- Port the tokenizer state machine from `~/dev/justhtml/src/justhtml/tokenizer.py`.
- Implement entity decoding (from `entities.py`) and error emission (from `errors.py`).
- Maintain accurate `(line, column)` for errors and for strict-mode reporting.
- Gate: tokenizer `.test` fixtures pass.

### Milestone 3 — Tree builder (tree-construction tests)

- Port `TreeBuilder` + insertion modes from `~/dev/justhtml/src/justhtml/treebuilder.py` and related helpers/constants.
- Implement:
  - foster parenting, adoption agency algorithm, template insertion modes
  - foreign content (SVG/MathML) integration and attribute adjustments
  - fragment parsing via `FragmentContext`
  - scripting flag handling (run both `#script-on` and `#script-off` tests)
  - `iframe-srcdoc` directive handling
- Gate: `tree-construction/*.dat` passes via `toTestFormat()`.

### Milestone 4 — Public API polish + streaming

- Implement `JustHTML` wrapper class (decode → tokenize → tree build → expose root/errors/encoding).
- Implement `stream()` generator (tokenizer-only, coalesced text).
- Gate: streaming tests + basic doc examples.

### Milestone 5 — Selectors + text/markdown helpers

- Port `selector.py` to JS with identical semantics and error behavior.
- Port `node.toText()` and `node.toMarkdown()` behavior (pragmatic GFM subset).
- Gate: selector unit tests (ported from `~/dev/justhtml/tests/test_selector.py`) and parity examples.

### Milestone 6 — Packaging

- Publish ESM build with stable exports and JSDoc/`d.ts` types.
- Provide a browser-friendly entrypoint (`dist/` optional) without requiring a bundler to *use* the library.

## Open questions (decisions to make early)

1. **Default `scripting` flag**: keep Python parity (`false`) vs browser realism (`true`).
2. **CJS support**: do we ship it, or keep ESM-only initially?
3. **Node classes exported?**: expose constructors publicly vs documenting shape only.
