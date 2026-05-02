# cat-adblock

A small Firefox MV2 hackathon extension that blocks a subset of obvious ad requests and replaces many visible ad slots with videos served by a local backend API.

## Features

- Heuristic DOM scan for ad-like `iframe` and banner elements
- Light request blocking with a short hardcoded ad-host list
- Backend-served replacement videos sized to the detected ad slot
- Category mixing for `cat-videos`, `memes`, and `brainrot`
- Popup toggle plus manual rescan button

## Development environment

This repo includes a `devenv` flake for the tools needed to work on the extension:

- `firefox`
- `web-ext`
- `ffmpeg`
- `nodejs`
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

- `index-assets` rebuilds the legacy local asset index
- `video-api` starts the local backend at `http://localhost:3000`
- `run` starts Firefox with the extension loaded through `web-ext`
- `demo` starts the local backend and Firefox extension together
- `lint` runs `web-ext lint`
- `build` creates an `.xpi` in `.web-ext-artifacts/`

## Local video API

The extension has a hard runtime dependency on the local video API. It does not
load replacement videos from bundled extension folders.

Start the backend:

```sh
video-api
```

Or start the backend and temporary Firefox extension together:

```sh
demo
```

The API runs at:

```txt
http://localhost:3000/api/videos
```

Videos are served by the API from `server/videos`. The extension does not expose
or load bundled video assets.
If the backend is not running, the popup shows:

```txt
Video API unavailable. Start `video-api` before using Cat Adblocker.
```

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
- Replacement video selection is driven by `http://localhost:3000/api/videos`.
- Firefox blocks audible autoplay from page media inserted by content scripts. Cat Adblocker keeps page videos muted and plays matching audio from the extension background page, which depends on Firefox's default `media.autoplay.allow-extension-background-pages = true`; if that preference is disabled, audible autoplay cannot be forced by the extension.
- Add API videos by dropping `.webm` files into category folders under `server/videos/`, such as `server/videos/cat-videos`, `server/videos/memes`, and `server/videos/brainrot`.
- Put hackathon demo videos in `server/videos`, then run `video-api` or `demo`.
- The old Wikimedia Commons downloader still writes into `assets/videos/cat-videos`; move or copy downloaded files into `server/videos/cat-videos` when using the API-only extension flow.
- The extension does not use `assets/videos` at runtime.
