# Share development configuration

[返回项目首页](../README.md) · [开发指南](development.md)

Run all commands from the repository root.

After building the local services (`pnpm services:build`), keep `pnpm dev` running in one terminal and export from another terminal:

```sh
pnpm config:export --out ./team.woohaa
# Custom backend port or mount path:
pnpm config:export --out ./team-custom.woohaa --from http://127.0.0.1:9000/app/
```

The exporter reads `web/.env` (or `WOOHAA3_SERVICE_ENV_FILE`) and process environment with the same precedence as the host. It reads the configured settings/secrets YAML files, resolves provider/storage schema fields including legacy environment overrides, exports extension enablement and values from the configured application SQLite database, and includes the configured task model file and persisted model enablement/default/order policies. It exports remote-server deployment address/device credentials from its local deployment file or environment; site settings have priority for the server address. It also reads the running host’s public `/api/generation-models` snapshot, including LiteLLM gateway and server-discovered models, and reports counts by provider. If the host is unavailable or the response is invalid, export fails rather than silently creating an incomplete package. Only loopback sources are allowed; requests do not carry login tokens. An existing output is never overwritten.

It omits machine paths, personal login tokens, sessions, secret references, task/canvas databases, media, plugin secret stores and extension code. Unknown settings are reported instead of copied. Arbitrary extension `config.local.json` files are not copied; only the remote-server deployment fields have a supported portable reader. Locally hosted API URLs are retained: colleagues still need network access to those services.

In a newly built desktop app choose **工作区 → 导入配置…** and select the `.woohaa` file. The host stops, backs up existing data, merges the supplied configuration and restarts. Supplied keys replace matching keys; an initialized model policy collection replaces the target model policy collection. Unrelated destination settings, canvas/task/media data and personal credentials remain. Colleagues log in with their own account. Imported discovered models retain their types, names and extension ownership in the settings model list. The snapshot never registers an execution provider or grants permission: execution requires the destination’s configured provider/login. A provider’s fresh discovered catalog takes precedence, including removed models. The snapshot does not replace provider-specific executable schemas or capabilities. New packages use format version 2; the importer still accepts old version 1 packages. Imported model settings and remote deployment settings live under the writable user `config/` directory, outside the app bundle. **导入工作区…** remains a separate operation that replaces the full workspace; it does not accept configuration packages.

The configuration package contains shared API credentials and is not encrypted. Keep it out of Git and distribute it through your agreed internal channel. An older app without **导入配置…** must be rebuilt/upgraded to use these packages.
