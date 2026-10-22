# Client development

Read [CODEMAP.md](CODEMAP.md) before exploring the implementation and [README.md](README.md) for setup. Keep this client independently installable and buildable: never import parent checkout files, private server/admin code or internal developer tools. Shared protocols belong in `api/proto`; generated bindings belong only in `api/gen` and must not be hand-edited.

The interface targets desktop computers and tablets, without phone-specific layouts. Accessibility changes are outside the default acceptance scope unless explicitly requested.

Run checks appropriate to the changed package, then `pnpm boundary:check` when imports, scripts or configuration change. Renderer verification requires a real GPU: probe macOS with `/usr/sbin/system_profiler SPDisplaysDataType`; on Linux inspect `/dev/dri/renderD*`. Missing `/dev/dri` on macOS is normal. Never substitute software rendering for hardware performance evidence.

Keep local credentials, configuration, user data, build artifacts and signing keys out of Git. Preserve third-party license and attribution files. No project license may be selected without the copyright holder’s instruction.
