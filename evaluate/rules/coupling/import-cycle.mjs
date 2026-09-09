// coupling/import-cycle — file-level import cycles from raw-facts.
//
// A cycle is a fact; how much it can hurt is a separate question, and the rule
// answers it in tiers instead of equating "cycle" with "broken":
//   - info    — the cycle is closed only by function-scope (lazy) imports. No
//               eager import cycle exists; nothing happens at import time.
//               Common and often deliberate in agent-style code (LLM calls
//               tools, a tool calls the LLM back). Reported as coupling, not
//               as a defect.
//   - warning — every edge is a module-scope import (an eager cycle). Python
//               tolerates this in general: the second module finds the first
//               one, partially initialised, in sys.modules. It only fails when
//               a name is pulled out of that partial module before the line
//               that binds it has run. ESM behaves alike (bindings in TDZ).
//   - error   — that failure is proven from the facts: file B does
//               `from A import X`, X is bound in A at a line after A's own
//               import that leads (eagerly) to B, so loading A first raises
//               "cannot import name 'X' from partially initialized module".
//               The evidence names the load order that fails. Needs the
//               adapter's module-scope symbols (Python); without them the
//               rule never goes above warning.
// Test and generated files are excluded the same way the module graph does.
// Confidence 1.0: static facts only.
export const code = 'coupling/import-cycle';
export const dimension = 'coupling';
export const severity = 'warning';
export const confidence = 1.0;

export function run({ graph, facts }) {
  if (!facts) return [];
  const excluded = new Set(graph.excluded.roles || []);
  const skip = new Set(facts.files.filter((f) => excluded.has(f.role)).map((f) => f.path));
  const edges = facts.imports.filter((i) => i.resolved && !skip.has(i.from) && !skip.has(i.to));
  const files = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
  const all = tarjan(files, edges);
  const eagerEdges = edges.filter((e) => !e.lazy);
  const eager = tarjan(files, eagerEdges);
  const eagerKeys = new Set(eager.map((s) => s.join('\n')));
  const bindings = indexBindings(facts.symbols || []);

  const findings = [];
  const seen = new Set();
  const emit = (scc, isEager) => {
    const key = scc.join('\n');
    if (seen.has(key)) return;
    seen.add(key);
    const set = new Set(scc);
    const internal = (isEager ? eagerEdges : edges).filter((e) => set.has(e.from) && set.has(e.to));
    const path = shortestCycle(scc[0], internal, set);
    const proof = isEager ? provePartialInit(set, internal, bindings) : null;
    const tier = proof ? 'error' : isEager ? 'warning' : 'info';
    const cycleText = `${path.join(' → ')} → ${path[0]}`;
    findings.push({
      code, dimension, confidence,
      severity: tier,
      message: proof
        ? `${scc.length} files form an eager import cycle that fails at load time when ${proof.entry} is imported first: ${proof.importer}:${proof.line} does \`from ${proof.module} import ${proof.name}\`, but ${proof.entry} binds ${proof.name} at line ${proof.boundAt}, after its line-${proof.viaLine} import that leads to ${proof.importer}. Python raises "cannot import name '${proof.name}' from partially initialized module".`
        : isEager
          ? `${scc.length} files form an eager (module-scope) import cycle: ${cycleText}. Loads today, but each file may see the other partially initialised; any module-scope use of a name from the other side depends on import order.`
          : `${scc.length} files form a dependency cycle closed only by function-scope (lazy) imports: ${cycleText}. No eager import cycle; nothing runs at import time. A coupling fact — often intentional when one side calls the other back at runtime — not a defect.`,
      subject: { files: scc },
      evidence: {
        kind: isEager ? 'eager' : 'lazy-closed',
        risk: {
          loading: proof ? 'proven-failure' : isEager ? 'order-dependent' : 'none-at-import',
          coupling: 'present',
          loadingNote: proof
            ? `fails when ${proof.entry} is loaded before ${proof.importer}`
            : isEager
              ? 'no name is provably read from a partially initialised module; module-scope attribute access is not analysed'
              : 'the cycle is only entered when the lazy-importing function is called',
        },
        path,
        imports: internal.map((e) => ({ file: e.from, line: e.line, to: e.to, ...(e.names && e.names.length ? { names: e.names } : {}), ...(e.lazy ? { lazy: true } : {}) })).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)).slice(0, 16),
        lazyImports: internal.filter((e) => e.lazy).length,
        totalImports: internal.length,
        ...(proof ? { proof } : {}),
        threshold: null,
      },
      supportedFixes: proof
        ? [`move \`${proof.name}\` above the line-${proof.viaLine} import in ${proof.entry}, or turn that import into a function-scope one`, 'move the shared definitions into a new module both sides import', 'pass the dependency in as a parameter instead of importing it']
        : isEager
          ? ['prefer `import module` + attribute access at call time over `from module import name` inside the cycle', 'move the shared definitions into a new module both sides import', 'turn one direction into a function-scope import if the dependency is only needed at call time']
          : ['keep the lazy import if the call-back is intentional, and say so in a comment at the import', 'if the two sides should be testable in isolation, inject the callee (a callback or protocol) from the composition root instead of importing it'],
    });
  };
  for (const scc of all) emit(scc, eagerKeys.has(scc.join('\n')));
  // Eager sub-cycles that are strict subsets of a lazy-closed SCC are their own, sharper fact.
  for (const scc of eager) emit(scc, true);
  const rank = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.subject.files[0] < b.subject.files[0] ? -1 : a.subject.files[0] > b.subject.files[0] ? 1 : 0));
}

