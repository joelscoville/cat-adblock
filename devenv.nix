{ pkgs, ... }:

{
  packages = with pkgs; [
    firefox
    web-ext
    ffmpeg
    jq
    zip
    unzip
  ];

  scripts.index-assets.exec = "python3 scripts/generate_video_index.py";
  scripts.run.exec =
    "python3 scripts/generate_video_index.py && web-ext run --source-dir . --firefox ${pkgs.firefox}/Applications/Firefox.app/Contents/MacOS/firefox";
  scripts.lint.exec = "web-ext lint --source-dir .";
  scripts.build.exec =
    "python3 scripts/generate_video_index.py && web-ext build --source-dir . --artifacts-dir .web-ext-artifacts";

  enterShell = ''
    echo "Firefox extension shell ready."
    echo "Run: devenv shell"
    echo "Rebuild index: index-assets"
    echo "Start temporary addon: run"
    echo "Lint extension: lint"
    echo "Build xpi: build"
  '';
}
