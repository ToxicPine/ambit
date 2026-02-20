{ pkgs, pkgs-unstable, ... }:

{
  home.stateVersion = "25.11";

  programs.home-manager.enable = true;

  programs.bash = {
    enable = true;
    initExtra = ''[[ "$PWD" == "/" ]] && cd'';
    shellAliases = {
      ll = "ls -la";
      rebuild = "cd ~/.nixcfg && home-manager switch --flake .";
    };
  };

  home.packages = (with pkgs; [
    curl
    git
    htop
    nodejs
    flyctl
    deno
    tmux
    vim
  ]) ++ (with pkgs-unstable; [
    opencode
  ]);

  programs.git = {
    enable = true;
  };

  programs.tmux = {
    enable = true;
    terminal = "screen-256color";
  };
}
