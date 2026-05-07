# tslsp-mcp

[![npm](https://img.shields.io/npm/v/@0xdeafcafe/tslsp-mcp.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@0xdeafcafe/tslsp-mcp)
[![CI](https://github.com/0xdeafcafe/tslsp-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/0xdeafcafe/tslsp-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@0xdeafcafe/tslsp-mcp.svg?logo=node.js)](https://github.com/0xdeafcafe/tslsp-mcp/blob/main/package.json)

claude finds references by grepping. claude renames things by find-and-replacing. this is fine until your symbol is called `User` or `get` or `value`, at which point it confidently rewrites half your codebase and tells you it's done. thanks, gas-lightyear.

how do real editors function? they ask the typescript language server, which actually understands what's a reference vs what's just a string. `tslsp-mcp` gives claude that same superpower over an MCP API. rename is type-aware. references are real references. find-symbol is the LSP's symbol index, not a regex. if claude wants to know a document outline, it can get a full outline via the LSP, rather than having to randomly read chunks of the file. token waste shit.

it spawns [tsgo](https://github.com/microsoft/typescript-go), microsoft's native go port of tsserver, per `tsconfig.json` it sees, keeps it warm, and routes tool calls to the right one. one process per project, lazy-spawned, not one per request.

designed in my head, built by claudus, tested on your codebase, cheers.

## you need

- node 22+
- [pnpm](https://pnpm.io/) (or use `corepack enable` so node hands you the right version)
- a typescript project (anything with a `tsconfig.json`)
- [claude code](https://claude.com/claude-code), or any other MCP host

## install

easiest path - register with claude code, let `npx` fetch the latest from npm on every run:

```bash
claude mcp add -s user tslsp -- npx -y @0xdeafcafe/tslsp-mcp
```

`-s user` makes it available in every project. drop it (and run from a project dir) if you'd rather scope to one repo.

prefer to run from source? clone, build, point claude at the built file:

```bash
git clone https://github.com/0xdeafcafe/tslsp-mcp.git
cd tslsp-mcp
pnpm install
pnpm run build
claude mcp add -s user tslsp node /absolute/path/to/tslsp-mcp/dist/index.js
```

## make claude actually use it

claude won't reach for an MCP tool just because it exists. you have to tell it. paste this into `~/.claude/CLAUDE.md` (or a project's `CLAUDE.md`):

```markdown
## TypeScript code intelligence (tslsp MCP)

When working in a TypeScript/JavaScript project that has a tsconfig.json,
prefer the tslsp MCP tools over text-based alternatives:

- Finding usages of a symbol -> tslsp:references, not Grep.
- Renaming a function/class/variable -> tslsp:rename. Don't do
  find-and-replace edits for renames. Use dry_run: true first if
  the symbol has many call sites.
- "Where is X defined?" -> tslsp:definition, not Grep.
- Type signature / docstring of a symbol -> tslsp:hover.
- Outline of a file before reading the whole thing -> tslsp:outline.
- Searching for a symbol by name -> tslsp:find_symbol, not Grep.
- Type errors after editing -> tslsp:diagnostics.

Position-taking tools accept { symbol: "name" } if you don't have a
position handy, the MCP resolves it via workspace symbol search.

Fall back to Grep for genuine text search (string literals, comments,
non-TS files) or projects with no tsconfig.json.
```

## tools

| tool          | what it does                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `find_symbol` | search the workspace for symbols by name. returns `path:line  kind name`.                                   |
| `references`  | every reference to a symbol. accepts `{file, line, character}`, `{file, line, symbol}`, or just `{symbol}`. |
| `definition`  | jump to where a symbol is defined. same locator shapes.                                                     |
| `rename`      | type-aware rename across every file. `dry_run: true` previews without writing.                              |
| `hover`       | type signature + jsdoc for a symbol.                                                                        |
| `outline`     | indented declaration outline of a file.                                                                     |
| `diagnostics` | type errors. file-scoped or workspace-wide.                                                                 |

every position-taking tool accepts a **symbol locator** with three modes, in priority order:

```js
{ file, line, character }   // explicit LSP position
{ file, line, symbol }      // server scans the line for the identifier
{ symbol }                  // workspace symbol search; errors with candidates if ambiguous
```

LLMs reliably know line numbers and symbol names but not character columns. mode 2 and 3 cover the gap.

## how it works

```
claude → stdio → tslsp-mcp → tsgo (project A)
                           → tsgo (project B)
                           → ...
```

on first tool call against a file, it walks up to the nearest `tsconfig.json`, spawns tsgo there, opens a seed file so the workspace symbol index populates, and caches the process. subsequent calls reuse it. when you edit files via `rename`, it pushes `didClose`/`didOpen` + `workspace/didChangeWatchedFiles` so the index reprojects.

## gotchas

- it pins `@typescript/native-preview` to a specific dev build. tsgo is moving fast and dev builds shift. bump the version in `package.json` deliberately.
- if you have an older homebrew-installed `tsgo` on your PATH, the MCP ignores it and uses the npm-pinned one. earlier versions had behavior we explicitly don't want.
- `rename` writes to disk. there's a `dry_run: true` if you want to preview first. `git diff` is your friend.
- one tsgo process per `tsconfig.json` root. monorepos with many tsconfigs will spawn many tsgos lazily, first hit per project pays project-load cost (~50ms on small, more on large).
- set `TSLSP_MCP_VERBOSE=1` to forward tsgo's stderr if something feels off.
