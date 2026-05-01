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

  scripts.run.exec =
    "web-ext run --source-dir . --firefox ${pkgs.firefox}/Applications/Firefox.app/Contents/MacOS/firefox";
  scripts.lint.exec = "web-ext lint --source-dir .";
  scripts.build.exec = "web-ext build --source-dir . --artifacts-dir .web-ext-artifacts";

  enterShell = ''
    echo "Firefox extension shell ready."
    echo "Run: devenv shell"
    echo "Start temporary addon: run"
    echo "Lint extension: lint"
    echo "Build xpi: build"
  '';
}
