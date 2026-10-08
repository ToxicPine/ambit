# Deno dependency cache

Dependencies are installed from workspace configuration and the root
`deno.lock`. `deno compile` builds against that cache and the pinned `denort`
flake inputs. `includedPaths` selects package-relative files and directories
to embed. Self-extraction makes router files available to flyctl.

JSR catalogs are generated from the vendored version manifests so unrelated
registry changes do not affect the dependency hash.
