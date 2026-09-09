"""Python import extractor for Bauify.

Reads a JSON document on stdin: {"root": "<abs dir>", "files": ["rel/path.py", ...]}
Writes a JSON document on stdout:
  {"files": [{"path", "loc", "imports": [...], "symbols": [...], "error"?}], "python": "3.x.y"}
Each symbol is a module-scope binding: {"name", "kind": "function"|"class"|"variable"|"import", "line"}
  (the line where the name becomes bound; what a `from m import name` elsewhere
  needs to have executed already when `m` is only partially initialised).
Each import: {"line", "kind": "static"|"dynamic", "level", "module", "names"}
  - `import a.b as c`       -> level 0, module "a.b",  names ["*"]
  - `from a.b import x, y`  -> level 0, module "a.b",  names ["x", "y"]
  - `from . import x`       -> level 1, module "",     names ["x"]
  - `from ..p import *`     -> level 2, module "p",    names ["*"]
  - importlib.import_module("a.b") / __import__("a.b") with a literal -> kind "dynamic"
Resolution against the file set happens in Node so both adapters share one policy.
Standard library only; no third-party imports.
"""
import ast
import json
import platform
import sys


def line_count(text):
    if not text:
        return 0
    lines = text.splitlines()
    return len(lines)


def literal_module(node):
    if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
        return node.args[0].value
    return None


def collect(tree):
    """Walk with scope tracking: an import statement inside a def/async def is
    executed only when that function runs, so it is marked lazy. Lazy imports
    are how Python code deliberately dodges import-time cycles; the module
    graph keeps them as edges but the cycle rule reports them separately."""
    found = []
    lazy_ranges = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            lazy_ranges.append((node.lineno, getattr(node, "end_lineno", node.lineno)))
    def is_lazy(line):
        return any(a <= line <= b for a, b in lazy_ranges)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.append({"line": node.lineno, "kind": "static", "level": 0,
                              "module": alias.name, "names": ["*"], "lazy": is_lazy(node.lineno)})
        elif isinstance(node, ast.ImportFrom):
            names = sorted(alias.name for alias in node.names)
            found.append({"line": node.lineno, "kind": "static", "level": node.level or 0,
                          "module": node.module or "", "names": names, "lazy": is_lazy(node.lineno)})
        elif isinstance(node, ast.Call):
            func = node.func
            target = None
            if isinstance(func, ast.Attribute) and func.attr == "import_module" \
                    and isinstance(func.value, ast.Name) and func.value.id == "importlib":
                target = literal_module(node)
            elif isinstance(func, ast.Name) and func.id == "__import__":
                target = literal_module(node)
            is_loader = (isinstance(func, ast.Attribute) and func.attr == "import_module"
                         and isinstance(func.value, ast.Name) and func.value.id == "importlib") \
                or (isinstance(func, ast.Name) and func.id == "__import__")
            if is_loader and target is None:
                found.append({"line": node.lineno, "kind": "dynamic", "level": 0,
                              "module": "<computed>", "names": [], "opaque": True})
            elif target is not None:
                found.append({"line": node.lineno, "kind": "dynamic", "level": 0,
                              "module": target, "names": []})
    found.sort(key=lambda i: (i["line"], i["module"]))
    return found


def module_bindings(tree):
    """Module-scope names in the order they are bound. Walks into if/try/with
    blocks at module level (still executed at import time) but not into
    function or class bodies. Later re-bindings keep the first line: the name
    exists from then on."""
    seen = {}
    def bind(name, kind, line):
        if name not in seen:
            seen[name] = {"name": name, "kind": kind, "line": line}
    def targets(node):
        if isinstance(node, ast.Name):
            return [node.id]
        if isinstance(node, (ast.Tuple, ast.List)):
            return [n for elt in node.elts for n in targets(elt)]
        return []
    def walk(body):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                bind(node.name, "function", node.lineno)
            elif isinstance(node, ast.ClassDef):
                bind(node.name, "class", node.lineno)
            elif isinstance(node, ast.Assign):
                for t in node.targets:
                    for name in targets(t):
                        bind(name, "variable", node.lineno)
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
                for name in targets(node.target):
                    bind(name, "variable", node.lineno)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    bind(alias.asname or alias.name.split(".")[0], "import", node.lineno)
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name != "*":
                        bind(alias.asname or alias.name, "import", node.lineno)
            elif isinstance(node, (ast.If, ast.Try, ast.With, ast.For, ast.While)):
                for attr in ("body", "orelse", "finalbody", "handlers"):
                    for child in getattr(node, attr, []) or []:
                        if isinstance(child, ast.ExceptHandler):
                            walk(child.body)
                        else:
                            walk([child])
    walk(tree.body)
    return sorted(seen.values(), key=lambda b: (b["line"], b["name"]))


def main():
    request = json.load(sys.stdin)
    root = request["root"]
    out = []
    for rel in request["files"]:
        path = root + "/" + rel
        with open(path, "rb") as handle:
            raw = handle.read()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1")
        record = {"path": rel, "loc": line_count(text), "imports": [], "symbols": []}
        try:
            tree = ast.parse(text, filename=rel)
            record["imports"] = collect(tree)
            record["symbols"] = module_bindings(tree)
        except SyntaxError as error:
            record["error"] = "%s (line %s)" % (error.msg, error.lineno)
        out.append(record)
    json.dump({"files": out, "python": platform.python_version()}, sys.stdout)


if __name__ == "__main__":
    main()
