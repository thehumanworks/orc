{
  description = "orc: multi-agent orchestration CLI and SDK (Bun)";

  # nixpkgs-unstable's channel tarball: `nix flake lock` pins it to an immutable
  # releases.nixos.org URL plus narHash, as reproducible as a github: input but lockable
  # without the GitHub API.
  inputs.nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.xz";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      # nixpkgs-unstable no longer supports x86_64-darwin: Intel Macs use the release binary.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      overlays.default = final: _prev: { orc = final.callPackage ./nix/package.nix { }; };

      packages = forAllSystems (
        _system: pkgs:
        let
          orc = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit orc;
          default = orc;
        }
      );

      apps = forAllSystems (
        system: pkgs: {
          default = {
            type = "app";
            program = lib.getExe self.packages.${system}.orc;
            meta.description = "The orc CLI";
          };
          update-deps-hash = {
            type = "app";
            program = lib.getExe (
              pkgs.writeShellApplication {
                name = "update-deps-hash";
                runtimeInputs = with pkgs; [
                  coreutils
                  git
                  gnused
                ];
                text = ''exec ${pkgs.runtimeShell} ${./nix/update-deps-hash.sh} "$@"'';
              }
            );
            meta.description = "Refresh nix/hashes.json (the npm dependencies hash) after bun.lock changes";
          };
        }
      );

      checks = forAllSystems (
        system: pkgs:
        let
          inherit (self.packages.${system}) orc;
        in
        {
          inherit orc;

          # The same offline compiled-binary Pi/Claude actor smoke as Bun/native CI.
          smoke = pkgs.runCommand "orc-smoke" {
            nativeBuildInputs = [ orc pkgs.bun pkgs.git ] ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.procps ];
          } ''
            export HOME="$TMPDIR/home" ORC_HOME="$TMPDIR/orc-home"
            mkdir -p "$HOME" "$ORC_HOME"
            bun ${./scripts/verify-runtime/compiled.ts} ${lib.getExe orc} \
              --fixtures ${./test/fixtures} --version ${orc.version} > smoke.json || { cat smoke.json; exit 1; }
            cat smoke.json
            touch $out
          '';

          # package.json's typecheck (`bun x tsc --noEmit`) on src, test and scripts.
          typecheck = pkgs.stdenvNoCC.mkDerivation {
            name = "orc-typecheck";
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./package.json
                ./tsconfig.json
                ./src
                ./test
                ./orc.workflows
                ./scripts
              ];
            };
            nativeBuildInputs = [ pkgs.bun ];
            dontConfigure = true;
            buildPhase = ''
              runHook preBuild
              ln -s ${orc.node_modules}/node_modules node_modules
              # What `bun x tsc` runs when there is no node, called directly: bun x would exec
              # tsc's `#!/usr/bin/env node`, and the sandbox has no /usr/bin/env.
              bun node_modules/.bin/tsc --noEmit
              runHook postBuild
            '';
            installPhase = "touch $out";
          };
        }
      );

      devShells = forAllSystems (
        _system: pkgs: {
          default = pkgs.mkShellNoCC {
            packages =
              with pkgs;
              [
                bun
                git
                jq
                bashInteractive
                nixfmt
              ]
              # orc's process-tree helpers call ps; macOS ships it.
              ++ lib.optionals stdenv.hostPlatform.isLinux [ procps ];
          };
        }
      );

      # `nix fmt`: nixfmt (RFC style) over every .nix file in the repository.
      formatter = forAllSystems (_system: pkgs: pkgs.nixfmt-tree);
    };
}
