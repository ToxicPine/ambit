{
  description = "ambit-mcp - MCP Server for Safe ambit Deployments";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
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

      perSystem = { pkgs, ... }:
        let
          mcpServer = pkgs.stdenv.mkDerivation {
            pname = "ambit-mcp";
            version = "0.1.0";
            src = ./.;

            nativeBuildInputs = [ pkgs.deno ];

            buildPhase = ''
              export DENO_DIR=$(mktemp -d)
              export HOME=$(mktemp -d)
              deno compile \
                --allow-all \
                --output ambit-mcp \
                main.ts
            '';

            installPhase = ''
              mkdir -p $out/bin
              cp ambit-mcp $out/bin/
            '';
          };

          setup = pkgs.stdenv.mkDerivation {
            pname = "ambit-mcp-setup";
            version = "0.1.0";
            src = ./.;

            nativeBuildInputs = [ pkgs.deno ];

            buildPhase = ''
              export DENO_DIR=$(mktemp -d)
              export HOME=$(mktemp -d)
              deno compile \
                --allow-read --allow-write --allow-env \
                --output ambit-mcp-setup \
                setup.ts
            '';

            installPhase = ''
              mkdir -p $out/bin
              cp ambit-mcp-setup $out/bin/
            '';
          };
        in
        {
          packages = {
            default = mcpServer;
            ambit-mcp = mcpServer;
            inherit setup;
          };

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.deno
              pkgs.flyctl
            ];
          };
        };
    };
}
