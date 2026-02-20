{ pkgs, ... }:

{
  imageName = "lazycoder";

  daemons = [
    # { name = "my-agent"; command = [ "my-agent" ]; user = "user"; }
  ];

  entrypoint = {
    command = [ "opencode" "web" "--hostname" "0.0.0.0" "--port" "3000" "--cors" "*" ];
    user = "user";
    port = 3000;
  };

  packages = with pkgs; [
    bashInteractive
    bzip2
    coreutils
    diffutils
    file
    findutils
    gawk
    gnugrep
    gnused
    gnutar
    gzip
    inetutils
    jq
    less
    ncurses
    nix
    procps
    psmisc
    ripgrep
    rsync
    tree
    unzip
    util-linux
    which
    xz
    zip
  ];
}
