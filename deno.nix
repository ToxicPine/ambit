# Package Deno workspace members with a shared lockfile and vendored dependencies.
{ lib, ... }:

let
  workspaceRoot = ./.;
  workspaceConfig = builtins.fromJSON (builtins.readFile ./deno.json);
  lockSetting = workspaceConfig.lock or { };
  lockPath = if builtins.isString lockSetting then lockSetting else lockSetting.path or "deno.lock";
  workspaceLock =
    assert lib.assertMsg (lockSetting != false) "Deno packaging requires a workspace lockfile.";
    workspaceRoot + "/${lockPath}";

  configurationFiles =
    directory:
    lib.filter builtins.pathExists (
      map (name: directory + "/${name}") [
        "deno.json"
        "deno.jsonc"
        "package.json"
        ".npmrc"
      ]
    );
  workspaceFiles = [
    workspaceLock
  ]
  ++ configurationFiles workspaceRoot
  ++ lib.concatMap (
    member: configurationFiles (workspaceRoot + "/${member}")
  ) workspaceConfig.workspace;

  sourceFor =
    files:
    lib.fileset.toSource {
      root = workspaceRoot;
      fileset = lib.fileset.unions files;
    };
in
{
  perSystem =
    { pkgs, ... }:
    let
      mkDenoPackage =
        {
          packageDir,
          entrypoint,
          depsHash,
          pname ? null,
          version ? null,
          binName ? null,
          permissions ? [ "-A" ],
          runtimeInputs ? [ ],
          # Files/directories to ship, relative to packageDir. Their locations are
          # preserved; workspace configuration and the lockfile are always included.
          includedPaths ? [ "." ],
        }:
        let
          packageRoot = workspaceRoot + "/${packageDir}";
          denoConfig = builtins.fromJSON (builtins.readFile (packageRoot + "/deno.json"));
          packageName = lib.last (lib.splitString "/" (denoConfig.name or packageDir));
          pname' = if pname == null then packageName else pname;
          version' = if version == null then denoConfig.version else version;
          binName' = if binName == null then pname' else binName;
          runtimeSrc = sourceFor (workspaceFiles ++ map (path: packageRoot + "/${path}") includedPaths);

          deps = pkgs.stdenvNoCC.mkDerivation {
            name = "${pname'}-deno-deps";
            src = sourceFor workspaceFiles;
            nativeBuildInputs = [
              pkgs.cacert
              pkgs.deno
              pkgs.jq
            ];
            dontFixup = true;

            buildPhase = ''
              runHook preBuild
              export DENO_DIR="$TMPDIR/deno-cache"
              deno install --vendor=true --frozen --config deno.json
              for catalog in vendor/jsr.io/@*/*/meta.json; do
                [ -f "$catalog" ] || continue
                jq --null-input --sort-keys --args '
                  {versions: ($ARGS.positional | map(
                    split("/")[-1] | rtrimstr("_meta.json") | {key: ., value: {}}
                  ) | from_entries)}
                ' "''${catalog%/*}"/*_meta.json > "$catalog"
              done
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              if [ -d vendor ]; then
                cp -R vendor "$out/"
              fi
              if [ -d node_modules ]; then
                rm -f node_modules/.deno/.setup-cache.bin
                cp -R node_modules "$out/"
              fi
              runHook postInstall
            '';

            outputHashAlgo = "sha256";
            outputHashMode = "recursive";
            outputHash = depsHash;
          };
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = pname';
          version = version';
          src = runtimeSrc;
          dontFixup = true;
          nativeBuildInputs = [
            pkgs.deno
            pkgs.jq
            pkgs.makeWrapper
          ];

          buildPhase = ''
            runHook preBuild
            export DENO_DIR="$TMPDIR/deno-cache"
            if [ -d ${deps}/vendor ]; then
              ln -s ${deps}/vendor vendor
            fi
            if [ -d ${deps}/node_modules ]; then
              ln -s ${deps}/node_modules node_modules
            fi
            deno info --json --vendor=true --frozen --config deno.json \
              ${lib.escapeShellArg "${packageDir}/${entrypoint}"} > graph.json
            if ! jq -e 'all(.modules[]; .error == null)' graph.json > /dev/null; then
              jq -r '.modules[] | select(.error) | .error' graph.json >&2
              exit 1
            fi
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p "$out/share/${pname'}" "$out/bin"
            cp -R ${runtimeSrc}/. "$out/share/${pname'}/"
            if [ -d ${deps}/vendor ]; then
              ln -s ${deps}/vendor "$out/share/${pname'}/vendor"
            fi
            if [ -d ${deps}/node_modules ]; then
              ln -s ${deps}/node_modules "$out/share/${pname'}/node_modules"
            fi
            makeWrapper ${pkgs.deno}/bin/deno "$out/bin/${binName'}" \
              --prefix PATH : ${lib.makeBinPath runtimeInputs} \
              --add-flags "run --vendor=true --frozen --cached-only" \
              --add-flags "--config $out/share/${pname'}/deno.json" \
              ${lib.concatMapStringsSep " \\\n              " (flag: ''--add-flags "${flag}"'') permissions} \
              --add-flags "$out/share/${pname'}/${packageDir}/${entrypoint}"
            runHook postInstall
          '';

          meta.mainProgram = binName';
        };
    in
    {
      _module.args.mkDenoPackage = mkDenoPackage;
    };
}
