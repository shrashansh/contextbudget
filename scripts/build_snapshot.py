#!/usr/bin/env python3
"""ContextBudget snapshot builder (Milestone 1).

Parses vendor/<repo>/<pkg>/ with stdlib `ast` only and emits
snapshots/<repo>.json per the frozen types in BUILD.md §2.

Usage:
    python scripts/build_snapshot.py                 # both repos, no tokens
    python scripts/build_snapshot.py --repo fastapi  # one repo
    python scripts/build_snapshot.py --self-check    # assert httpx re-export resolution
    python scripts/build_snapshot.py --tokens        # count via count_tokens (needs key+anthropic)
"""
from __future__ import annotations

import argparse
import ast
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vendor")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "snapshots")
REPOS = {"fastapi": "fastapi", "httpx": "httpx"}  # repo -> package dir inside vendor/<repo>/
SEP = "\n\n"  # pack separator between rendered symbols (BUILD.md §4 2% reserve absorbs merges)


# ---------------------------------------------------------------- source utils

def slice_region(lines, start, end):
    """Slice source region [(sl, sc), (el, ec)) from a list of source lines."""
    sl, sc = start
    el, ec = end
    if el < sl:
        return ""
    if el == sl:
        return lines[sl - 1][sc:ec]
    out = [lines[sl - 1][sc:]]
    out.extend(lines[sl:el - 1])
    out.append(lines[el - 1][:ec])
    return "\n".join(out)


def split_doc(value):
    if not value:
        return "", ""
    lines = value.split("\n")
    # First NON-EMPTY line is docFirstLine (a leading blank line in a raw
    # docstring would otherwise put the whole thing in docRest). docRest keeps
    # the remaining lines as-is.
    first = ""
    rest = []
    started = False
    for l in lines:
        if not started:
            if l.strip():
                first = l
                started = True
        else:
            rest.append(l)
    return first, "\n".join(rest)


def doc_string(node):
    # ast.get_docstring(clean=True) strips the docstring's indentation and
    # leading/trailing blank lines, so the first split line is real content
    # (BUILD §3). The raw Constant.value can start with "\n", which is what
    # broke docFirstLine.
    try:
        return ast.get_docstring(node, clean=True)
    except TypeError:
        return None


# ---------------------------------------------------------------- symbol shape

def base_symbol(file_rel, kind, name, qualname, line_start, line_end,
                signature, doc_first, doc_rest, body):
    return {
        "id": None,  # assigned later, after collision detection
        "file": file_rel,
        "kind": kind,
        "name": name,
        "qualname": qualname,
        "lineStart": line_start,
        "lineEnd": line_end,
        "signature": signature,
        "docFirstLine": doc_first,
        "docRest": doc_rest,
        "body": body,
        "tokens": None,
    }


def func_symbol(node, qualname, kind, file_rel, lines):
    start = (node.lineno, node.col_offset)
    first = node.body[0] if node.body else None
    end = (first.lineno, first.col_offset) if first else (node.end_lineno, node.end_col_offset)
    signature = slice_region(lines, start, end).strip()
    doc = doc_string(node)
    doc_first, doc_rest = split_doc(doc)
    if doc is not None and first is not None:
        bstart = (first.end_lineno, first.end_col_offset)
    else:
        bstart = (first.lineno, first.col_offset) if first else start
    body = slice_region(lines, bstart, (node.end_lineno, node.end_col_offset))
    return base_symbol(file_rel, kind, node.name, qualname, node.lineno, node.end_lineno,
                       signature, doc_first, doc_rest, body)


def is_docstring_stmt(stmt):
    # A module/class/function docstring is the first statement, an Expr whose
    # value is a string Constant.
    return (isinstance(stmt, ast.Expr)
            and isinstance(stmt.value, ast.Constant)
            and isinstance(stmt.value.value, str))


