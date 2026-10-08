{
  description = "Ambit - Deploy To Private VPN";

  inputs = {
    self.submodules = true;
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      imports = [ ./deno.nix ];

      perSystem =
        {
          pkgs,
          self',
          mkDenoPackage,
          ...
        }:
        {
          devShells.default = pkgs.mkShell {
            nativeBuildInputs = [
              pkgs.deno
              pkgs.nodejs
              pkgs.flyctl
              pkgs.tailscale
            ];
          };

          packages =
            let
              ambit = mkDenoPackage {
                packageDir = "ambit";
                entrypoint = "main.ts";
                binName = "ambit";
                includedPaths = [
                  "main.ts"
                  "cli"
                  "lib"
                  "providers"
                  "schemas"
                  "util"
                  "router"
                  "skills"
                  "../ambit-skills/skills"
                ];
                depsHash = "sha256-I70Mw/oZALhxBg5/QU962CX50p7DAIfTCVW9gT/fu7M=";
                runtimeInputs = [
                  pkgs.flyctl
                  pkgs.gnutar
                  pkgs.gzip
                  pkgs.tailscale
                ];
              };
            in
            {
              inherit ambit;
              default = ambit;
            };

          apps =
            let
              ambit = self'.packages.ambit;
            in
            {
              ambit = {
                type = "app";
                program = "${ambit}/bin/ambit";
              };

              default = self'.apps.ambit;
            };
        };
    };
}
