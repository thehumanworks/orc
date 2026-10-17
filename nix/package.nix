# orc for Nix. Two derivations:
# - node_modules: `bun install --frozen-lockfile` from bun.lock, a fixed-output derivation
#   (the one build step with network access); its hash is in ./hashes.json.
# - orc: package.json's `compile:cli` script, the same build as without Nix, with nixpkgs'
#   bun as the embedded runtime.
{
  lib,
  stdenvNoCC,
  bun,
}:

let
  packageJson = lib.importJSON ../package.json;
  hashes = lib.importJSON ./hashes.json;
  lockDigest = builtins.substring 0 12 (builtins.hashFile "sha256" ../bun.lock);
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "orc";
  inherit (packageJson) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../tsconfig.json
      ../src
    ];
  };

  nativeBuildInputs = [ bun ];

  configurePhase = ''
    runHook preConfigure
    # A copy, not a symlink: through a symlink bun bundles the dependencies by their store
    # paths, and the binary would then reference (keep alive) the whole node_modules.
    cp -R ${finalAttrs.passthru.node_modules}/node_modules node_modules
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    bun run compile:cli
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 dist/orc $out/bin/orc
    runHook postInstall
  '';

  # The binary is a copy of bun with orc's bundle embedded: strip or patchelf would cut the
  # bundle off, and on macOS any edit voids the ad-hoc signature bun gives it. No fixup, so
  # $out/bin/orc is byte for byte what `bun build --compile` wrote.
  dontFixup = true;

  passthru.node_modules = stdenvNoCC.mkDerivation {
    # bun.lock's digest and bun's version in the name: when either changes the store path
    # changes too, so a stale hash fails the build instead of reusing old dependencies.
    name = "orc-node-modules-${lockDigest}-bun-${bun.version}";

    # Only the lockfile inputs, so editing the source does not refetch the dependencies.
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../bun.lock
      ];
    };

    nativeBuildInputs = [ bun ];
    impureEnvVars = lib.fetchers.proxyImpureEnvVars;

    dontConfigure = true;

    buildPhase = ''
      runHook preBuild
      export HOME="$TMPDIR/home" BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      # In a Linux sandbox Nix provides the host's CA bundle (its ssl-cert-file) here; trusting
      # it as well as bun's built-in roots lets the fetch work behind a TLS-inspecting proxy.
      if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
        export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
      fi
      # --os/--cpu '*': every platform's optional packages, so one hash fits every system.
      # --ignore-scripts: run no lifecycle scripts. Same tree as a plain install, which blocks
      # the dependencies' scripts as untrusted.
      bun install --frozen-lockfile --ignore-scripts --no-progress --os='*' --cpu='*'
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      mv node_modules $out/
      runHook postInstall
    '';

    # No patchShebangs: it would point bin scripts at store paths, which a fixed-output
    # derivation may not reference.
    dontFixup = true;

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = hashes.node_modules;
  };

  meta = {
    description = "Run claude, codex and pi coding agents as durable, detached sessions";
    homepage = "https://github.com/thehumanworks/orc";
    # No license: the repository has no LICENSE file and package.json no "license" field.
    mainProgram = "orc";
    inherit (bun.meta) platforms;
  };
})
