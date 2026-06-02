# Flake-parts module for packaging Deno workspace members.
#
# mkDenoPackage reads name/version metadata from the package deno.json, vendors
# dependencies in a fixed-output derivation, then wraps `deno run`.

{ inputs, lib, ... }:

let
  workspaceRoot = ./.;
  workspaceRootString = builtins.toString workspaceRoot;

  dependencyExtensions = [
    ".cjs"
    ".cts"
    ".js"
    ".json"
    ".jsonc"
    ".jsx"
    ".mjs"
    ".mts"
    ".ts"
    ".tsx"
  ];

  stripScope = name: lib.last (lib.splitString "/" name);
in
{
  perSystem =
    { system, ... }:
    let
      pkgs = import inputs.nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };

      cleanPackageSource =
        packageDir:
        filterFile:
        pkgs.nix-gitignore.gitignoreFilterSource
          (
            path: type:
            let
              pathString = builtins.toString path;
              relPath =
                if pathString == workspaceRootString then
                  ""
                else
                  lib.removePrefix "${workspaceRootString}/" pathString;
              inPackage =
                relPath == packageDir
                || lib.hasPrefix "${packageDir}/" relPath;
              name = builtins.baseNameOf path;
            in
            inPackage && (type == "directory" || filterFile name)
          )
          [ ]
          workspaceRoot;

      mkDenoPackage =
        {
          packageDir,
          entrypoint,
          depsHash,
          configFile ? "deno.json",
          lockFile ? "deno.lock",
          pname ? null,
          version ? null,
          binName ? null,
          permissions ? [ "-A" ],
          runtimeInputs ? [ ],
        }:
        let
          denoConfig =
            builtins.fromJSON (builtins.readFile (workspaceRoot + "/${packageDir}/${configFile}"));
          packageName = stripScope (denoConfig.name or packageDir);
          pname' = if pname == null then packageName else pname;
          version' = if version == null then denoConfig.version else version;
          binName' = if binName == null then pname' else binName;

          dependencySrc = cleanPackageSource packageDir (
            name:
            lib.elem name [
              configFile
              lockFile
            ]
            || lib.any (suffix: lib.hasSuffix suffix name) dependencyExtensions
          );

          runtimeSrc = cleanPackageSource packageDir (_name: true);

          deps = pkgs.stdenvNoCC.mkDerivation {
            pname = "${pname'}-deno-deps";
            version = version';
            src = dependencySrc;

            nativeBuildInputs = [
              pkgs.cacert
              pkgs.deno
            ];

            buildPhase = ''
              runHook preBuild

              if [ -d ${packageDir} ]; then
                cd ${packageDir}
              fi

              export HOME="$TMPDIR"
              export DENO_DIR="$TMPDIR/deno-cache"
              deno cache \
                --vendor=true \
                --frozen \
                --config ${configFile} \
                --lock ${lockFile} \
                ${entrypoint}

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              if [ -d ${packageDir} ]; then
                cd ${packageDir}
              fi

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

          nativeBuildInputs = [
            pkgs.makeWrapper
          ];

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/share/${pname'}" "$out/bin"
            cp -R ${packageDir}/. "$out/share/${pname'}/"

            if [ -d ${deps}/vendor ]; then
              cp -R ${deps}/vendor "$out/share/${pname'}/"
            fi

            if [ -d ${deps}/node_modules ]; then
              cp -R ${deps}/node_modules "$out/share/${pname'}/"
            fi

            makeWrapper ${pkgs.deno}/bin/deno "$out/bin/${binName'}" \
              --prefix PATH : ${lib.makeBinPath runtimeInputs} \
              --add-flags "run" \
              --add-flags "--vendor=true" \
              --add-flags "--frozen" \
              --add-flags "--cached-only" \
              --add-flags "--config $out/share/${pname'}/${configFile}" \
              --add-flags "--lock $out/share/${pname'}/${lockFile}" \
              ${lib.concatMapStringsSep " \\\n              " (flag: ''--add-flags "${flag}"'') permissions} \
              --add-flags "$out/share/${pname'}/${entrypoint}"

            runHook postInstall
          '';

          meta = {
            mainProgram = binName';
          };
        };
    in
    {
      _module.args.mkDenoPackage = mkDenoPackage;
    };
}