def class_symbols(node, file_rel, lines):
    start = (node.lineno, node.col_offset)
    first = node.body[0] if node.body else None
    end = (first.lineno, first.col_offset) if first else (node.end_lineno, node.end_col_offset)
    signature = slice_region(lines, start, end).strip()
    doc = doc_string(node)
    doc_first, doc_rest = split_doc(doc)
    # Class body = class-level code ONLY (attributes, nested classes, etc.),
    # NOT method definitions — methods are separate symbols (BUILD §3) and
    # including them here double-counts the source. Skip the docstring too
    # (it is carried in docFirstLine/docRest).
    class_stmts = [s for s in node.body
                   if not isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef))
                   and not is_docstring_stmt(s)]
    body_parts = []
    for s in class_stmts:
        body_parts.append(slice_region(lines, (s.lineno, s.col_offset),
                                       (s.end_lineno, s.end_col_offset)))
    body = "\n\n".join(p for p in body_parts if p.strip())
    cls = base_symbol(file_rel, "class", node.name, node.name, node.lineno, node.end_lineno,
                      signature, doc_first, doc_rest, body)
    out = [cls]
    for stmt in node.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append(func_symbol(stmt, f"{node.name}.{stmt.name}", "method", file_rel, lines))
    return out


def extract_symbols(tree, file_rel, lines):
    symbols = []
    mod_doc = doc_string(tree)
    doc_first, doc_rest = split_doc(mod_doc)
    short = file_rel.rsplit("/", 1)[-1]
    if short == "__init__.py":
        short = file_rel.split("/")[-2]  # package dir name
    else:
        short = short[:-3]
    symbols.append(base_symbol(file_rel, "module", short, "<module>", 1, len(lines),
                               "", doc_first, doc_rest, ""))
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.append(func_symbol(stmt, stmt.name, "func", file_rel, lines))
        elif isinstance(stmt, ast.ClassDef):
            symbols.extend(class_symbols(stmt, file_rel, lines))
    return symbols


def assign_ids(all_symbols):
    """Set symbol.id per BUILD.md §2 and return {(file, qualname): id} for edges."""
    byq = defaultdict(list)
    for s in all_symbols:
        byq[(s["file"], s["qualname"])].append(s)
    idmap = {}
    for (file_rel, q), lst in byq.items():
        if len(lst) == 1:
            lst[0]["id"] = f"{file_rel}::{q}"
        else:
            for s in lst:
                s["id"] = f"{file_rel}::{q}#{s['lineStart']}"
        for s in lst:
            idmap[(file_rel, q)] = s["id"]
    return idmap


# ---------------------------------------------------------------- module index / imports

def module_index(files):
    """Return idx {full_dotted: file_rel}, rev {file_rel: full_dotted},
    pkg {file_rel: current package dotted} for relative-import resolution."""
    idx, rev, pkg = {}, {}, {}
    for fp in files:
        repo = fp.split("/", 1)[0]
        pkg_rel = fp.split("/", 1)[1]  # path under vendor/<repo>/<pkg>/
        dotted = pkg_rel.rsplit(".", 1)[0].replace("/", ".")
        if dotted.endswith("__init__"):
            dotted = dotted[:-9]
        full = f"{repo}.{dotted}" if dotted else repo
        idx[full] = fp
        rev[fp] = full
        # current package for `from .` — the module itself if it's a package __init__, else parent
        is_pkg_init = fp.endswith("__init__.py")
        if is_pkg_init:
            pkg[fp] = full
        else:
            pkg[fp] = full.rsplit(".", 1)[0] if "." in full else full
    return idx, rev, pkg


def import_target_module(stmt, file_rel, idx, pkg):
    """Return full dotted path of the module an ImportFrom targets, or None if external."""
    level = stmt.level
    module = stmt.module or ""
    if level == 0:
        # Absolute self-import (from fastapi.x import y). The dotted module is already
        # a full index key when it lives inside the indexed package; anything else is
        # external (typing, starlette) and produces no edge.
        return module if module in idx else None
    base = pkg[file_rel].split(".") if pkg[file_rel] else []
    if level > 1:
        if level - 1 >= len(base):
            return None
        base = base[:-(level - 1)]
    if module:
        base = base + module.split(".")
    full = ".".join(base)
    return full if full in idx else None


