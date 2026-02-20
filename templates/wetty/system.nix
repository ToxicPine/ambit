{ pkgs, wetty, ... }:

{
  imageName = "wetty";

  daemons = [
    # { name = "my-agent"; command = [ "my-agent" ]; user = "user"; }
  ];

  entrypoint = {
    command = [ "wetty" "--port" "3000" "--host" "0.0.0.0" "--command" "bash -l" "--base" "/" "--title" "Ambit Shell" ];
    user = "user";
    port = 3000;
  };

  packages = with pkgs; [
    bashInteractive
    coreutils
    findutils
    gnugrep
    gnused
    jq
    nix
    util-linux
    wetty
  ];
}
