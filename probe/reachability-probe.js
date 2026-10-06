#!/usr/bin/env node
'use strict';

/**
 * Reachability probe for the HUQAN x Jev analysis.
 *
 * Answers one question mechanically: if Jev were called from a given module,
 * would that module be reachable from HUQAN's declared deterministic-execution
 * entry points -- i.e. would scripts/check-deterministic-path.js break?
 *
 * It re-implements the same require()-graph walk that script uses, so the
 * result matches the gate's notion of reachability. Read-only: it never writes
 * to the target repository.
 *
 * Usage:
 *   node probe/reachability-probe.js /path/to/huqan
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || process.cwd());

// Mirrors ENTRY_POINTS in scripts/check-deterministic-path.js.
const ENTRY_POINTS = ['workflow-agent.js', 'lib/experience/personal-execution-model.js'];

// Modules that would call a model. The gate itself only knows llmAdapter.js;
// these are the candidate Jev insertion points from the analysis.
const MODEL_CALLING_CANDIDATES = [
  'llmAdapter.js',
  'lib/jev-adapter.js',
  'lib/risk-classify.js',
  'lib/risk-rules.js',
  'lib/text-safety-scorer.js',
  'lib/memory-query-engine.js',
  'lib/memory-query-bm25.js',
  'lib/evidence-ranker.js',
];

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not a file; try the next candidate
    }
  }
  return null;
}

function reachableFrom(entryFile) {
  const seen = new Set([entryFile]);
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift();
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = requireRe.exec(source)) !== null) {
      const resolved = resolveRequire(file, match[1]);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return seen;
}

function main() {
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    process.stderr.write(`Not a repository root: ${root}\n`);
    process.exit(1);
  }

  const reachable = new Set();
  const entriesFound = [];
  for (const entry of ENTRY_POINTS) {
    const entryFile = path.join(root, entry);
    if (!fs.existsSync(entryFile)) continue;
    entriesFound.push(entry);
    for (const file of reachableFrom(entryFile)) reachable.add(file);
  }

  const relative = [...reachable].map((file) => path.relative(root, file).split(path.sep).join('/'));
  const relativeSet = new Set(relative);

  process.stdout.write(`huqan root: ${root}\n`);
  process.stdout.write(`entry points found: ${entriesFound.join(', ') || '(none)'}\n`);
  process.stdout.write(`reachable modules: ${relative.length}\n\n`);

  process.stdout.write('module                              reachable from entry points?\n');
  process.stdout.write('---------------------------------------------------------------\n');
  for (const candidate of MODEL_CALLING_CANDIDATES) {
    const hit = relativeSet.has(candidate);
    const verdict = hit ? 'YES  <- gate would FAIL' : 'no   <- gate stays green';
    process.stdout.write(`${candidate.padEnd(35)} ${verdict}\n`);
  }

  const inserted = MODEL_CALLING_CANDIDATES.filter((c) => relativeSet.has(c));
  process.stdout.write('\n');
  if (inserted.length === 0) {
    process.stdout.write(
      'Result: none of the candidate model-calling modules are reachable from the\n' +
        'declared entry points, so adding a model call in them does not break\n' +
        'check:deterministic-path today. That is a statement about the current\n' +
        'graph, not a permission: any new model-calling module must still be added\n' +
        'to MODEL_CALLING_MODULES in scripts/check-deterministic-path.js, or the\n' +
        'gate silently stops measuring it.\n'
    );
  } else {
    process.stdout.write(
      `Result: ${inserted.join(', ')} IS reachable from a declared entry point. A model call\n` +
        'there breaks the deterministic-execution claim and check:deterministic-path fails.\n'
    );
  }
}

main();