def defined_names(symbols):
    """{name: (file, qualname)} for top-level funcs/classes (not methods, not module)."""
    out = {}
    for s in symbols:
        if s["kind"] in ("func", "class"):
            out[s["name"]] = (s["file"], s["qualname"])
    return out


def build_exports(all_files, parsed, idx, pkg):
    """Fixpoint over imports to resolve re-export chains (BUILD.md §3).

    exports[file] = {name: (file, qualname)}. Defined names win over imports.
    Star imports union the target module's exports (handles httpx's `from ._client import *`).
    """
    exports = {}
    for f in all_files:
        exports[f] = dict(parsed[f]["defined"])
    pending = [(f, stmt) for f in all_files for stmt in parsed[f]["imports"]
               if isinstance(stmt, ast.ImportFrom)]
    changed, guard = True, 0
    while changed and guard < 1000:
        guard += 1
        changed = False
        for f, stmt in pending:
            full = import_target_module(stmt, f, idx, pkg)
            if full is None:
                continue
            tfile = idx[full]
            for alias in stmt.names:
                if alias.name == "*":
                    for name, sym in exports[tfile].items():
                        if name.startswith("_"):
                            continue
                        if name not in exports[f]:
                            exports[f][name] = sym
                            changed = True
                else:
                    bound = alias.asname or alias.name
                    if bound in exports[f]:
                        continue
                    sym = exports[tfile].get(alias.name)
                    if sym and exports[f].get(bound) != sym:
                        exports[f][bound] = sym
                        changed = True
    return exports


# ---------------------------------------------------------------- resolution

class Resolver:
    def __init__(self, idx, exports, idmap, known_qualnames):
        self.idx = idx
        self.exports = exports
        self.idmap = idmap
        self.known_qualnames = known_qualnames

    def resolve_in_module(self, tfile, rest):
        if not rest:
            return [(tfile, "<module>")]
        q = ".".join(rest)
        if (tfile, q) in self.idmap:
            return [(tfile, q)]
        parts = q.split(".")
        for k in range(len(parts) - 1, 0, -1):
            cand = ".".join(parts[:k])
            if cand in self.known_qualnames[tfile]:
                return [(tfile, cand)]
        return []

    def resolve_extension(self, ref, rest):
        if not rest:
            return [ref]
        file_rel, q = ref
        full = q + "." + ".".join(rest) if rest else q
        if (file_rel, full) in self.idmap:
            return [(file_rel, full)]
        parts = full.split(".")
        for k in range(len(parts) - 1, 0, -1):
            cand = ".".join(parts[:k])
            if cand in self.known_qualnames[file_rel]:
                return [(file_rel, cand)]
        return []

    def resolve(self, name, from_file):
        """Resolve a dotted name reference from a module scope to symbol refs."""
        parts = name.split(".")
        for i in range(len(parts), 0, -1):  # longest internal module-path prefix
            pfx = ".".join(parts[:i])
            if pfx in self.idx:
                return self.resolve_in_module(self.idx[pfx], parts[i:])
        ref = self.exports[from_file].get(parts[0])
        if ref is None:
            return []
        return self.resolve_extension(ref, parts[1:])

    def resolve_import_module(self, name, from_file):
        parts = name.split(".")
        for i in range(len(parts), 0, -1):
            pfx = ".".join(parts[:i])
            if pfx in self.idx:
                return self.resolve_in_module(self.idx[pfx], parts[i:])
        return []

    def resolve_fromimport(self, stmt, alias, file_rel, idx, pkg):
        full = import_target_module(stmt, file_rel, idx, pkg)
        if full is None:
            return []
        tfile = idx[full]
        if alias.name == "*":
            return list(dict.fromkeys(self.exports[tfile].values()))
        sym = self.exports[tfile].get(alias.name)
        if sym:
            return [sym]
        sub = full + "." + alias.name
        if sub in self.idx:
            return [(self.idx[sub], "<module>")]
        return []


