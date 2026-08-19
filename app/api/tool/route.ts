import { NextResponse } from "next/server";
import { loadSnapshot, isValidRepo, validateIds, snapshotFiles, availableRepos } from "@/lib/snapshot";

const MAX_BODY = 64 * 1024;

export const runtime = "nodejs";

interface ToolRequest {
  repo?: unknown;
  name?: unknown;
  args?: Record<string, unknown>;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) {
      return NextResponse.json({ error: `request body too large (>${MAX_BODY} bytes)` }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const req = body as ToolRequest;
  if (!req || typeof req !== "object") {
    return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  }
  if (!isValidRepo(req.repo)) {
    return NextResponse.json({ error: `repo must be one of: ${availableRepos().join(", ")}` }, { status: 400 });
  }
  if (typeof req.name !== "string" || !["read_symbol", "read_file", "list_symbols"].includes(req.name)) {
    return NextResponse.json({ error: "name must be read_symbol|read_file|list_symbols" }, { status: 400 });
  }
  const args = (req.args ?? {}) as Record<string, unknown>;

  const snapshot = loadSnapshot(req.repo);

  switch (req.name) {
    case "read_symbol": {
      const id = args.id;
      if (typeof id !== "string") {
        return NextResponse.json({ error: "read_symbol requires args.id" }, { status: 400 });
      }
      const bad = validateIds(snapshot, [id]);
      if (bad) return NextResponse.json({ error: bad }, { status: 400 });
      const sym = snapshot.symbols.find((s) => s.id === id)!;
      return NextResponse.json({ ok: true, symbol: sym });
    }

    case "list_symbols": {
      const file = args.file;
      if (typeof file !== "string") {
        return NextResponse.json({ error: "list_symbols requires args.file" }, { status: 400 });
      }
      const files = snapshotFiles(snapshot);
      if (!files.includes(file)) {
        return NextResponse.json({ error: `unknown file: ${file}` }, { status: 400 });
      }
      const ids = snapshot.symbols.filter((s) => s.file === file).map((s) => s.id);
      return NextResponse.json({ ok: true, ids });
    }

    case "read_file": {
      const path = args.path;
      if (typeof path !== "string") {
        return NextResponse.json({ error: "read_file requires args.path" }, { status: 400 });
      }
      const files = snapshotFiles(snapshot);
      if (!files.includes(path)) {
        return NextResponse.json({ error: `unknown file: ${path}` }, { status: 400 });
      }
      // Serve read_file verbatim from snapshot.files (BUILD §5): the snapshot
      // stores the exact source per path. Reconstruction was tried and rejected
      // (160% size, missing imports). Snapshot-key validation above is what
      // makes traversal impossible rather than filtered.
      return NextResponse.json({ ok: true, path, content: snapshot.files[path] });
    }
    default:
      return NextResponse.json({ error: "unreachable" }, { status: 400 });
  }
}
