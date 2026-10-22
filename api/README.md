# Generated protocol bindings

`gen/es` holds the TypeScript bindings (protobuf-es) the client consumes: the
client-facing RPC and synchronization contracts only. Administrative contracts
(admin services, ops, RBAC, the admin inspection channel) are generated in the
closed repository and are deliberately absent here.

It is **generated output**: never edit it by hand, and never add protocol sources
(`.proto`) or generation tooling to this directory.

Contract sources and their generation pipeline live outside this repository. This
directory only carries the compiled bindings the client consumes, so the client
stays independently installable, buildable and testable.

| Path | Purpose |
| --- | --- |
| `gen/es/woohaa/**` | Generated protobuf-es modules imported by client packages |
| `tsconfig.json` | Type-only check of the generated output |

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
```

Notes:

- every generated file carries a `@generated` header; regenerate through the
  contract pipeline and commit the result here, never patch it locally
- a binding change is a protocol change: `v1` contracts stay backward compatible,
  and evolving APIs live under `v1alpha1`
- `@bufbuild/protobuf` is the only runtime dependency; `buf` lint, compatibility
  checks and code generation are not runnable in this repository
- the binary WebSocket synchronization framing is surfaced through
  `gen/es/woohaa/canvas/v1/session_pb.ts`
