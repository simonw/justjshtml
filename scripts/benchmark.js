import { JustHTML } from "../src/index.js";

// Read HTML from stdin or use a default
let html;
if (process.argv[2]) {
  html = process.argv[2];
} else {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  html = Buffer.concat(chunks).toString("utf-8");
}

console.log(`Input size: ${html.length} bytes`);

// Warmup
for (let i = 0; i < 5; i++) {
  new JustHTML(html);
}

// Benchmark
const iterations = 100;
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  new JustHTML(html);
}
const end = performance.now();

const totalMs = end - start;
const avgMs = totalMs / iterations;
const opsPerSec = (iterations / totalMs) * 1000;

console.log(`Iterations: ${iterations}`);
console.log(`Total time: ${totalMs.toFixed(2)} ms`);
console.log(`Average time: ${avgMs.toFixed(3)} ms`);
console.log(`Ops/sec: ${opsPerSec.toFixed(1)}`);
