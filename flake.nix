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
              pkgs.flyctl
              pkgs.tailscale
              unstablePkgs.claude-code
            ];
          };

          packages = {
            default = mkDenoPackage {
              pname = "ambit";
              version = "0.1.0";
              entrypoint = "ambit/main.ts";
            };

            ambit = mkDenoPackage {
              pname = "ambit";
              version = "0.1.0";
              entrypoint = "ambit/main.ts";
            };

            ambit-mcp = mkDenoPackage {
              pname = "ambit-mcp";
              version = "0.1.0";
              entrypoint = "ambit-mcp/main.ts";
            };

            chromatic = mkDenoPackage {
              pname = "chromatic";
              version = "0.2.0";
              entrypoint = "chromatic/main.ts";
            };
          };
        };
    };
}
