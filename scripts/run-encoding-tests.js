import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeEncodingLabel, sniffHTMLEncoding } from "../src/encoding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { testsDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tests-dir") {
      out.testsDir = argv[i + 1] || null;
      i += 1;
    }
  }
  return out;
}

function splitLinesKeepEnds(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < buf.length) lines.push(buf.subarray(start));
  return lines;
}

function rstripCRLF(buf) {
  let end = buf.length;
  while (end > 0) {
    const b = buf[end - 1];
    if (b === 0x0a || b === 0x0d) end -= 1;
    else break;
  }
  return buf.subarray(0, end);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const BYTES_HASH_DATA = new Uint8Array([0x23, 0x64, 0x61, 0x74, 0x61]); // #data
const BYTES_HASH_ENCODING = new Uint8Array([0x23, 0x65, 0x6e, 0x63, 0x6f, 0x64, 0x69, 0x6e, 0x67]); // #encoding

function parseEncodingDatFile(buf) {
  const tests = [];
  let mode = null;
  let currentData = [];
  let currentEncoding = null;

  const flush = () => {
    if (currentData == null || currentEncoding == null) return;
    tests.push({ data: Buffer.concat(currentData), expectedLabel: currentEncoding });
    currentData = [];
    currentEncoding = null;
  };

  for (const line of splitLinesKeepEnds(buf)) {
    const stripped = rstripCRLF(line);
    if (bytesEqual(stripped, BYTES_HASH_DATA)) {
      flush();
      mode = "data";
      continue;
    }
    if (bytesEqual(stripped, BYTES_HASH_ENCODING)) {
      mode = "encoding";
      continue;
    }

    if (mode === "data") currentData.push(Buffer.from(line));
    else if (mode === "encoding" && currentEncoding == null && stripped.length) {
      currentEncoding = Buffer.from(stripped).toString("ascii");
    }
  }

  flush();
  return tests;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const testsDir = path.resolve(REPO_ROOT, args.testsDir || process.env.HTML5LIB_TESTS_DIR || "html5lib-tests");
  const encodingDir = path.join(testsDir, "encoding");

  const testFiles = await listDatFiles(encodingDir);
  if (!testFiles.length) {
    console.error(`No encoding fixtures found under: ${encodingDir}`);
    process.exit(2);
  }

  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const file of testFiles) {
    const isScripted = file.split(path.sep).includes("scripted");
    const buf = await readFile(file);
    const tests = parseEncodingDatFile(buf);

    for (let i = 0; i < tests.length; i += 1) {
      const { data, expectedLabel } = tests[i];
      total += 1;

      const expected = normalizeEncodingLabel(expectedLabel);
      if (expected == null) {
        skipped += 1;
        continue;
      }

      if (isScripted) {
        skipped += 1;
        continue;
      }

      const actual = sniffHTMLEncoding(new Uint8Array(data)).encoding;
      if (actual === expected) {
        passed += 1;
      } else {
        failed += 1;
        const rel = path.relative(REPO_ROOT, file);
        console.error(`ENCODING FAIL: ${rel}:${i}`);
        console.error(`EXPECTED: ${expected} (raw: ${expectedLabel})`);
        console.error(`ACTUAL:   ${actual}`);
      }
    }
  }

  console.log(`encoding: ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

await main();
