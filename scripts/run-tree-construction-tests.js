import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FragmentContext } from "../src/context.js";
import { JustHTML } from "../src/justhtml.js";
import { toTestFormat } from "../src/serialize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { testsDir: null, testSpecs: [], show: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tests-dir") {
      out.testsDir = argv[i + 1] || null;
      i += 1;
    } else if (arg === "--test-spec") {
      const spec = argv[i + 1];
      if (spec) out.testSpecs.push(spec);
      i += 1;
    } else if (arg === "--show") {
      out.show = true;
    }
  }
  return out;
}

function decodeEscapes(text) {
  if (!text.includes("\\x") && !text.includes("\\u")) return text;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "x" && i + 3 < text.length) {
        const hex = text.slice(i + 2, i + 4);
        const code = Number.parseInt(hex, 16);
        if (!Number.isNaN(code)) {
          out += String.fromCharCode(code);
          i += 3;
          continue;
        }
      }
      if (next === "u" && i + 5 < text.length) {
        const hex = text.slice(i + 2, i + 6);
        const code = Number.parseInt(hex, 16);
        if (!Number.isNaN(code)) {
          out += String.fromCharCode(code);
          i += 5;
          continue;
        }
      }
    }
    out += ch;
  }
  return out;
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

async function listDatFiles(dir) {
  const out = [];
  async function walk(d) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && ent.name.endsWith(".dat")) out.push(full);
    }
  }
  await walk(dir);
  out.sort();
  return out;
}

function compareOutputs(expected, actual) {
  const normalize = (s) =>
    s
      .trim()
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n");
  return normalize(expected) === normalize(actual);
}

function parseDatFile(content) {
  const lines = content.split("\n");

  const tests = [];
  let current = [];

  for (let i = 0; i < lines.length; i += 1) {
    current.push(lines[i]);
    const nextIsNewTest = i + 1 >= lines.length || lines[i + 1] === "#data";
    if (!nextIsNewTest) continue;

    if (current.some((l) => l.trim())) {
      const test = parseSingleTest(current);
      if (test) tests.push(test);
    }
    current = [];
  }

  return tests;
}

function parseSingleTest(lines) {
  let mode = null;
  const data = [];
  const errors = [];
  const document = [];

  let fragmentContext = null;
  let scriptDirective = null;
  let xmlCoercion = false;
  let iframeSrcdoc = false;

  for (const line of lines) {
    if (line.startsWith("#")) {
      const directive = line.slice(1);
      if (directive === "script-on" || directive === "script-off") {
        scriptDirective = directive;
        continue;
      }
      if (directive === "xml-coercion") {
        xmlCoercion = true;
        continue;
      }
      if (directive === "iframe-srcdoc") {
        iframeSrcdoc = true;
        continue;
      }
      mode = directive;
      continue;
    }

    if (mode === "data") data.push(line);
    else if (mode === "errors" || mode === "new-errors") errors.push(line);
    else if (mode === "document") document.push(line);
    else if (mode === "document-fragment") {
      const frag = line.trim();
      if (!frag) continue;
      if (frag.includes(" ")) {
        const [namespace, tagName] = frag.split(" ", 2);
        fragmentContext = new FragmentContext(tagName, namespace);
      } else {
        fragmentContext = new FragmentContext(frag);
      }
    }
  }

  if (!data.length && !document.length) return null;
  return {
    input: decodeEscapes(data.join("\n")),
    expected: document.join("\n"),
    errors,
    fragmentContext,
    scriptDirective,
    xmlCoercion,
    iframeSrcdoc,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const testsDir = path.resolve(REPO_ROOT, args.testsDir || process.env.HTML5LIB_TESTS_DIR || "html5lib-tests");
  const dir = path.join(testsDir, "tree-construction");

  const datFiles = await listDatFiles(dir);

  if (!datFiles.length) {
    console.error(`No tree-construction fixtures found under: ${dir}`);
    process.exit(2);
  }

  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const filePath of datFiles) {
    const filename = path.basename(filePath);
    const fileRel = path.relative(testsDir, filePath);
    const content = await readFile(filePath, "utf8");
    const tests = parseDatFile(content);

    for (let idx = 0; idx < tests.length; idx += 1) {
      const test = tests[idx];
      if (!isTestSelected(fileRel, filename, idx, args.testSpecs)) continue;

      total += 1;

      // Skip script-on until scripting flag is implemented.
      if (test.scriptDirective === "script-on") {
        skipped += 1;
        continue;
      }

      const doc = new JustHTML(test.input, {
        fragmentContext: test.fragmentContext || null,
        iframeSrcdoc: Boolean(test.iframeSrcdoc),
        tokenizerOpts: { xmlCoercion: Boolean(test.xmlCoercion) },
      });

      const actual = toTestFormat(doc.root);
      if (compareOutputs(test.expected, actual)) {
        passed += 1;
      } else {
        failed += 1;
        console.error(`TREE FAIL: ${fileRel}:${idx}`.trim());
        if (args.show) {
          console.error("\nINPUT:\n" + test.input + "\n");
          console.error("EXPECTED:\n" + test.expected + "\n");
          console.error("ACTUAL:\n" + actual + "\n");
        }
      }
    }
  }

  console.log(`tree: ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

await main();