# ---------------------------------------------------------------- edges

def name_refs(expr):
    out = set()
    for n in ast.walk(expr):
        if isinstance(n, ast.Name):
            out.add(n.id)
        elif isinstance(n, ast.Attribute):
            out.add(ast.unparse(n))
    return out


def mk(owner, kind, tgt, resolver):
    return {"from": resolver.idmap[owner], "to": resolver.idmap[tgt], "kind": kind,
            "weight": 1}


def func_edges(node, qualname, file_rel, resolver, idx, pkg):
    owner = (file_rel, qualname)
    edges = []
    for dec in node.decorator_list:
        for nm in name_refs(dec):
            for tgt in resolver.resolve(nm, file_rel):
                edges.append(mk(owner, "decorator", tgt, resolver))
    anns = [node.returns]
    a = node.args
    for arg in list(a.posonlyargs) + list(a.args) + list(a.kwonlyargs):
        anns.append(arg.annotation)
    anns.extend([a.vararg.annotation if a.vararg else None,
                 a.kwarg.annotation if a.kwarg else None])
    for an in (x for x in anns if x is not None):
        for nm in name_refs(an):
            for tgt in resolver.resolve(nm, file_rel):
                edges.append(mk(owner, "annotation", tgt, resolver))
    walk_stmts(node.body, file_rel, resolver, idx, pkg, edges, owner)
    return edges


def class_edges(node, file_rel, resolver, idx, pkg):
    owner = (file_rel, node.name)
    edges = []
    for dec in node.decorator_list:
        for nm in name_refs(dec):
            for tgt in resolver.resolve(nm, file_rel):
                edges.append(mk(owner, "decorator", tgt, resolver))
    for base in node.bases:
        for nm in name_refs(base):
            for tgt in resolver.resolve(nm, file_rel):
                edges.append(mk(owner, "inheritance", tgt, resolver))
    for stmt in node.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            edges.extend(func_edges(stmt, f"{node.name}.{stmt.name}", file_rel, resolver, idx, pkg))
        else:
            walk_stmts([stmt], file_rel, resolver, idx, pkg, edges, owner)
    return edges


def walk_stmts(stmts, file_rel, resolver, idx, pkg, edges, owner):
    for stmt in stmts:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue  # nested symbols handled at their own level
        if isinstance(stmt, ast.Import):
            for alias in stmt.names:
                for tgt in resolver.resolve_import_module(alias.name, file_rel):
                    edges.append(mk(owner, "import", tgt, resolver))
            continue
        if isinstance(stmt, ast.ImportFrom):
            for alias in stmt.names:
                for tgt in resolver.resolve_fromimport(stmt, alias, file_rel, idx, pkg):
                    edges.append(mk(owner, "import", tgt, resolver))
            continue
        for n in ast.walk(stmt):
            if isinstance(n, ast.Call):
                for nm in name_refs(n.func):
                    for tgt in resolver.resolve(nm, file_rel):
                        edges.append(mk(owner, "call", tgt, resolver))


def collect_edges(tree, file_rel, resolver, idx, pkg):
    owner = (file_rel, "<module>")
    edges = []
    walk_stmts(tree.body, file_rel, resolver, idx, pkg, edges, owner)
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            edges.extend(func_edges(stmt, stmt.name, file_rel, resolver, idx, pkg))
        elif isinstance(stmt, ast.ClassDef):
            edges.extend(class_edges(stmt, file_rel, resolver, idx, pkg))
    return edges


