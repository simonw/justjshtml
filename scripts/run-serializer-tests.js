import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serializeSerializerTokenStream } from "../src/html5lib_serializer.js";

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

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
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
  const testsDir = path.resolve(REPO_ROOT, args.testsDir || process.env.HTML5LIB_TESTS_DIR || "html5lib-tests");
  const serializerDir = path.join(testsDir, "serializer");

  const entries = await readdir(serializerDir, { withFileTypes: true });
  const testFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".test"))
    .map((e) => path.join(serializerDir, e.name))
    .sort();

  if (!testFiles.length) {
    console.error(`No serializer fixtures found under: ${serializerDir}`);
    process.exit(2);
  }

  const supportedOptionKeys = new Set([
    "encoding",
    "inject_meta_charset",
    "strip_whitespace",
    "quote_attr_values",
    "use_trailing_solidus",
    "minimize_boolean_attributes",
    "quote_char",
    "escape_lt_in_attrs",
    "escape_rcdata",
  ]);

  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const file of testFiles) {
    const text = await readFile(file, "utf8");
    const data = JSON.parse(text);
    const tests = Array.isArray(data?.tests) ? data.tests : [];

    const filename = path.basename(file);
    const fileRel = path.relative(REPO_ROOT, file);

    for (let idx = 0; idx < tests.length; idx += 1) {
      const test = tests[idx];
      if (!isTestSelected(fileRel, filename, idx, args.testSpecs)) continue;

      total += 1;

      const options = test?.options ?? {};
      if (!isPlainObject(options)) {
        skipped += 1;
        continue;
      }

      if (Object.keys(options).some((k) => !supportedOptionKeys.has(k))) {
        skipped += 1;
        continue;
      }

      const input = test?.input ?? [];
      const actual = serializeSerializerTokenStream(input, options);
      if (actual == null) {
        skipped += 1;
        continue;
      }

      const expectedList = test?.expected ?? [];
      const ok = Array.isArray(expectedList) && expectedList.includes(actual);
      if (ok) {
        passed += 1;
      } else {
        failed += 1;
        console.error(`SERIALIZER FAIL: ${fileRel}:${idx} ${test?.description || ""}`.trim());
        if (args.show) {
          console.error("INPUT:", JSON.stringify(input));
        }
        console.error("EXPECTED one of:");
        for (const e of expectedList) console.error(JSON.stringify(e));
        console.error("ACTUAL:");
        console.error(JSON.stringify(actual));
      }
    }
  }

  console.log(`serializer: ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

await main();

