# Bauify

Deterministic, evidence-first code analysis that produces facts, findings, and
[Archify](https://github.com/tt-a1i/archify) architecture IR.

Bauify answers two questions about a repository from static evidence alone:
is the module coupling reasonable, and is the code concise? Every finding it
emits traces back to a file, line, import edge, or commit set. Bauify never
executes the analyzed code and never calls an LLM; explanation is left to
whoever consumes `findings.json`.

```
target repo ─▶ extract ─▶ graphs ─▶ evaluate ─▶ report ─┬─▶ bridge ─▶ Archify (validate / deliver)
                 │           │          │          │      └─▶ your agent, CI gate, …
            raw-facts   5 graphs   findings   per-dimension
```

Archify validates, lays out, and renders; Bauify owns language parsing,
module resolution, and dependency accuracy. The two are separate installs
that meet at Archify's existing typed JSON IR.

## Status

Milestone M1, step one: `extract` produces a schema-validated,
byte-deterministic `raw-facts.json` (files, roles, import edges) for JS/TS
via the TypeScript Compiler API. Module graph, rules, and the Archify bridge
follow. See [ARCHITECTURE.md](ARCHITECTURE.md) (Chinese) for the full design,
rule catalog, and the feasibility triage behind it.

## Install

```bash
git clone https://github.com/yijiez666-alt/bauify.git
cd bauify
npm ci
```

Node ≥ 18. No global install is needed; run the CLI with `node bin/analyze.mjs`
or `npx bauify` from the checkout.

## Usage

```bash
node bin/analyze.mjs extract <repo-root> --out out/raw-facts.json --json
```

`--json` prints a machine-readable receipt:

```json
{
  "schemaVersion": 1, "status": "ok", "command": "extract", "adapter": "ts",
  "files": 137, "imports": 849, "resolved": 132,
  "unresolved": { "external": 713, "outside": 4, "unknown": 0 },
  "revision": "06bd6fea5752bc06b8170a1f09085c798df5aa13"
}
```

Unresolved imports are kept and counted, never dropped: `external` is a bare
or `node:` specifier, `outside` resolved to a file beyond the analyzed root,
`unknown` is a path-like specifier that did not resolve. Misses stay visible.

Every failure exits non-zero with one structured diagnostic
(`code / severity / subject / evidence / supportedFixes`); `--json` never
prints a stack trace.

## End to end with Archify

Once the bridge lands (M1 step three), the intended loop is:

```bash
node bin/analyze.mjs run <repo-root> --out out/
node <archify>/bin/archify.mjs deliver architecture out/repo.architecture.json out/repo.html \
  --quality showcase --repo-root <repo-root> --json
```

Bauify writes Archify's `architecture` IR with `meta.repository` pinned to the
analyzed commit and node `sources` pointing at module entry files, so
Archify's own repository-evidence checks verify the map against the code.

## Tests

```bash
npm test
```

Fixture and regression tests run anywhere. The self-bootstrap tests analyze
Archify's own renderer package and need a checkout of `tt-a1i/archify`: by
default a sibling directory `../archify` is used; set `BAUIFY_ARCHIFY_ROOT`
to point elsewhere. They are skipped (not failed) when it is absent. CI pins
that checkout to a fixed revision.

## Origin

Bauify started as a proposed `analyzers/` subsystem of Archify
([PR #352](https://github.com/tt-a1i/archify/pull/352)). Archify's author
suggested keeping code analysis in an external tool so Archify can stay
focused on validation and rendering; this repository is that tool, with the
PR's history and authorship preserved. See [NOTICE](NOTICE).

## License

MIT — see [LICENSE](LICENSE).
