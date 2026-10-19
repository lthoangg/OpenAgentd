#!/usr/bin/env bash
# Create the fictional demo projects the README screenshots are taken in.
# Usage: demo-repos.sh <dest-dir>
# Everything here is invented sample content — never point the screenshot
# pipeline at a real checkout or a real data directory.
set -euo pipefail

DEST=${1:?usage: demo-repos.sh <dest-dir>}
rm -rf "$DEST/linkly" "$DEST/pocket-budget"
mkdir -p "$DEST"

commit() { # commit <iso-date> <message>
  git add -A
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -m "$2"
}

init_repo() { # init_repo <dir>
  mkdir -p "$1" && cd "$1"
  git init -q -b main
  git config user.name "Mira Chen"
  git config user.email "mira@example.com"
  git config commit.gpgsign false
}

# ── linkly: a tiny Bun URL shortener (the main demo workspace) ──────────────
init_repo "$DEST/linkly"
mkdir -p src tests
cat > package.json <<'EOF'
{
  "name": "linkly",
  "version": "0.4.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/server.ts",
    "start": "bun src/server.ts",
    "test": "bun test"
  }
}
EOF
cat > README.md <<'EOF'
# linkly

A tiny, fast URL shortener built on Bun.

```bash
bun run dev      # http://localhost:3000
bun test
```

- `POST /api/shorten` `{ "url": "https://…" }` → `{ "slug": "k3Xa9q", "short": "http://localhost:3000/k3Xa9q" }`
- `GET /:slug` → 301 redirect
- `GET /api/stats/:slug` → visit count
EOF
cat > src/slug.ts <<'EOF'
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"

/** Random, unambiguous slug (no 0/O, 1/l/I). */
export function makeSlug(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ""
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

export function isValidSlug(slug: string): boolean {
  return /^[2-9a-zA-HJ-NP-Z]{4,16}$/.test(slug)
}
EOF
cat > src/store.ts <<'EOF'
export interface Link {
  slug: string
  url: string
  createdAt: number
  visits: number
}

export class LinkStore {
  #links = new Map<string, Link>()

  put(slug: string, url: string): Link {
    const link = { slug, url, createdAt: Date.now(), visits: 0 }
    this.#links.set(slug, link)
    return link
  }

  get(slug: string): Link | undefined {
    return this.#links.get(slug)
  }

  visit(slug: string): Link | undefined {
    const link = this.#links.get(slug)
    if (link) link.visits++
    return link
  }

  has(slug: string): boolean {
    return this.#links.has(slug)
  }
}
EOF
commit "2026-10-14T10:02:00" "Initial slug generator and in-memory store"

cat > src/server.ts <<'EOF'
import { isValidSlug, makeSlug } from "./slug"
import { LinkStore } from "./store"

const store = new LinkStore()
const BASE = process.env.BASE_URL ?? "http://localhost:3000"

function json(body: unknown, status = 200) {
  return Response.json(body, { status })
}

export async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url)

  if (req.method === "POST" && pathname === "/api/shorten") {
    const { url } = (await req.json()) as { url?: string }
    if (!url || !URL.canParse(url)) return json({ error: "invalid url" }, 400)
    let slug = makeSlug()
    while (store.has(slug)) slug = makeSlug()
    store.put(slug, url)
    return json({ slug, short: `${BASE}/${slug}` }, 201)
  }

  if (req.method === "GET" && pathname.startsWith("/api/stats/")) {
    const link = store.get(pathname.slice("/api/stats/".length))
    return link ? json({ slug: link.slug, visits: link.visits }) : json({ error: "not found" }, 404)
  }

  const slug = pathname.slice(1)
  if (req.method === "GET" && isValidSlug(slug)) {
    const link = store.visit(slug)
    if (link) return Response.redirect(link.url, 301)
  }

  return json({ error: "not found" }, 404)
}

if (import.meta.main) {
  Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: handle })
  console.log(`linkly listening on ${BASE}`)
}
EOF
commit "2026-10-15T16:40:00" "Add HTTP server with shorten, redirect and stats routes"