def collapse_edges(edges):
    """One row per (from, to, kind) with weight = occurrence count; drop self-loops."""
    rows = {}
    for e in edges:
        if e["from"] == e["to"]:
            continue
        key = (e["from"], e["to"], e["kind"])
        if key in rows:
            rows[key]["weight"] += e["weight"]
        else:
            rows[key] = dict(e)
    return list(rows.values())


# ---------------------------------------------------------------- token counting (deferred)

def render(sym, tier):
    parts = [sym["signature"]]
    if tier in ("skeleton", "full") and sym["docFirstLine"]:
        parts.append(sym["docFirstLine"])
    if tier == "full":
        if sym["docRest"]:
            parts.append(sym["docRest"])
        if sym["body"]:
            parts.append(sym["body"])
    return "\n".join(p for p in parts if p) + SEP


GEMINI_MODEL = "gemini-3.6-flash"  # pinned; 2.5-flash 404s, flash-latest 503s (BUILD §3)
GEMINI_COUNT_URL = ("https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{GEMINI_MODEL}:countTokens")


def _gemini_count_tokens(text):
    """Call Gemini countTokens for one string, returning totalTokens (int)."""
    import json as _json
    import urllib.request

    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return None
    body = _json.dumps({"contents": [{"parts": [{"text": text}]}]}).encode()
    req = urllib.request.Request(
        f"{GEMINI_COUNT_URL}?key={key}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = _json.loads(resp.read().decode())
    return data.get("totalTokens")


def count_tokens_for_symbols(symbols):
    """Fill symbol.tokens via Gemini countTokens (BUILD §3). tokenSource=count_tokens.

    Parallelized with a 10-worker thread pool — countTokens tolerated 10 rapid
    calls without throttling. Content-hash cache (thread-safe) avoids re-counting.
    Returns True if counted; False when GEMINI_API_KEY is absent.
    """
    if not os.environ.get("GEMINI_API_KEY"):
        return False
    cache = {}
    cache_lock = threading.Lock()
    failed = threading.Event()

    # Build the work list: (symbol, tier, text) — ~1500 per repo.
    jobs = []
    for sym in symbols:
        sym["tokens"] = {}
        for tier in ("signature", "skeleton", "full"):
            jobs.append((sym, tier, render(sym, tier)))

    def count_one(job):
        if failed.is_set():
            return
        sym, tier, text = job
        key = hashlib.sha256(text.encode()).hexdigest()
        # The HTTP call must NOT be inside the lock. Holding cache_lock across the
        # request serialised the whole 10-worker pool — ~3150 calls ran one at a
        # time, which is why a rebuild took minutes. Lock only around the dict.
        with cache_lock:
            hit = cache.get(key)
        if hit is not None:
            sym["tokens"][tier] = hit
            return
        n = _gemini_count_tokens(text)
        if n is None:
            failed.set()
            return
        with cache_lock:
            cache[key] = n
        sym["tokens"][tier] = n

    with ThreadPoolExecutor(max_workers=10) as ex:
        for _ in ex.map(count_one, jobs):
            pass

    return not failed.is_set()


def estimate_tokens_for_symbols(symbols):
    """Fill symbol.tokens with chars/4 estimates per rendered tier (BUILD §3 --estimate).

    Not trap #2: trap #2 is an estimate that SILENTLY becomes the displayed number.
    Here tokenSource is set to "estimate" on the snapshot so every consumer can
    refuse or loudly label it (the UI shows an ESTIMATED badge; /api/step refuses).
    """
    for sym in symbols:
        sym["tokens"] = {}
        for tier in ("signature", "skeleton", "full"):
            text = render(sym, tier)
            sym["tokens"][tier] = max(1, len(text) // 4)
    return True


# ---------------------------------------------------------------- build

def short_commit(repo_dir):
    try:
        out = subprocess.run(
            ["git", "-C", repo_dir, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except Exception:
        return "unknown"


def find_package_dir(root):
    """The single top-level directory containing __init__.py, or root itself.

    Lets --path point at any checked-out Python project without the caller having
    to know its layout. Ambiguous layouts (several top-level packages) are an
    explicit error rather than a silent guess.
    """
    if os.path.isfile(os.path.join(root, "__init__.py")):
        return root
    cands = [
        d for d in sorted(os.listdir(root))
        if not d.startswith(".")
        and os.path.isdir(os.path.join(root, d))
        and os.path.isfile(os.path.join(root, d, "__init__.py"))
        and d not in ("tests", "test", "docs", "examples", "scripts")
    ]
    if len(cands) == 1:
        return os.path.join(root, cands[0])
    if not cands:
        raise SystemExit(f"no Python package found under {root} (looked for a dir with __init__.py)")
    raise SystemExit(
        f"ambiguous layout under {root}: found packages {cands}. "
        f"Pass --path pointing directly at the one you want."
    )


def build_repo(repo, want_tokens, self_check, estimate=False, repo_root=None):
    custom = repo_root is not None
    if repo_root:
        repo_root = os.path.abspath(repo_root)
        pkg_root = find_package_dir(repo_root)
    else:
        pkg_root = os.path.join(VENDOR, repo, REPOS[repo])
        repo_root = os.path.join(VENDOR, repo)
    # Paths in the snapshot are relative to the package's parent, so a symbol id
    # reads "httpx/_client.py::Client" for both bundled and --path repos.
    read_base = os.path.dirname(pkg_root)
    files = []
    for dp, dns, fns in os.walk(pkg_root):
        dns[:] = [d for d in dns if not d.startswith(".")]
        for fn in fns:
            if fn.endswith(".py"):
                files.append(os.path.join(dp, fn))
    files = sorted(os.path.relpath(fp, os.path.dirname(pkg_root)).replace(os.sep, "/") for fp in files)

    idx, rev, pkg_dotted = module_index(files)
    parsed = {}
    for fp in files:
        with open(os.path.join(read_base, fp), encoding="utf-8") as fh:
            src = fh.read()
        tree = ast.parse(src, filename=fp)
        lines = src.split("\n")
        imports = [n for n in ast.walk(tree)
                   if isinstance(n, (ast.Import, ast.ImportFrom)) and not _is_future(n)]
        symbols = extract_symbols(tree, fp, lines)
        parsed[fp] = {"tree": tree, "symbols": symbols, "imports": imports,
                      "defined": defined_names(symbols), "src": src}

    exports = build_exports(files, parsed, idx, pkg_dotted)
    all_symbols = [s for f in files for s in parsed[f]["symbols"]]
    idmap = assign_ids(all_symbols)
    known_qualnames = defaultdict(set)
    for s in all_symbols:
        known_qualnames[s["file"]].add(s["qualname"])
    resolver = Resolver(idx, exports, idmap, known_qualnames)

    edges = []
    for fp in files:
        edges.extend(collect_edges(parsed[fp]["tree"], fp, resolver, idx, pkg_dotted))
    edges = collapse_edges(edges)

    if self_check:
        if not validate_snapshot({
            "symbols": all_symbols, "edges": edges,
        }):
            sys.exit(1)
        # These assert facts about the two bundled fixtures. A user-supplied repo
        # has no such expectations, so they are skipped rather than failed.
        if repo == "httpx" and not custom:
            self_check_httpx(resolver, idx, pkg_dotted, files)
        elif repo == "fastapi" and not custom:
            self_check_fastapi(edges)

    counted = False
    token_source = None
    if estimate:
        estimate_tokens_for_symbols(all_symbols)
        counted = True
        token_source = "estimate"
    elif want_tokens:
        counted = count_tokens_for_symbols(all_symbols)
        if counted:
            token_source = "count_tokens"
    total_tokens = 0
    if counted:
        for s in all_symbols:
            total_tokens += s["tokens"]["full"]

    snapshot = {
        "repo": repo,
        "commit": short_commit(repo_root),
        "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "totalTokens": total_tokens,
        "tokensCounted": counted,
        "tokenSource": token_source,
        "files": {fp: parsed[fp]["src"] for fp in files},
        "symbols": all_symbols,
        "edges": edges,
    }
    return snapshot


def _is_future(node):
    return isinstance(node, ast.ImportFrom) and node.module == "__future__"


def validate_snapshot(snapshot):
    """Structural invariant: every edge resolves to a real symbol, ids are unique."""
    ids = {s["id"] for s in snapshot["symbols"]}
    ok = True
    if len(ids) != len(snapshot["symbols"]):
        print("SELF-CHECK FAIL: duplicate symbol ids")
        ok = False
    for e in snapshot["edges"]:
        if e["from"] not in ids or e["to"] not in ids:
            print(f"SELF-CHECK FAIL: edge {e} references unknown symbol")
            ok = False
        if e["from"] == e["to"]:
            print(f"SELF-CHECK FAIL: self-loop edge {e['from']} -> {e['to']} ({e['kind']})")
            ok = False
    seen = {}
    for e in snapshot["edges"]:
        key = (e["from"], e["to"], e["kind"])
        if key in seen:
            print(f"SELF-CHECK FAIL: duplicate edge row {e['from']} -> {e['to']} ({e['kind']})")
            ok = False
        seen[key] = True
    # BUILD §3: docFirstLine must be non-empty when a symbol has a docstring
    # (docRest non-empty). A leading newline used to push the whole docstring
    # into docRest, making docFirstLine empty and killing the skeleton tier.
    for s in snapshot["symbols"]:
        if s["docRest"] and not s["docFirstLine"]:
            print(f"SELF-CHECK FAIL: symbol {s['id']} has docRest but empty docFirstLine")
            ok = False
    # BUILD §3: a method's `def <name>` must NOT appear in its parent class's
    # body (methods are separate symbols; duplicating them double-counts source).
    # Check only DIRECT methods — direct `def`s are at 4-space indent and are
    # excluded from the body, while nested-class methods (which legitimately live
    # in the body) are at deeper indent.
    method_ids = {s["id"] for s in snapshot["symbols"] if s["kind"] == "method"}
    class_ids = {s["id"] for s in snapshot["symbols"] if s["kind"] == "class"}
    for cid in class_ids:
        cls = next(s for s in snapshot["symbols"] if s["id"] == cid)
        for mid in method_ids:
            if not mid.startswith(cid + "."):
                continue
            mname = mid.rsplit(".", 1)[1]
            direct_def = f"\n    def {mname}"
            if direct_def in cls["body"] or cls["body"].startswith(f"    def {mname}"):
                print(f"SELF-CHECK FAIL: method {mid} appears in class body of {cid}")
                ok = False
    return ok


def self_check_httpx(resolver, idx, pkg_dotted, files):
    """BUILD.md §3: an edge into an httpx symbol must resolve past httpx/__init__.py."""
    init = "httpx/__init__.py"
    checks = {"Client": "httpx/_client.py", "Response": "httpx/_models.py"}
    ok = True
    for name, expect_file in checks.items():
        got = resolver.resolve(name, init)
        resolved_file = got[0][0] if got else None
        if resolved_file != expect_file:
            ok = False
            print(f"SELF-CHECK FAIL: {name} resolved to {resolved_file}, expected {expect_file}")
        else:
            print(f"SELF-CHECK OK: {name} -> {resolved_file}")
    # No re-exported symbol should land on the hub itself.
    for f, exports in resolver.exports.items():
        if f != init:
            continue
        for name, (tfile, _q) in exports.items():
            if tfile == init and name in ("__version__", "main"):
                continue
            if tfile == init:
                ok = False
                print(f"SELF-CHECK FAIL: httpx re-export '{name}' resolved to the hub {init}")
    if not ok:
        sys.exit(1)


def self_check_fastapi(edges):
    """BUILD.md §3: fastapi absolute self-imports must produce edges (bugfix guard)."""
    ok = True
    want = ("fastapi/routing.py::<module>", "fastapi/encoders.py::jsonable_encoder", "import")
    if any((e["from"], e["to"], e["kind"]) == want for e in edges):
        print("SELF-CHECK OK: routing.py -> encoders.py::jsonable_encoder import edge present")
    else:
        print("SELF-CHECK FAIL: missing import edge routing.py -> jsonable_encoder")
        ok = False
    imports = sum(1 for e in edges if e["kind"] == "import")
    if imports > 150:
        print(f"SELF-CHECK OK: fastapi import edges {imports} > 150")
    else:
        print(f"SELF-CHECK FAIL: fastapi import edges {imports} not > 150")
        ok = False
    if not ok:
        sys.exit(1)


def report(repo, snapshot):
    print(f"\n=== {repo} ===")
    print(f"commit {snapshot['commit']}  builtAt {snapshot['builtAt']}")
    print(f"symbols: {len(snapshot['symbols'])}")
    print(f"tokens: {('counted (' + str(snapshot['tokenSource']) + '), total=' + str(snapshot['totalTokens'])) if snapshot['tokensCounted'] else 'NOT COUNTED (no API key; tokens:null)'}")
    bykind = Counter(e["kind"] for e in snapshot["edges"])
    print("edges by kind: " + ", ".join(f"{k}={v}" for k, v in sorted(bykind.items())))
    heavy = [e for e in snapshot["edges"] if e["weight"] > 1]
    maxw = max((e["weight"] for e in snapshot["edges"]), default=1)
    print(f"weight: rows={len(snapshot['edges'])} weight>1 rows={len(heavy)} max_weight={maxw}")
    # top 5 files by body weight (symbol count when tokens are null)
    weight = defaultdict(int)
    for s in snapshot["symbols"]:
        if snapshot["tokensCounted"] and s["tokens"]:
            weight[s["file"]] += s["tokens"]["full"]
        else:
            weight[s["file"]] += len(s["body"])
    top = sorted(weight.items(), key=lambda kv: -kv[1])[:5]
    label = "tokens" if snapshot["tokensCounted"] else "body-bytes (tokens not counted)"
    print(f"top 5 files by {label}:")
    for f, w in top:
        print(f"  {f}: {w}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=None, help="one of the bundled repos (fastapi, httpx)")
    ap.add_argument("--path", default=None,
                    help="index ANY local Python project at this path instead of vendor/")
    ap.add_argument("--name", default=None,
                    help="snapshot name to write when using --path (default: directory name)")
    ap.add_argument("--self-check", action="store_true")
    ap.add_argument("--tokens", action="store_true", help="count via count_tokens (needs key+anthropic)")
    ap.add_argument("--estimate", action="store_true",
                    help="emit chars/4 token estimates with tokenSource='estimate' (BUILD §3)")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    if args.path:
        name = args.name or os.path.basename(os.path.abspath(args.path.rstrip("/")))
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise SystemExit(f"--name must be [A-Za-z0-9_-]+ (got {name!r}); it becomes a filename")
        jobs = [(name, args.path)]
    elif args.repo:
        if args.repo not in REPOS:
            raise SystemExit(f"--repo must be one of {sorted(REPOS)}, or use --path for your own")
        jobs = [(args.repo, None)]
    else:
        jobs = [(r, None) for r in sorted(REPOS)]

    for repo, root in jobs:
        snapshot = build_repo(repo, want_tokens=args.tokens, self_check=args.self_check,
                              estimate=args.estimate, repo_root=root)
        with open(os.path.join(OUT, f"{repo}.json"), "w", encoding="utf-8") as fh:
            json.dump(snapshot, fh, ensure_ascii=False)
        report(repo, snapshot)


if __name__ == "__main__":
    main()
