# Bauify

Deterministic, evidence-first code analysis that layers what a codebase
*imports* onto the architecture diagram an agent or a person drew with
[Archify](https://github.com/tt-a1i/archify).

Bauify answers one question from static evidence alone: is the module
coupling reasonable? It reads the source, resolves every import, folds files
into modules, runs a small set of rules, and reports what it found as facts —
each one traced to a file, line, import edge, and commit — rather than as a
verdict on the design. Bauify never executes the analyzed code and never
calls an LLM.

```
target repo ─▶ extract ─▶ graphs ─▶ evaluate ─┐
                 │           │         │       ├─▶ overlay ─▶ repo.analysis.html
            raw-facts   module-graph  findings │
                                               │
   architecture.json ─▶ Archify deliver ─▶ repo.html
   (hand-authored)
```

Archify validates, lays out, and renders; Bauify owns language parsing,
module resolution, and dependency accuracy. They are separate installs. Bauify
never modifies the IR or the delivered HTML — `overlay` writes a new file
next to it, and with the **Code analysis** button off that file is exactly
Archify's artifact.

## What you get

![ai-voice with the analysis layer on](docs/e2e/ai-voice-overlay.png)

The checked-in pages below are historical demonstration snapshots. Regenerate
them with Quick start to use the current extraction and conservative risk rules:

| repository | delivered by Archify, analysis layered on top | result |
|---|---|---|
| AI-voice-assistant (Python, 171 files, 24 modules) | [`docs/e2e/ai-voice.analysis.html`](docs/e2e/ai-voice.analysis.html) · [open in browser](https://htmlpreview.github.io/?https://github.com/yijiez666-alt/bauify/blob/main/docs/e2e/ai-voice.analysis.html) | 0 errors · 1 warning (`tools` is a hub) · 2 info (a runtime cycle closed by lazy imports, its package-level shadow) |
| Archify's own `archify/` package (JavaScript, 11 modules) | [`docs/e2e/archify.analysis.html`](docs/e2e/archify.analysis.html) · [open in browser](https://htmlpreview.github.io/?https://github.com/yijiez666-alt/bauify/blob/main/docs/e2e/archify.analysis.html) | 0 errors · 0 warnings · 0 info |

Each page is self-contained (data, styles, script, and the cited source
files are embedded), so it works from a local file with no server; the
"open in browser" links go through a third-party previewer, and downloading
the file is the dependable way. With the button off, each page is
byte-for-byte what `archify deliver` produced plus the appended analysis
blocks — Archify's own artifact was never modified.

With **Code analysis** on, the authored diagram and guided views recede and
every component gets a halo just outside its box, coloured by danger level;
a legend next to the button spells the levels out:

| colour | level | meaning |
|---|---|---|
| red (pulsing) | critical | an error was supplied in findings; inspect its evidence (current cycle rules emit no errors) |
| amber | warning | an eager import cycle whose behaviour depends on import order, or a hub module |
| blue | info | deferred/conditional or package-level coupling; initialization behavior is not established |
| green | clean | no rule fired |
| grey | unmapped | no source code maps to this component |

Clicking a component opens a panel with its indicators (circular dependency,
hub module, instability), the mapped modules, every file with LOC and import
counts, and the module edges with file:line evidence. Clicking an indicator
opens a second panel with the findings behind it and a small diagram Bauify
draws to explain them: the cycle as a ring with lazy edges dashed, the hub as
a star of dependents and dependencies with links to its source files,
instability as in/out bars. Every file:line a finding cites is a button; with
`--source` it opens the whole file in a third, draggable panel, scrolled to
the cited line. GitHub links are pinned to the analyzed commit. No import
lines are drawn on the diagram itself.

## Quick start

```bash
git clone https://github.com/yijiez666-alt/bauify.git && cd bauify && npm ci
```

Node ≥ 18. Python 3.8+ on `PATH` (`python3`, `python`, or the `py` launcher)
is needed only for Python repositories; `BAUIFY_PYTHON` picks an interpreter
explicitly. The commands below assume a checkout of `tt-a1i/archify` next to
this one.

One command runs the whole workflow — Bauify's pipeline, `archify deliver` on
the hand-authored diagram, and the overlay — into one directory:

```bash
node bin/analyze.mjs analyze ../ai-voice-assistant --language py \
  --ir examples/ai-voice.manual.architecture.json --map examples/ai-voice.overlay-map.json \
  --out out/ai-voice --json
```

Open `out/ai-voice/repo.analysis.html`. Archify is found at `--archify`,
`$BAUIFY_ARCHIFY_ROOT`, or the sibling `../archify` checkout, and is invoked
through its own CLI exactly as you would by hand; if it refuses the IR, its
receipt is passed through under `evidence.archify`. For Archify's own package
use `--ir ../archify/examples/archify-repo.architecture.json --map
examples/archify.overlay-map.json` and no `--language`.

The same thing as three separate steps, if you want to inspect or rerun one of them:

```bash
# 1. analyze the repository: raw-facts, module-graph, findings (and a bridge IR, see below)
node bin/analyze.mjs run ../ai-voice-assistant --language py --out out/ai-voice --json

# 2. deliver the hand-authored diagram with Archify, as usual
node ../archify/archify/bin/archify.mjs deliver architecture \
  examples/ai-voice.manual.architecture.json out/ai-voice/repo.html \
  --quality standard --repo-root ../ai-voice-assistant --json

# 3. layer the analysis on top — a new file; the delivered HTML is untouched
node bin/analyze.mjs overlay out/ai-voice/repo.html \
  examples/ai-voice.manual.architecture.json out/ai-voice/module-graph.json \
  --map examples/ai-voice.overlay-map.json --source ../ai-voice-assistant \
  --out out/ai-voice/repo.analysis.html --json
```

Components map to modules through the `sources` in the IR; `--map` overrides
that with `{"componentId": ["moduleId", …]}` (module ids are in
`module-graph.json`; `examples/ai-voice.overlay-map.json` pairs with
`examples/ai-voice.manual.architecture.json`). Modules no component claims
are listed in the panel as "not on this diagram" rather than dropped.
`overlay` picks up `raw-facts.json` and `findings.json` next to the module
graph automatically. `--source <analyzed dir>` embeds the full text of every
file a finding cites — only those files, not the repository; without it the
code references still link to GitHub.

## Rules

Findings come from `evaluate`, which runs every rule independently and echoes
each threshold it used into the finding's evidence so a reader can re-check
the call. A cycle is reported as a fact with `evidence.risk.loading` rather
than as a judgment about the design; "LLM calls tools, a tool calls the LLM
back" is a normal runtime shape, and Bauify says so instead of flagging it.

- `coupling/import-cycle` — runtime file-level cycles. Type-only imports are
  retained in raw facts and the structural module graph, but excluded here.
  **info** (`loading: not-proven`): the component contains deferred or
  conditional imports. A function may be called during initialization; this
  classification is not a safety guarantee. **warning** (`potential-at-import`):
  a module-scope cycle. If recorded binding order suggests an early named
  read, `potential-partial-init` includes a `partialInitCandidate` with the
  assumed entry, chain and lines. Static line ordering does not model full
  execution, so it no longer produces `proven-failure` or error severity.
  Runtime-risk confidence is 0.7, an ordinal heuristic level, not a calibrated
  probability. Smaller module-scope cycles inside mixed components are
  reported separately.
- `coupling/cycle` — package-level strongly connected components on the
  module graph; info. Often an artifact of directory grouping; it points at
  `import-cycle` for whether any file actually cycles.
- `coupling/hub` — a module that is both widely depended on and depends
  widely (fan-in ≥ 5 and fan-out ≥ 5 by default; warning). A coordination
  point, not a bug; the dependents list usually shows where a split would go.

Rules are independent modules under `evaluate/rules/`; `coupling/layer-violation`
and the `redundancy/*` family are next. See [ARCHITECTURE.md](ARCHITECTURE.md)
for the design, the full rule catalog, and the feasibility triage behind it,
and [docs/TECH-GUIDE.md](docs/TECH-GUIDE.md) for a walk through the
technology behind each stage.

## Pipeline

- `extract` — JS/TS via the TypeScript Compiler API; Python via the standard
  library `ast` (relative imports, packages, PEP 420 namespace packages,
  `importlib.import_module` literals, function-scope imports flagged `lazy`,
  module-scope symbol bindings with their line). Both adapters record lexical
  deferral and type-only imports; Python also records conditional imports and
  implicit package initialization. TypeScript reads tsconfig options, including
  path aliases and verbatimModuleSyntax. Output is schema-validated
  and byte-deterministic.
- `graphs` — folds file edges into modules (explicit groups > package
  boundary > directory depth; root-level files are modules of their own),
  with fan-in / fan-out / instability and up to five file:line evidence
  entries per edge. These are structural metrics, including type dependencies,
  not runtime reliability scores. Colliding module IDs receive deterministic
  suffixes; exact file ownership is saved in `fileModules`. Test and generated files are excluded and counted.
- `evaluate` — the rules above, stable ids (`COUP-0001`), `config.ignore`
  to suppress a rule.
- `overlay` — the analysis layer described above, injected into a copy of an
  Archify-delivered HTML.
- `bridge` — an Archify `architecture` IR generated from the module graph
  (one column per module, layered lanes, at most 12 nodes, evidence mode when
  the repository has a 40-hex revision and a github.com origin). It renders
  and passes `deliver`, but a folded dependency graph is far more detailed
  than a diagram a person would draw, so the overlay on a hand-authored map
  is the main path and the bridge is kept as a capability. `run` still
  writes it.
- `run` — extract → graphs → evaluate → bridge into one directory.
- `analyze` — `run`, then `archify deliver` on a hand-authored IR, then `overlay`, into one directory.

```bash
node bin/analyze.mjs analyze  <repo-root> --ir <architecture.json> --out <dir> [--map …] [--language ts|py] [--archify <dir>] [--quality standard|showcase]
node bin/analyze.mjs run      <repo-root> --out <dir> [--language ts|py] [--config file.json] [--json]
node bin/analyze.mjs extract  <repo-root> [--out raw-facts.json] [--language ts|py] [--json]
node bin/analyze.mjs graphs   raw-facts.json [--out module-graph.json]
node bin/analyze.mjs evaluate module-graph.json [--facts raw-facts.json] [--out findings.json]
node bin/analyze.mjs bridge   module-graph.json [--out repo.architecture.json]
node bin/analyze.mjs overlay  <archify.html> <ir.json> <module-graph.json> --out <analysis.html> [--map …] [--source …]
```

A tree containing both JS/TS and Python files must name the language; Bauify
refuses to guess. Every failure exits non-zero with one structured diagnostic
(`code / severity / subject / evidence / supportedFixes`); `--json` never
prints a stack trace.

Unresolved imports are kept and counted, never dropped: `external` (bare or
`node:` specifier), `outside` (resolved beyond the analyzed root), `unknown`
(path-like but missing), `opaque` (`import()` / `require()` / `import_module()`
with a computed argument). A module reached only through `spawnSync` or a
computed `import()` therefore shows no edge — the count says so.

Configuration (all optional; see `config/defaults.json`):

```json
{
  "include": ["**/*.py"],
  "exclude": ["**/venv*/**", "**/logs/**"],
  "modules": { "depth": 2, "groups": { "core": ["src/core/**"] }, "excludeRoles": ["test", "generated"] },
  "rules": { "coupling": { "hub": { "fanIn": 5, "fanOut": 5 } } },
  "ignore": [],
  "bridge": { "maxNodes": 12, "minWeight": 1, "qualityProfile": "standard", "types": { "ui": "frontend" } }
}
```

## For Archify users

Nothing in your workflow changes. Keep authoring the IR; `bauify analyze`
runs your usual `archify deliver` for you and adds the overlay next to it, or
run `bauify run` and `bauify overlay` around your own `deliver` call. Bauify depends on a few hooks in Archify's
viewer — `g[data-node-id]`, `path[data-edge-id]`, `.toolbar`, and the
`--panel` / `--panel-border` / `--bg` / `--text` / `--text-muted` CSS
variables — and on nothing else; it reads the IR only to map components to
modules.

## Tests

```bash
npm test
```

Fixture and regression tests run anywhere, including type-only imports, dynamic scope, package initialization, ID
collisions, graph references and file ownership. Test-authored Python/JS
fixtures are executed to compare risk estimates with actual loading; analyzed
repositories are never executed by the analyzer. The tests that analyze Archify's own package or call
Archify's validator need a checkout of `tt-a1i/archify`: a sibling
`../archify` is used by default; set `BAUIFY_ARCHIFY_ROOT` to point
elsewhere. They are skipped, not failed, when it is absent. CI pins that
checkout to a fixed revision.

## Known limits

- This is static dependency analysis, not a full interpreter or call graph.
  Deferred functions, callbacks, decorators, guards, exception handling,
  import caches, module attributes and dynamic bindings can change loading.
  No cycle finding or clean indicator proves runtime success or failure.
- Type-only recognition covers explicit TypeScript forms and unshadowed
  Python `typing.TYPE_CHECKING` aliases. Arbitrary typing guards and dynamic
  loader aliases may remain runtime/unknown dependencies.
- Graph validation checks unique module IDs, existing edge endpoints,
  duplicate edge pairs, and exact ownership when available. JSON Schema
  alone cannot establish those relationships.
- Output includes new optional import flags and `fileModules`; regenerate old
  raw-facts, module-graph, findings and overlays together. The old risk labels
  `none-at-import` / `proven-failure` are not emitted by current cycle rules.
- Archify's `showcase` profile rejects every edge crossing. A module map
  folded from a real dependency graph is usually non-planar, so the bridge
  declares `standard` by default; dense graphs render with crossing warnings
  rather than failing.
- The bridge layout is one column per module, so a map with many top-level
  modules is wide and a deep chain is tall. Compaction is parked with the
  bridge.

## Origin

Bauify started as a proposed `analyzers/` subsystem of Archify
([PR #352](https://github.com/tt-a1i/archify/pull/352)). Archify's author
suggested keeping code analysis in an external tool so Archify can stay
focused on validation and rendering; this repository is that tool, with the
PR's history and authorship preserved. See [NOTICE](NOTICE).

## License

MIT — see [LICENSE](LICENSE).
