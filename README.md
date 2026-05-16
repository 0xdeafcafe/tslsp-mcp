# tslsp-mcp

[![npm](https://img.shields.io/npm/v/@0xdeafcafe/tslsp-mcp.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@0xdeafcafe/tslsp-mcp)
[![CI](https://github.com/0xdeafcafe/tslsp-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/0xdeafcafe/tslsp-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@0xdeafcafe/tslsp-mcp.svg?logo=node.js)](https://github.com/0xdeafcafe/tslsp-mcp/blob/main/package.json)

claude finds references by grepping. claude renames things by find-and-replacing. this is fine until your symbol is called `User` or `get` or `value`, at which point it confidently rewrites half your codebase and tells you it's done. thanks, gas-lightyear.

how do real editors function? they ask the typescript language server, which actually understands what's a reference vs what's just a string. `tslsp-mcp` gives claude that same superpower — over an MCP server **or** a regular CLI binary. rename is type-aware. references are real references. `find_symbol` is the LSP's symbol index, not a regex. file/folder rename rewrites every import. `outline` is the LSP's structural view, not "read 200 lines and hope."

it spawns [tsgo](https://github.com/microsoft/typescript-go), microsoft's native go port of tsserver, per `tsconfig.json` it sees, keeps it warm, and routes tool calls to the right one. one process per project, lazy-spawned, not one per request.

designed in my head, built by claudus, tested on your codebase, cheers.

## you need

- node 22+
- a typescript project (anything with a `tsconfig.json`)
- [claude code](https://claude.com/claude-code), or any other MCP/skill-aware host

## install

two ways to use this. **pick one** — you don't need both.

### option A: CLI + skill (recommended for coding agents)

Token-efficient. The agent calls `tslsp <command>` like any other shell tool — no MCP schema bloat in context, no verbose tool listings.

```bash
# global install
npm install -g @0xdeafcafe/tslsp-mcp

# drop a SKILL.md into ~/.claude/skills/tslsp/ so claude code knows when to reach for it
tslsp install --skills

# (or: per-project, commit it with your code)
tslsp install --skills --project
```

`tslsp --help` lists every command. Agents can drive it skills-less by reading `--help` directly.

### option B: MCP server

Register with claude code so it appears as a structured MCP tool:

```bash
claude mcp add -s user tslsp -- npx -y @0xdeafcafe/tslsp-mcp
```

`-s user` makes it available in every project. Drop it (and run from a project dir) if you'd rather scope to one repo.

Prefer to run from source? Clone, build, point claude at the built file:

```bash
git clone https://github.com/0xdeafcafe/tslsp-mcp.git
cd tslsp-mcp
pnpm install
pnpm run build
claude mcp add -s user tslsp node /absolute/path/to/tslsp-mcp/dist/index.js
```

## make claude actually use it

Claude won't reach for a tool just because it exists. Tell it explicitly which built-in tool it replaces. The `tslsp install --skills` command writes a ready-made `SKILL.md` for you; if you'd rather paste it into your own `CLAUDE.md` (or want to extend it), here's the canonical block:

```markdown
## TypeScript code intelligence (tslsp)

In any TypeScript/JavaScript project with a `tsconfig.json`, the `tslsp` tools
are type-aware and MUST be used instead of the built-in text tools for the
operations below. Text tools see strings; tslsp sees the program.

The table shows MCP names (`tslsp:foo`). With the CLI install, replace
`tslsp:foo` with `tslsp foo` — same semantics.

| Task                            | DO use                   | DO NOT use                            |
| ------------------------------- | ------------------------ | ------------------------------------- |
| Find every usage of a symbol    | `tslsp:references`       | `Grep`, `Glob`                        |
| Search for a symbol by name     | `tslsp:find_symbol`      | `Grep`                                |
| Jump to a definition            | `tslsp:definition`       | `Grep` + `Read`                       |
| Jump to a value's *type*        | `tslsp:type_definition`  | `Grep` + `Read`                       |
| Find concrete implementations   | `tslsp:implementation`   | `Grep`                                |
| Rename a symbol                 | `tslsp:rename`           | `Edit`, `MultiEdit`, find-and-replace |
| Rename/move a file or folder    | `tslsp:rename_file`      | `mv` / `git mv` (won't update imports) |
| Type / JSDoc for a symbol       | `tslsp:hover`            | `Read`                                |
| Outline a file before reading   | `tslsp:outline`          | `Read` on the whole file              |
| Type errors after an edit       | `tslsp:diagnostics`      | `Bash` running `tsc` ad-hoc           |
| Trace callers / callees         | `tslsp:call_hierarchy`   | repeated `references` calls           |
| Organize imports / quick-fix    | `tslsp:code_action`      | manual edit                           |

Hard rules:

1. NEVER rename a TypeScript identifier with `Edit` or `MultiEdit`. Use
   `tslsp:rename`. Pass `dry_run: true` first when the symbol has many call
   sites; review the preview, then apply. This applies to *every* identifier
   — slice keys (`features.fooUi`), property names, enum members, the lot.
   If you find yourself string-editing a symbol "just for a couple of files"
   you have already failed the rule. For bulk renames (e.g., renaming a
   whole feature), enumerate symbols via `tslsp:outline` on each file in
   the folder first, then call `tslsp:rename` once per symbol — it is
   ~5× cheaper in tokens than grep+Read+Edit and safer (no false positives
   in comments / strings / unrelated identifiers).
2. NEVER `mv` or `git mv` a TypeScript file or folder. Use
   `tslsp:rename_file` — it walks every import that references it and
   rewrites them. After the move you can still use `tslsp:rename` for any
   identifier inside the file; combine the two passes.
3. NEVER `Grep` for a symbol name to find usages or definitions. Use
   `tslsp:references` or `tslsp:definition`. Grep matches strings in
   comments, in unrelated identifiers, in `.md` files — it lies.
4. Before reading a large file, call `tslsp:outline` first and use the line
   numbers to `Read` only the slices you need. Do not page through 100s of
   lines hunting for a function.
5. After non-trivial edits to a TS file, call `tslsp:diagnostics` on it to
   confirm it still type-checks before claiming the change is done.

Locator ergonomics: every position-taking tool accepts
`{ symbol: "name" }` (workspace search), `{ file, line, symbol }` (line
scan), or full `{ file, line, character }`. Use the cheapest form you
have. Ambiguous name-only queries return the candidate list; pick by file
or line and re-call.

Batch ergonomics: most read-only tools accept a `symbols: ["a","b","c"]`
(or `files: [...]`) array. tslsp fans the requests out in parallel and
labels each block with `=== name ===`. One call beats N round-trips.

Fall back to the built-in text tools ONLY for: string literals, comments,
non-TS files (Markdown, YAML, configs), or projects without a
`tsconfig.json`.
```

## tools

| tool              | what it does                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `find_symbol`     | search the workspace for symbols by name. returns `path:line  kind name`.                                   |
| `references`      | every reference to a symbol. accepts a locator, or a `symbols: [...]` batch.                                |
| `definition`      | jump to where a symbol is defined. batches via `symbols`.                                                   |
| `type_definition` | jump to a value's *type* declaration (vs. its value declaration). batches via `symbols`.                    |
| `implementation`  | concrete implementations of an interface/abstract member. batches via `symbols`.                            |
| `rename`          | type-aware rename across every file. `dry_run: true` previews without writing.                              |
| `rename_file`     | rename/move a file or folder; updates every `import` that references it. handles folders recursively.       |
| `hover`           | type signature + JSDoc for a symbol. batches via `symbols`.                                                 |
| `outline`         | indented declaration outline. `files: [...]` batches multiple files in parallel.                            |
| `diagnostics`     | type errors. `file`, `files: [...]`, or omit (aggregate across every open file).                            |
| `call_hierarchy`  | callers and callees of a function. `direction: incoming | outgoing | both`.                                |
| `code_action`     | list quick-fixes / refactors / organize-imports; pass `apply: N` to apply by index.                         |

### symbol locator

Every position-taking tool accepts a **symbol locator** with three modes, in priority order:

```js
{ file, line, character }   // explicit LSP position
{ file, line, symbol }      // server scans the line for the identifier
{ symbol }                  // workspace symbol search; errors with candidates if ambiguous
```

LLMs reliably know line numbers and symbol names but not character columns. Modes 2 and 3 cover the gap.

### batching

Most read-only tools accept an array variant that fans requests out in parallel:

```js
// MCP
tslsp:hover     { symbols: ["User", "Repository", "AuthService"] }
tslsp:outline   { files: ["src/api.ts", "src/db.ts"] }
tslsp:diagnostics { files: ["src/a.ts", "src/b.ts", "src/c.ts"] }
```

```bash
# CLI: comma-separated
tslsp hover     --symbols User,Repository,AuthService
tslsp outline   src/api.ts src/db.ts
tslsp diagnostics --files src/a.ts,src/b.ts,src/c.ts
```

Output is labeled with `=== <name> ===` per block — one tool call, N parallel LSP queries, one return.

## CLI cheatsheet

```bash
tslsp find-symbol User                          # positional == --query
tslsp references --symbol User
tslsp definition --symbol User
tslsp rename --symbol oldName --new-name newName --dry-run
tslsp rename-file src/old.ts src/new.ts --dry-run
tslsp rename-file src/components src/widgets   # folders supported
tslsp hover --symbol User
tslsp outline src/api.ts
tslsp diagnostics --file src/x.ts
tslsp call-hierarchy --symbol handleRequest --direction incoming
tslsp code-action --file src/x.ts --kind source.organizeImports
tslsp code-action --file src/x.ts --kind source.organizeImports --apply 0

tslsp --help                  # all commands
tslsp <command> --help        # per-command flags
tslsp install --skills        # drop SKILL.md into ~/.claude/skills/tslsp/
tslsp mcp                     # start MCP server (same as the tslsp-mcp bin)
```

## how it works

```
claude → stdio → tslsp-mcp → tsgo (project A)
                           → tsgo (project B)
                           → ...
```

On first tool call against a file, it walks up to the nearest `tsconfig.json`, spawns tsgo there, opens a seed file so the workspace symbol index populates, and caches the process. Subsequent calls reuse it. When you edit files via `rename` or `rename_file`, it pushes `didClose`/`didOpen` + `workspace/didChangeWatchedFiles` (and `didRenameFiles` for moves) so the index reprojects.

## gotchas

- it pins `@typescript/native-preview` to a specific dev build. tsgo is moving fast and dev builds shift. bump the version in `package.json` deliberately.
- if you have an older homebrew-installed `tsgo` on your PATH, the MCP ignores it and uses the npm-pinned one. earlier versions had behavior we explicitly don't want.
- `rename` and `rename_file` write to disk. there's a `dry_run: true` if you want to preview first. `git diff` is your friend.
- one tsgo process per `tsconfig.json` root. monorepos with many tsconfigs will spawn many tsgos lazily, first hit per project pays project-load cost (~50ms on small, more on large).
- set `TSLSP_VERBOSE=1` (or `TSLSP_MCP_VERBOSE=1`) to forward tsgo's stderr if something feels off.