cat > tests/slug.test.ts <<'EOF'
import { describe, expect, test } from "bun:test"
import { isValidSlug, makeSlug } from "../src/slug"

describe("makeSlug", () => {
  test("uses the requested length", () => {
    expect(makeSlug(8)).toHaveLength(8)
  })

  test("only produces valid slugs", () => {
    for (let i = 0; i < 500; i++) expect(isValidSlug(makeSlug())).toBe(true)
  })
})
EOF
cat > tests/server.test.ts <<'EOF'
import { expect, test } from "bun:test"
import { handle } from "../src/server"

const post = (url: string) =>
  handle(new Request("http://x/api/shorten", { method: "POST", body: JSON.stringify({ url }) }))

test("shortens and redirects", async () => {
  const res = await post("https://bun.sh")
  expect(res.status).toBe(201)
  const { slug } = await res.json()
  const hop = await handle(new Request(`http://x/${slug}`))
  expect(hop.status).toBe(301)
  expect(hop.headers.get("location")).toBe("https://bun.sh/")
})

test("rejects invalid urls", async () => {
  expect((await post("not a url")).status).toBe(400)
})
EOF
commit "2026-10-16T11:15:00" "Cover slugs and the shorten/redirect flow with tests"

printf 'node_modules/\n.env\n' > .gitignore
commit "2026-10-17T09:30:00" "Ignore node_modules and local env"

# ── pocket-budget: a small Python CLI (second workspace for the sidebar) ────
init_repo "$DEST/pocket-budget"
mkdir -p budget tests
cat > README.md <<'EOF'
# pocket-budget

Plain-text budgeting from the terminal. Reads `ledger.csv`, prints a monthly report.

```bash
python -m budget report
python -m pytest
```
EOF
cat > ledger.csv <<'EOF'
date,category,amount,note
2026-09-02,rent,-1450.00,September rent
2026-09-03,groceries,-82.40,Market
2026-09-05,salary,4200.00,Payroll
2026-09-11,transport,-36.00,Transit pass
2026-09-19,groceries,-64.15,Market
2026-10-01,rent,-1450.00,October rent
2026-10-04,groceries,-91.70,Market
2026-10-05,salary,4200.00,Payroll
2026-10-09,dining,-48.50,Ramen with Jo
2026-10-12,transport,-36.00,Transit pass
EOF
cat > budget/__init__.py <<'EOF'
EOF
cat > budget/ledger.py <<'EOF'
import csv
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path


@dataclass(frozen=True)
class Entry:
    day: date
    category: str
    amount: Decimal
    note: str


def load(path: Path) -> list[Entry]:
    with path.open(newline="") as fh:
        return [
            Entry(date.fromisoformat(r["date"]), r["category"], Decimal(r["amount"]), r["note"])
            for r in csv.DictReader(fh)
        ]


def totals_by_category(entries: list[Entry]) -> dict[str, Decimal]:
    out: dict[str, Decimal] = {}
    for e in entries:
        out[e.category] = out.get(e.category, Decimal(0)) + e.amount
    return dict(sorted(out.items(), key=lambda kv: kv[1]))
EOF
cat > budget/__main__.py <<'EOF'
import argparse
from pathlib import Path

from .ledger import load, totals_by_category


def main() -> None:
    parser = argparse.ArgumentParser(prog="budget")
    sub = parser.add_subparsers(dest="cmd", required=True)
    report = sub.add_parser("report", help="print totals by category")
    report.add_argument("--ledger", type=Path, default=Path("ledger.csv"))
    args = parser.parse_args()

    for category, total in totals_by_category(load(args.ledger)).items():
        print(f"{category:<12} {total:>10.2f}")


main()
EOF
cat > tests/test_ledger.py <<'EOF'
from decimal import Decimal
from pathlib import Path

from budget.ledger import load, totals_by_category


def test_totals_by_category():
    entries = load(Path(__file__).parent.parent / "ledger.csv")
    totals = totals_by_category(entries)
    assert totals["rent"] == Decimal("-2900.00")
    assert totals["salary"] == Decimal("8400.00")
EOF
commit "2026-10-10T19:20:00" "Ledger loader and category report"

echo "demo repos ready in $DEST"
