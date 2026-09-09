// coupling/cycle — module-level (package / directory) strongly connected
// components. A module cycle says two directories each need something from
// the other; it does NOT by itself mean a file imports itself back, which is
// what coupling/import-cycle checks. Module granularity can manufacture a
// cycle out of two unrelated files in one directory, so this is reported as
// info: a design signal to read next to the file-level result.
export const code = 'coupling/cycle';
export const dimension = 'coupling';
export const severity = 'info';
export const confidence = 1.0;

// An edge is "lazy-only" when every import behind it sits inside a function
// body: the modules still depend on each other by design, but nothing runs at
// import time, so Python will not raise a circular-import error.
const lazyOnly = (e) => (e.kinds.lazy || 0) > 0 && e.kinds.lazy === e.weight;

export function run({ graph }) {
  const ids = graph.modules.map((m) => m.id).sort();
  const sccsOf = (edges) => tarjan(ids, edges);
  const all = sccsOf(graph.edges);
  const eager = sccsOf(graph.edges.filter((e) => !lazyOnly(e)));
  const eagerKey = new Set(eager.map((scc) => scc.join(' ')));

  const labelOf = new Map(graph.modules.map((m) => [m.id, m.label]));
  const out = new Map(ids.map((id) => [id, []]));
  for (const e of graph.edges) out.get(e.from).push(e.to);
  for (const list of out.values()) list.sort();
  const sccs = all;
  return sccs.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1)).map((scc) => {
    const set = new Set(scc);
    const internal = graph.edges.filter((e) => set.has(e.from) && set.has(e.to));
    const path = shortestCycle(scc[0], out, set);
    // Does this exact SCC still exist once lazy-only edges are removed? If not,
    // the cycle is closed only by function-scope imports: a design cycle that
    // is safe at import time. Reported as a warning, with the closing imports.
    const eagerSurvives = eagerKey.has(scc.join(' ')) || eager.some((e) => e.length > 1 && e.every((m) => set.has(m)) && e.length === scc.length);
    const lazyEdges = internal.filter(lazyOnly);
    const kind = eagerSurvives ? 'eager' : 'lazy-closed';
    return {
      code, dimension, severity, confidence,
      message: eagerSurvives
        ? `${scc.length} modules depend on each other at package level: ${path.map((id) => labelOf.get(id)).join(' → ')} → ${labelOf.get(path[0])}. See coupling/import-cycle for whether any file actually cycles.`
        : `${scc.length} modules depend on each other at package level, closed only by function-scope (lazy) imports: ${path.map((id) => labelOf.get(id)).join(' → ')} → ${labelOf.get(path[0])}.`,
      subject: { modules: scc },
      evidence: {
        kind,
        path,
        edges: internal.map((e) => ({ from: e.from, to: e.to, weight: e.weight, lazy: e.kinds.lazy || 0 })),
        closingLazyImports: lazyEdges.flatMap((e) => e.evidence.map((v) => ({ file: v.file, line: v.line, to: v.to }))).slice(0, 8),
        imports: internal.flatMap((e) => e.evidence.slice(0, 2).map((v) => ({ file: v.file, line: v.line, to: v.to, ...(v.lazy ? { lazy: true } : {}) }))).slice(0, 12),
        totalImports: internal.reduce((n, e) => n + e.weight, 0),
        threshold: null,
      },
      supportedFixes: [
        'move the shared piece both sides need into a new leaf module',
        'invert one edge by passing the dependency in as a parameter',
        'if one direction is a single import, check whether it is a convenience re-export that can be dropped',
      ],
    };
  });
}

function tarjan(ids, edges) {
  const out = new Map(ids.map((id) => [id, []]));
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
      const scc = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1) sccs.push(scc.sort());
    }
  };
  for (const id of ids) if (!idx.has(id)) strong(id);
  return sccs;
}

// BFS from `start` back to itself inside the SCC: one concrete, short cycle to quote.
function shortestCycle(start, out, set) {
  const prev = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const v = queue.shift();
    for (const w of out.get(v)) {
      if (!set.has(w)) continue;
      if (w === start) {
        const path = [v];
        let p = prev.get(v);
        while (p !== null) { path.unshift(p); p = prev.get(p); }
        return path;
      }
      if (!prev.has(w)) { prev.set(w, v); queue.push(w); }
    }
  }
  return [start];
}
