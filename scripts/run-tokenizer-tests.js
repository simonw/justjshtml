import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CharacterToken, CommentToken, Doctype, DoctypeToken, EOFToken, Tag } from "../src/tokens.js";
import { Tokenizer, TokenizerOpts } from "../src/tokenizer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { testsDir: null, testSpecs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tests-dir") {
      out.testsDir = argv[i + 1] || null;
      i += 1;
    } else if (arg === "--test-spec") {
      const spec = argv[i + 1];
      if (spec) out.testSpecs.push(spec);
      i += 1;
    }
  }
  return out;
}

function unescapeUnicode(text) {
  return text.replaceAll(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function deepUnescape(val) {
  if (typeof val === "string") return unescapeUnicode(val);
  if (Array.isArray(val)) return val.map(deepUnescape);
  if (val && typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = deepUnescape(v);
    return out;
  }
  return val;
}

function tokenToList(token) {
  if (token instanceof DoctypeToken) {
    const d = token.doctype;
    return ["DOCTYPE", d.name, d.publicId, d.systemId, !d.forceQuirks];
  }
  if (token instanceof CommentToken) return ["Comment", token.data];
  if (token instanceof CharacterToken) return ["Character", token.data];
  if (token instanceof Tag) {
    if (token.kind === Tag.START) {
      const attrs = token.attrs || {};
      const arr = ["StartTag", token.name, attrs];
      if (token.selfClosing) arr.push(true);
      return arr;
    }
    return ["EndTag", token.name];
  }
  if (token instanceof EOFToken) return null;
  return ["Unknown"];
}

function collapseCharacters(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t && t[0] === "Character" && out.length && out[out.length - 1][0] === "Character") {
      out[out.length - 1][1] += t[1];
    } else {
      out.push(t);
    }
  }
  return out;
}

function canonicalize(val) {
  if (Array.isArray(val)) return val.map(canonicalize);
  if (val && typeof val === "object") {
    const out = {};
    const keys = Object.keys(val).sort();
    for (const k of keys) out[k] = canonicalize(val[k]);
    return out;
  }
  return val;
}

function mapInitialState(name) {
  const mapping = {
    "Data state": [Tokenizer.DATA, null],
    "PLAINTEXT state": [Tokenizer.PLAINTEXT, null],
    "RCDATA state": [Tokenizer.RCDATA, null],
    "RAWTEXT state": [Tokenizer.RAWTEXT, null],
    "Script data state": [Tokenizer.RAWTEXT, "script"],
    "CDATA section state": [Tokenizer.CDATA_SECTION, null],
  };
  return mapping[name] || null;
}

class RecordingSink {
  constructor() {
    this.tokens = [];
    this.openElements = [{ namespace: "html" }];
  }

  processToken(token) {
    if (token instanceof Tag) {
      this.tokens.push(new Tag(token.kind, token.name, { ...(token.attrs || {}) }, token.selfClosing));
    } else if (token instanceof CharacterToken) {
      this.tokens.push(new CharacterToken(token.data));
    } else if (token instanceof CommentToken) {
      this.tokens.push(new CommentToken(token.data));
    } else if (token instanceof DoctypeToken) {
      const d = token.doctype;
      this.tokens.push(
        new DoctypeToken(
          new Doctype({ name: d.name, publicId: d.publicId, systemId: d.systemId, forceQuirks: d.forceQuirks })
        )
      );
    } else if (token instanceof EOFToken) {
      this.tokens.push(new EOFToken());
    } else {
      this.tokens.push(token);
    }
    return 0;
  }

  processCharacters(data) {
    this.tokens.push(new CharacterToken(data));
  }
}

function isTestSelected(fileRel, filename, index, specs) {
  if (!specs.length) return true;

  for (const spec of specs) {
    if (spec.includes(":")) {
      const [filePart, indicesPart] = spec.split(":", 2);
      if (!fileRel.includes(filePart) && !filename.includes(filePart)) continue;
      const wanted = new Set(indicesPart.split(",").filter(Boolean).map((s) => Number.parseInt(s, 10)));
      return wanted.has(index);
    }
    if (fileRel.includes(spec) || filename.includes(spec)) return true;
  }

  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const testsDir = path.resolve(REPO_ROOT, args.testsDir || process.env.HTML5LIB_TESTS_DIR || "tests/html5lib-tests");
  const tokenizerDir = path.join(testsDir, "tokenizer");

  const entries = await readdir(tokenizerDir, { withFileTypes: true });
  const testFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".test"))
    .map((e) => path.join(tokenizerDir, e.name))
    .sort();

  if (!testFiles.length) {
    console.error(`No tokenizer fixtures found under: ${tokenizerDir}`);
    process.exit(2);
  }

  let total = 0;
  let passed = 0;
  let failed = 0;

  for (const file of testFiles) {
    const buf = await readFile(file, "utf8");
    const data = JSON.parse(buf);
    const key = data.tests ? "tests" : "xmlViolationTests";
    const tests = data[key] || [];
    const xmlCoercion = key === "xmlViolationTests";

    const filename = path.basename(file);
    const fileRel = path.relative(REPO_ROOT, file);

    for (let idx = 0; idx < tests.length; idx += 1) {
      const test = tests[idx];
      if (!isTestSelected(fileRel, filename, idx, args.testSpecs)) continue;

      total += 1;

      let inputText = test.input;
      let expectedTokens = test.output;
      if (test.doubleEscaped) {
        inputText = unescapeUnicode(inputText);
        expectedTokens = deepUnescape(expectedTokens);
      }

      const initialStates = test.initialStates || ["Data state"];
      const lastStartTag = test.lastStartTag || null;

      let ok = true;
      for (const stateName of initialStates) {
        const mapped = mapInitialState(stateName);
        if (!mapped) {
          ok = false;
          break;
        }
        let [initialState, rawTag] = mapped;
        if (lastStartTag) rawTag = lastStartTag;

        const sink = new RecordingSink();
        const opts = new TokenizerOpts({
          initialState,
          initialRawtextTag: rawTag,
          discardBom: Boolean(test.discardBom),
          xmlCoercion,
        });
        const tokenizer = new Tokenizer(sink, opts);
        tokenizer.lastStartTagName = lastStartTag;
        tokenizer.run(inputText);

        const actual = collapseCharacters(sink.tokens.map(tokenToList).filter(Boolean));
        if (JSON.stringify(canonicalize(actual)) !== JSON.stringify(canonicalize(expectedTokens))) {
          ok = false;
          break;
        }
      }

      if (ok) {
        passed += 1;
      } else {
        failed += 1;
        console.error(`TOKENIZER FAIL: ${fileRel}:${idx} ${test.description || ""}`.trim());
      }
    }
  }

  console.log(`tokenizer: ${passed}/${total} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

await main();
