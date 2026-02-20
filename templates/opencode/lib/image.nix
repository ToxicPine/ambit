{ pkgs, users, system, homeActivationPackages, configSources, entrypoint, imageName }:

let
  nixbldCount = 10;
  nixbldUids = builtins.genList (i: i + 30001) nixbldCount;

  userList = builtins.attrValues (builtins.mapAttrs (name: cfg: {
    inherit name;
    inherit (cfg) uid;
  }) users);

  passwdFile = pkgs.writeText "passwd" (
    "root:x:0:0:root:/root:/bin/bash\n"
    + "nobody:x:65534:65534:nobody:/nonexistent:/bin/false\n"
    + builtins.concatStringsSep "\n" (
      map (i: "nixbld${toString i}:x:${toString (30000 + i)}:30000:Nix build user ${toString i}:/var/empty:/bin/false")
        (builtins.genList (i: i + 1) nixbldCount)
    ) + "\n"
    + builtins.concatStringsSep "\n" (
      map (u: "${u.name}:x:${toString u.uid}:${toString u.uid}::/home/${u.name}:/bin/bash")
        userList
    ) + "\n"
  );

  groupFile = pkgs.writeText "group" (
    "root:x:0:\n"
    + "nixbld:x:30000:" + builtins.concatStringsSep "," (
      map (i: "nixbld${toString i}") (builtins.genList (i: i + 1) nixbldCount)
    ) + "\n"
    + "nobody:x:65534:\n"
    + builtins.concatStringsSep "\n" (
      map (u: "${u.name}:x:${toString u.uid}:")
        userList
    ) + "\n"
  );

  usersJson = pkgs.writeText "users.json" (builtins.toJSON userList);

  activationsJson = pkgs.writeText "activations.json" (builtins.toJSON (
    builtins.mapAttrs (_: pkg: "${pkg}") homeActivationPackages
  ));

  entrypointJson = pkgs.writeText "entrypoint.json" (builtins.toJSON system.entrypoint);

  daemonsJson = pkgs.writeText "daemons.json" (builtins.toJSON system.daemons);
in

pkgs.dockerTools.buildLayeredImageWithNixDb {
  name = imageName;
  tag = "latest";
  maxLayers = 125;

  contents = [
    pkgs.dockerTools.binSh
    pkgs.dockerTools.caCertificates
  ] ++ system.packages
    ++ (builtins.attrValues homeActivationPackages);

  fakeRootCommands = ''
    mkdir -p etc/nixcfg etc/nix
    cp ${passwdFile} etc/passwd
    cp ${groupFile} etc/group
    cp ${usersJson} etc/users.json
    cp ${activationsJson} etc/activations.json
    cp ${entrypointJson} etc/entrypoint.json
    cp ${daemonsJson} etc/daemons.json
    echo -e "experimental-features = nix-command flakes\nsandbox = false" > etc/nix/nix.conf
    mkdir -p nix/var/nix/daemon-socket
    mkdir -p usr/bin
    ln -s ${pkgs.coreutils}/bin/env usr/bin/env

    mkdir -p etc/nixcfg/lib
    ${builtins.concatStringsSep "\n" (
      map (src: "cp ${src.path} etc/nixcfg/${src.name}") configSources
    )}

    ${builtins.concatStringsSep "\n" (
      map (u: ''
        mkdir -p home/${u.name}
        chown ${toString u.uid}:${toString u.uid} home/${u.name}
      '') userList
    )}

    mkdir -p data tmp
    chmod 1777 tmp
  '';
  enableFakechroot = true;

  config = {
    Entrypoint = [ "${entrypoint}" ];
    Env = [
      "PATH=/bin:/sbin:/usr/bin:/usr/sbin"
      "NIX_PAGER=cat"
      "NIX_PATH=nixpkgs=flake:nixpkgs"
      "HOME=/root"
    ];
    ExposedPorts = { "${toString system.entrypoint.port}/tcp" = {}; };
    Volumes = { "/data" = {}; };
  };
}
