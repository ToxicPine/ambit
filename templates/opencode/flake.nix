{
  description = "dumbcomputer — NixOS Home Manager on Fly.io";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ flake-parts, ... }:
    let
      system = "x86_64-linux";
      pkgs = inputs.nixpkgs.legacyPackages.${system};
      pkgs-unstable = inputs.nixpkgs-unstable.legacyPackages.${system};

      users = import ./users.nix;
      sysConfig = import ./system.nix { inherit pkgs; };

      mkHome = username: inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        extraSpecialArgs = { inherit pkgs-unstable; };
        modules = [
          ./home.nix
          { home.username = username; home.homeDirectory = "/home/${username}"; }
        ] ++ (if users.${username} ? home then [ users.${username}.home ] else []);
      };

      homeConfigurations = builtins.mapAttrs (name: _: mkHome name) users;
    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ system ];

      perSystem = { ... }: {
        packages.default = import ./lib/image.nix {
          inherit pkgs users;
          imageName = sysConfig.imageName;
          system = sysConfig;
          homeActivationPackages = builtins.mapAttrs
            (_: hc: hc.activationPackage) homeConfigurations;
          entrypoint = pkgs.writeShellScript "entrypoint" (builtins.readFile ./lib/entrypoint.sh);
          configSources = [
            { name = "flake.nix";        path = ./flake.nix; }
            { name = "flake.lock";       path = ./flake.lock; }
            { name = "home.nix";         path = ./home.nix; }
            { name = "system.nix";       path = ./system.nix; }
            { name = "users.nix";        path = ./users.nix; }
            { name = "lib/image.nix";    path = ./lib/image.nix; }
            { name = "lib/entrypoint.sh"; path = ./lib/entrypoint.sh; }
          ];
        };
      };

      flake = {
        lib = { inherit mkHome; };
        inherit homeConfigurations;
      };
    };
}
