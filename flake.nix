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

      perSystem = { system, mkDenoPackage, ... }:
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
              unstablePkgs.claude-code
            ];
          };

          packages = let
            ambit = mkDenoPackage {
              pname = "ambit";
              version = "0.2.0";
              entrypoint = "ambit/main.ts";
              depsHash = "sha256-ZmqE8oV1hr4O8MlVNOJwnho/qOlwRG+4nwX/iW9dEO4=";
            };
          in {
            inherit ambit;
            default = ambit;
          };
        };
    };
}
