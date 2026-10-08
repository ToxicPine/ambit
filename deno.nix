# Compile Deno workspace members with a shared lockfile and pinned runtime.
{ lib, inputs, ... }:

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
    { pkgs, system, ... }:
    let
      denortVersion = "2.7.14";
      denort =
        assert lib.assertMsg (pkgs.deno.version == denortVersion) "Deno and denort versions must match.";
        pkgs.stdenvNoCC.mkDerivation {
          pname = "denort";
          version = denortVersion;
          src = inputs."denort-${system}";
          dontUnpack = true;
          nativeBuildInputs = [ pkgs.unzip ] ++ lib.optional pkgs.stdenv.isLinux pkgs.autoPatchelfHook;
          buildInputs = lib.optional pkgs.stdenv.isLinux pkgs.stdenv.cc.cc.lib;
          dontStrip = true;
          installPhase = ''
            mkdir -p "$out/bin"
            unzip "$src" -d "$out/bin"
            chmod +x "$out/bin/denort"
          '';
        };
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
          # Package-relative source and asset paths to compile and embed.
          includedPaths ? [ "." ],
        }:
        let
          packageRoot = workspaceRoot + "/${packageDir}";
          denoConfig = builtins.fromJSON (builtins.readFile (packageRoot + "/deno.json"));
          packageName = lib.last (lib.splitString "/" (denoConfig.name or packageDir));
          pname' = if pname == null then packageName else pname;
          version' = if version == null then denoConfig.version else version;
          binName' = if binName == null then pname' else binName;

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
          src = sourceFor (workspaceFiles ++ map (path: packageRoot + "/${path}") includedPaths);
          dontFixup = true;
          nativeBuildInputs = [
            pkgs.deno
            pkgs.makeWrapper
          ];
          DENORT_BIN = "${denort}/bin/denort";

          buildPhase = ''
            runHook preBuild
            export DENO_DIR="$TMPDIR/deno-cache"
            if [ -d ${deps}/vendor ]; then
              ln -s ${deps}/vendor vendor
            fi
            if [ -d ${deps}/node_modules ]; then
              ln -s ${deps}/node_modules node_modules
            fi
            deno compile --vendor=true --frozen --cached-only --config deno.json \
              --self-extracting --output ${lib.escapeShellArg "build/${binName'}"} \
              ${lib.escapeShellArgs permissions} \
              ${
                lib.concatMapStringsSep " " (
                  path: "--include " + lib.escapeShellArg "${packageDir}/${path}"
                ) includedPaths
              } \
              ${lib.escapeShellArg "${packageDir}/${entrypoint}"}
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p "$out/bin"
            install -m755 ${lib.escapeShellArg "build/${binName'}"} "$out/bin/${binName'}"
            wrapProgram "$out/bin/${binName'}" --prefix PATH : ${lib.makeBinPath runtimeInputs}
            runHook postInstall
          '';

          meta.mainProgram = binName';
        };
    in
    {
      _module.args.mkDenoPackage = mkDenoPackage;
    };
}
