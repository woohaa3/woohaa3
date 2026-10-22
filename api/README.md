# Shared API contracts

`proto/` is the single source of shared RPC and synchronization contracts. The local client consumes TypeScript bindings from `gen/es`; an optional remote service can consume `gen/go`. Remote service implementation and deployment are independent of this repository.

| Path | Purpose |
| --- | --- |
| `proto/woohaa/` | Domain contracts; `v1` changes must remain backward compatible, evolving APIs use `v1alpha1` |
| `buf.yaml` / `buf.gen.yaml` | Lint, compatibility and binding generation configuration |
| `gen/es` / `gen/go` | Generated TypeScript and Go bindings; never edit by hand |
| `proto/woohaa/errors` / `errs` | Shared failure reasons and Go error values |
| `tools/generrors` | Generates Go failure values from the error enum and its options |
| [OpenAPI JSON](openapi/openapi.json) / [Swagger page](openapi/index.html) | Generated HTTP RPC reference |
| [OpenAPI model](scripts/openapi-model.mjs) | Explicit authorization, limits and error descriptions supplementing proto |

Run these commands from this directory after `pnpm install --frozen-lockfile`:

```sh
pnpm run lint
pnpm run gen
pnpm run gen:check
pnpm run typecheck
pnpm run docs:gen
pnpm run docs:check
pnpm run check
```

`gen` also runs the Go failure-value generator. `gen:check` regenerates bindings and failure values and checks Git for drift. `check` combines lint, binding drift, TypeScript and generated-document checks. Generation requires Go and these plugins on PATH; the TypeScript plugin is provided by this directory's pnpm dependencies:

```sh
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.19.1
```

Use the pinned `protoc-gen-go` version to avoid unrelated binding changes. The Connect OpenAPI generator is invoked by the documentation script at its pinned version and may download Go modules on first use.

`pnpm run breaking` compares against `BUF_BASELINE`, defaulting to the client Git ref `origin/master`. Set `BUF_BASELINE` to an existing compatible baseline when using another branch or repository layout; that baseline must contain this API module.

The Swagger HTML embeds the contract and loads Swagger UI from a public CDN, so viewing it requires network access. Try it out and remote validation are disabled. RPC documentation describes Connect JSON requests; binary WebSocket synchronization is defined separately in [session.proto](proto/woohaa/canvas/v1/session.proto).

When changing proto methods or runtime authorization/limits, update the supplemental OpenAPI descriptions and regenerate documentation. Keep private addresses, secrets and customer details out of public contracts and comments.
