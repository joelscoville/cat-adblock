# cat-adblock

A small Firefox MV2 hackathon extension that blocks a subset of obvious ad requests and replaces many visible ad slots with looping local videos.

## Features

- Heuristic DOM scan for ad-like `iframe` and banner elements
- Light request blocking with a short hardcoded ad-host list
- Replacement videos sized to the detected ad slot
- Popup toggle plus manual rescan button

## Development environment

This repo includes a `devenv` flake for the tools needed to work on the extension:

- `firefox`
- `web-ext`
- `ffmpeg`
- `jq`
- `zip`
- `unzip`

Enter the shell with:

```sh
nix develop --accept-flake-config
```

Or, if you already use `devenv`:

```sh
devenv shell
```

Inside the shell:

- `run` starts Firefox with the extension loaded through `web-ext`
- `lint` runs `web-ext lint`
- `build` creates an `.xpi` in `.web-ext-artifacts/`

On macOS, plain `web-ext run` usually looks for Firefox at
`/Applications/Firefox.app/Contents/MacOS/firefox`. That does not match the
Nix-installed Firefox bundled by this repo. The `run` command handles this by
passing the Nix Firefox binary path explicitly, so Homebrew and `nix-homebrew`
are optional for this workflow.

## Local development

1. Enter the dev shell with `nix develop --accept-flake-config` or `devenv shell`.
2. Run `run` to launch a temporary Firefox profile with the extension loaded.
3. If you want to load it manually instead, open Firefox.
4. Visit `about:debugging#/runtime/this-firefox`.
5. Click `Load Temporary Add-on...`.
6. Select `manifest.json` from this repo.

## Notes

- This is intentionally a demo, not a full ad blocker.
- Request blocking is narrow and conservative.
- Some sites will still show ads or break around replaced slots.
- Replacement video selection is driven by `assets/video-manifest.json`; rerun `scripts/download_commons_cat_videos.py` after adding or downloading videos so the manifest stays current.
