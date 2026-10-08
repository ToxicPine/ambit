# Deno dependency cache

Dependencies are installed from workspace configuration and the root
`deno.lock`. The package validates its module graph against that cache.
`includedPaths` selects files and directories to ship at their package-relative
locations, without affecting the dependency derivation.

JSR catalogs are generated from the vendored version manifests so unrelated
registry changes do not affect the dependency hash.
