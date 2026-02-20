{ pkgs }:

pkgs.buildNpmPackage {
  pname = "wetty";
  version = "2.7.0";

  src = pkgs.fetchFromGitHub {
    owner = "ToxicPine";
    repo = "wetty";
    rev = "e48b04b74e958e7fd34f22ab47b99e13d438836d";
    hash = "sha256-gLg2TA0mQSejtx3REwUC2LBloi8/Ad1uQ8+uityXt2E=";
  };

  postPatch = ''
    cp ${./package-lock.json} package-lock.json
  '';

  npmDepsHash = "sha256-Nz8Non0j/RaErylp2MDk/HqDMeXpaBvdYbKkDszGzG4=";

  nativeBuildInputs = with pkgs; [
    (python3.withPackages (ps: [ ps.setuptools ]))
    nodePackages.pnpm
    pkg-config
    makeWrapper
  ];

  npmBuildScript = "build";

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/wetty $out/bin
    cp -r build node_modules package.json conf $out/lib/wetty/
    makeWrapper ${pkgs.nodejs}/bin/node $out/bin/wetty \
      --add-flags "$out/lib/wetty/build/main.js"
    runHook postInstall
  '';
}
