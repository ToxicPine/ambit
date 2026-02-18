# Flake-parts module: Deno workspace builder
#
# Provides mkDenoPackage for compiling Deno entrypoints into standalone binaries.
#

{ inputs, lib, ... }:

{
  perSystem = { system, ... }:
    let
      pkgs = import inputs.nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };

      depsHash = "sha256-5mMA8eUfyWt2wX+sspQtMQWrrdx0Xk1cgOfJko0AQTQ=";

      denoDeps = pkgs.stdenv.mkDerivation {
        name = "deno-workspace-deps";
        src = lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            let name = builtins.baseNameOf path; in
            type == "directory"
            || lib.hasSuffix ".ts" name
            || name == "deno.json"
            || name == "deno.lock";
        };

        nativeBuildInputs = [ pkgs.deno pkgs.cacert ];

        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = depsHash;

        buildPhase = ''
          export HOME=$TMPDIR
          export DENO_DIR="$out"

          deno cache --lock=deno.lock \
            ambit/main.ts \
            ambit-mcp/main.ts \
            chromatic/main.ts

          echo 'Deno.exit(0)' > $TMPDIR/stub.ts
          deno compile --output $TMPDIR/stub $TMPDIR/stub.ts
          rm -f $TMPDIR/stub
        '';

        dontInstall = true;
      };

      mkDenoPackage = { pname, version, entrypoint, binName ? pname }:
        let
          raw = pkgs.stdenv.mkDerivation {
            name = "${pname}-unwrapped";
            inherit version;
            src = ./.;

            nativeBuildInputs = [ pkgs.deno ];

            dontStrip = true;
            dontPatchELF = true;

            buildPhase = ''
              export HOME=$TMPDIR

              # Writable copy of the pre-warmed cache (Nix store is read-only).
              cp -r ${denoDeps} $TMPDIR/deno-cache
              chmod -R u+w $TMPDIR/deno-cache
              export DENO_DIR=$TMPDIR/deno-cache

              deno compile -A --output $TMPDIR/${binName} ${entrypoint}
            '';

            installPhase = ''
              mkdir -p $out/bin
              cp $TMPDIR/${binName} $out/bin/${binName}
            '';
          };
        in
        # deno compile embeds JS in the ELF trailer — patchelf corrupts it.
        # buildFHSEnv gives the binary an FHS namespace with the standard
        # /lib64 dynamic linker, so it runs unmodified on NixOS.
        if pkgs.stdenv.isLinux then
          pkgs.buildFHSEnv {
            name = binName;
            runScript = "${raw}/bin/${binName}";
          }
        else
          raw;
    in
    {
      _module.args.mkDenoPackage = mkDenoPackage;
    };
}
