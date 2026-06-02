{
  description = "Ambit - Deploy To Private VPN";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      imports = [ ./deno.nix ];

      perSystem = { system, self', mkDenoPackage, ... }:
        let
          pkgs = import inputs.nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };
          unstablePkgs = import inputs.nixpkgs-unstable {
            inherit system;
            config.allowUnfree = true;
          };
        in
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
                depsHash = "sha256-lOPeKbqJVtF+BDq66COWiNOaZkhCxdmNdnWMxJpjkq4=";
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
