{
  description = "RemCodex with local Whisper transcription support";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;
        nodejs = pkgs.nodejs_20;
        mockCodexCommand = pkgs.writeShellScriptBin "mock-codex" ''
          exec ${nodejs}/bin/node ${./tests/mock-codex-app-server.js} "$@"
        '';
        playwrightRunner = pkgs.writeShellScriptBin "run-remcodex-debug-output-playwright" ''
          export NODE_PATH=${pkgs.playwright}/lib/node_modules
          export CHROMIUM_BIN=${pkgs.chromium}/bin/chromium
          exec ${nodejs}/bin/node ${./tests/remcodex-debug-output.playwright.js} "$@"
        '';
        whisperModelTiny = pkgs.runCommand "faster-whisper-tiny-en" { } ''
          mkdir -p $out
          cp ${pkgs.fetchurl {
            url = "https://huggingface.co/Systran/faster-whisper-tiny.en/resolve/main/model.bin";
            sha256 = "0akbjc75br4jakamgb92l17fw461bjz7i7csbjbirfaddbhglnhs";
          }} $out/model.bin
          cp ${pkgs.fetchurl {
            url = "https://huggingface.co/Systran/faster-whisper-tiny.en/resolve/main/config.json";
            sha256 = "1ibwd97kijpjci44r7nb9508f6jndd1625483davqj83m4hv9c8l";
          }} $out/config.json
          cp ${pkgs.fetchurl {
            url = "https://huggingface.co/Systran/faster-whisper-tiny.en/resolve/main/tokenizer.json";
            sha256 = "1pr25px1bnafw3j29qyqf38k5qdmpjmx2xcanghxqdll8195574j";
          }} $out/tokenizer.json
          cp ${pkgs.fetchurl {
            url = "https://huggingface.co/Systran/faster-whisper-tiny.en/resolve/main/vocabulary.txt";
            sha256 = "1kqml5svagpwcv5k6xf5392f4p5rszznjnxb69fmk8nk8s3mhxzz";
          }} $out/vocabulary.txt
        '';
        remcodex = pkgs.buildNpmPackage rec {
          pname = "remcodex";
          version = "0.1.0-beta.13";
          src = self;

          inherit nodejs;
          npmDepsHash = "sha256-tc76sGP+OO0sz98A7WTs+7frXV9EDu87TWoCgfCy1os=";

          nativeBuildInputs = [
            pkgs.makeWrapper
            nodejs
            pkgs.pkg-config
            pkgs.python3
          ];

          npmBuildScript = "build";
          doCheck = false;

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/remcodex
            cp -r dist $out/lib/remcodex/dist
            cp -r node_modules $out/lib/remcodex/node_modules
            cp -r web $out/lib/remcodex/web
            cp package.json package-lock.json README.md LICENSE $out/lib/remcodex/

            makeWrapper ${nodejs}/bin/node $out/bin/remcodex \
              --add-flags $out/lib/remcodex/dist/server/src/cli.js

            runHook postInstall
          '';

          meta = with lib; {
            description = "Remote control for Codex from a browser or phone";
            homepage = "https://remcodex.com";
            license = licenses.mit;
            platforms = platforms.unix;
            mainProgram = "remcodex";
          };
        };
        remcodex-with-whisper = pkgs.symlinkJoin {
          name = "remcodex-with-whisper-${remcodex.version}";
          paths = [ remcodex ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postBuild = ''
            wrapProgram $out/bin/remcodex \
              --prefix PATH : ${lib.makeBinPath [ nodejs pkgs.whisper-ctranslate2 pkgs.ffmpeg ]} \
              --set-default REMCODEX_STT_BINARY ${pkgs.whisper-ctranslate2}/bin/whisper-ctranslate2 \
              --set-default REMCODEX_STT_MODEL_PATH ${whisperModelTiny}
          '';
          meta = remcodex.meta // {
            description = "${remcodex.meta.description} with whisper-ctranslate2 on PATH";
          };
        };
        remcodexDebugImage = pkgs.dockerTools.buildLayeredImage {
          name = "remcodex-debug-output";
          tag = "latest";
          contents = [
            remcodex
            mockCodexCommand
            pkgs.coreutils
            pkgs.bash
          ];
          config = {
            Entrypoint = [ "${remcodex}/bin/remcodex" "start" "--no-open" ];
            Env = [
              "PORT=18840"
              "CODEX_COMMAND=/bin/mock-codex"
              "CODEX_MODE=app-server"
              "PROJECT_ROOTS=/workspace"
              "DATABASE_PATH=/data/remcodex.db"
              "MOCK_CODEX_STREAM_MODE=item-updated"
            ];
          };
        };
      in {
        packages = {
          default = remcodex-with-whisper;
          inherit remcodex remcodex-with-whisper whisperModelTiny remcodexDebugImage;
        };

        apps = {
          default = {
            type = "app";
            program = "${remcodex-with-whisper}/bin/remcodex";
          };
          remcodex = {
            type = "app";
            program = "${remcodex}/bin/remcodex";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pkgs.pkg-config
            pkgs.python3
            pkgs.whisper-ctranslate2
            pkgs.ffmpeg
          ];

          shellHook = ''
            export REMCODEX_STT_BINARY=${pkgs.whisper-ctranslate2}/bin/whisper-ctranslate2
            export REMCODEX_STT_MODEL_PATH=${whisperModelTiny}
            echo "Node $(node --version) and whisper support are available."
          '';
        };
      } // lib.optionalAttrs pkgs.stdenv.isLinux {
        checks.remcodex-debug-output = pkgs.testers.runNixOSTest {
          name = "remcodex-debug-output";
          nodes.machine = { pkgs, ... }: {
            virtualisation.podman.enable = true;
            virtualisation.oci-containers.backend = "podman";
            virtualisation.oci-containers.containers.remcodex = {
              autoStart = true;
              image = "remcodex-debug-output:latest";
              imageFile = remcodexDebugImage;
              environment = {
                PORT = "18840";
                CODEX_COMMAND = "/bin/mock-codex";
                CODEX_MODE = "app-server";
                PROJECT_ROOTS = "/workspace";
                DATABASE_PATH = "/data/remcodex.db";
                MOCK_CODEX_CHUNK_DELAY_MS = "6";
                MOCK_CODEX_CHUNK_COUNT = "8";
                MOCK_CODEX_STREAM_MODE = "item-updated";
              };
              ports = [ "127.0.0.1:18840:18840" ];
              volumes = [
                "/var/lib/remcodex-test/workspace:/workspace"
                "/var/lib/remcodex-test/data:/data"
              ];
            };

            systemd.tmpfiles.rules = [
              "d /var/lib/remcodex-test 0755 root root -"
              "d /var/lib/remcodex-test/workspace 0755 root root -"
              "d /var/lib/remcodex-test/data 0755 root root -"
              "d /tmp/remcodex-debug-output 0755 root root -"
            ];

            environment.systemPackages = [
              pkgs.chromium
              pkgs.nodejs_20
              pkgs.playwright
              playwrightRunner
            ];
          };

          testScript = ''
            machine.start()
            machine.wait_for_unit("podman-remcodex.service")
            machine.wait_for_open_port(18840)
            machine.succeed("curl --fail --silent http://127.0.0.1:18840/health >/tmp/remcodex-health.json")

            status, output = machine.execute(
                "REMCODEX_BASE_URL=http://127.0.0.1:18840 "
                "REMCODEX_ARTIFACT_DIR=/tmp/remcodex-debug-output "
                "REMCODEX_PROJECT_PATH=/workspace/e2e-project "
                "REMCODEX_TURN_COUNT=150 "
                "REMCODEX_EXPECT_STREAM_MODE=item-updated "
                "run-remcodex-debug-output-playwright"
            )
            if status != 0:
                machine.succeed("echo '=== playwright output ===' >&2")
                machine.succeed("cat /tmp/remcodex-debug-output/fatal.json >&2 || true")
                machine.succeed("cat /tmp/remcodex-debug-output/summary.json >&2 || true")
                machine.succeed("echo '=== podman logs ===' >&2")
                machine.succeed("podman logs remcodex >&2 || journalctl -u podman-remcodex.service --no-pager >&2 || true")
                raise Exception(f"Playwright reproduction failed with status {status}: {output}")

            machine.succeed("cat /tmp/remcodex-debug-output/summary.json >/tmp/remcodex-debug-output-summary.json")
          '';
        };
      });
}
