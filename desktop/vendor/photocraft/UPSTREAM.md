# PhotoCraft native source

The desktop Cargo build uses the crates, assets and contributor tables from
[PhotoCraft](https://github.com/storytold/photocraft) revision
`e6d6fb45a40250f518d2e824236a8fdcaa4472c8` (0.15.0), with the Woohaa
editor integration patch (SHA-256
`8b44f4fb8bca2927199ab1c6865dd1616146982540195412faf238091e8b7b8d`).
The workspace member list is limited to the included crates. Cargo resolves
the desktop dependency graph from the enclosing desktop application's lockfile.
Third-party attributions are in ATTRIBUTION.md and NOTICE.