// file -> Map(name -> line where it is first bound at module scope)
function indexBindings(symbols) {
  const byFile = new Map();
  for (const s of symbols) {
    if (!byFile.has(s.file)) byFile.set(s.file, new Map());
    const m = byFile.get(s.file);
    if (!m.has(s.name) || m.get(s.name) > s.line) m.set(s.name, s.line);
  }
  return byFile;
}

// Proof search. For every eager `from A import X` (importer B, explicit name X
// bound in A at line boundAt): is there an eager path A → … → B whose first
// hop leaves A at a line before boundAt? If so, importing A first executes A
// up to that hop, which (transitively) runs B, which asks the half-built A
// for X before it exists. Returns the first proof in deterministic order.
function provePartialInit(set, internal, bindings) {
  const out = new Map();
  for (const e of internal) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
  for (const list of out.values()) list.sort((a, b) => a.line - b.line || (a.to < b.to ? -1 : 1));
  const sorted = [...internal].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line));
  for (const e of sorted) {
    if (!e.names || !e.names.length || e.names[0] === '*') continue;
    const bound = bindings.get(e.to);
    if (!bound) continue;
    for (const name of e.names) {
      const boundAt = bound.get(name);
      if (boundAt === undefined) continue; // not a module-scope binding we know (submodule, __getattr__, star import)
      const hit = reaches(e.to, e.from, out, set, boundAt);
      if (hit) return { entry: e.to, module: e.specifier, name, boundAt, viaLine: hit.viaLine, importer: e.from, line: e.line, chain: hit.chain };
    }
  }
  return null;
}

// BFS from `start` to `target` through eager edges inside the SCC; the first
// hop out of `start` must sit above `beforeLine`. Returns the chain of files.
function reaches(start, target, out, set, beforeLine) {
  for (const first of out.get(start) || []) {
    if (first.line >= beforeLine) continue;
    // `start` is already in sys.modules (half-built); re-importing it returns at once, so never walk through it again.
    const prev = new Map([[start, null], [first.to, start]]);
    const queue = [first.to];
    while (queue.length) {
      const v = queue.shift();
      if (v === target) {
        const chain = [v]; let p = prev.get(v);
        while (p !== null) { chain.unshift(p); p = prev.get(p); }
        return { viaLine: first.line, chain };
      }
      for (const e of out.get(v) || []) if (set.has(e.to) && !prev.has(e.to)) { prev.set(e.to, v); queue.push(e.to); }
    }
  }
  return null;
}

function tarjan(nodes, edges) {
  const out = new Map(nodes.map((n) => [n, []]));
  for (const e of edges) out.get(e.from).push(e.to);
  for (const list of out.values()) list.sort();
  let index = 0;
  const idx = new Map(); const low = new Map(); const onStack = new Set(); const stack = [];
  const sccs = [];
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index += 1; stack.push(v); onStack.add(v);
    for (const w of out.get(v)) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const scc = []; let w;
      do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1) sccs.push(scc.sort());
    }
  };
  for (const n of nodes) if (!idx.has(n)) strong(n);
  return sccs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function shortestCycle(start, edges, set) {
  const out = new Map();
  for (const e of edges) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e.to);
  for (const list of out.values()) list.sort();
  const prev = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const v = queue.shift();
    for (const w of out.get(v) || []) {
      if (!set.has(w)) continue;
      if (w === start) { const path = [v]; let p = prev.get(v); while (p !== null) { path.unshift(p); p = prev.get(p); } return path; }
      if (!prev.has(w)) { prev.set(w, v); queue.push(w); }
    }
  }
  return [start];
}
