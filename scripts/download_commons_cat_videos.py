#!/usr/bin/env python3

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


API_URL = "https://commons.wikimedia.org/w/api.php"
CATEGORY = "Category:Videos of cats"
DEFAULT_UA = "cat-adblocker-downloader/1.0 (local workspace task)"
INDEX_SCRIPT = Path(__file__).with_name("generate_video_index.py")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download all files from the Wikimedia Commons 'Videos of cats' category."
    )
    parser.add_argument(
        "--output-dir",
        default="assets/videos/cat-videos",
        help="Directory to store downloaded files. Default: assets/videos/cat-videos",
    )
    parser.add_argument(
        "--delay-seconds",
        type=float,
        default=15.0,
        help="Delay between completed downloads. Default: 15 seconds",
    )
    parser.add_argument(
        "--metadata-delay-seconds",
        type=float,
        default=2.0,
        help="Delay between Wikimedia API metadata requests. Default: 2 seconds",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=10,
        help="Maximum retries for rate limits and transient errors. Default: 10",
    )
    parser.add_argument(
        "--user-agent",
        default=DEFAULT_UA,
        help=f"HTTP User-Agent to send. Default: {DEFAULT_UA}",
    )
    return parser.parse_args()


class CommonsClient:
    def __init__(self, user_agent: str, max_retries: int, metadata_delay_seconds: float) -> None:
        self.user_agent = user_agent
        self.max_retries = max_retries
        self.metadata_delay_seconds = metadata_delay_seconds

    def _open(self, url: str):
        delay = 5.0
        for attempt in range(1, self.max_retries + 1):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
                return urllib.request.urlopen(request)
            except urllib.error.HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504) or attempt == self.max_retries:
                    raise
                retry_after = exc.headers.get("Retry-After")
                wait_seconds = float(retry_after) if retry_after else delay
                print(
                    f"HTTP {exc.code} for {url}; sleeping {wait_seconds:.1f}s before retry {attempt + 1}/{self.max_retries}",
                    flush=True,
                )
                time.sleep(wait_seconds)
                delay = min(delay * 2, 300.0)
            except urllib.error.URLError:
                if attempt == self.max_retries:
                    raise
                print(
                    f"Network error for {url}; sleeping {delay:.1f}s before retry {attempt + 1}/{self.max_retries}",
                    flush=True,
                )
                time.sleep(delay)
                delay = min(delay * 2, 300.0)
        raise RuntimeError(f"Failed to open URL after {self.max_retries} attempts: {url}")

    def fetch_json(self, params: dict) -> dict:
        url = f"{API_URL}?{urllib.parse.urlencode(params)}"
        with self._open(url) as response:
            payload = json.load(response)
        time.sleep(self.metadata_delay_seconds)
        return payload


def list_category_files(client: CommonsClient) -> list[str]:
    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": CATEGORY,
        "cmtype": "file",
        "cmlimit": "max",
        "format": "json",
    }
    titles: list[str] = []
    continuation: dict = {}
    while True:
        query = params.copy()
        query.update(continuation)
        payload = client.fetch_json(query)
        titles.extend(member["title"] for member in payload["query"]["categorymembers"])
        continuation = payload.get("continue", {})
        if not continuation:
            return titles


def get_file_metadata(client: CommonsClient, titles: list[str]) -> list[dict]:
    metadata: list[dict] = []
    for start in range(0, len(titles), 50):
        batch = titles[start : start + 50]
        payload = client.fetch_json(
            {
                "action": "query",
                "prop": "imageinfo",
                "iiprop": "url|size",
                "titles": "|".join(batch),
                "format": "json",
            }
        )
        for page in payload["query"]["pages"].values():
            title = page["title"]
            info = page.get("imageinfo", [{}])[0]
            metadata.append(
                {
                    "title": title.removeprefix("File:"),
                    "size": int(info.get("size", 0)),
                    "url": info.get("url"),
                }
            )
    metadata.sort(key=lambda item: item["title"].lower())
    return metadata


def download_file(client: CommonsClient, url: str, destination: Path) -> None:
    temp_path = destination.with_name(f"{destination.name}.part")
    with client._open(url) as response, temp_path.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    os.replace(temp_path, destination)


def rebuild_video_index() -> None:
    if not INDEX_SCRIPT.exists():
        print(f"Skipping index rebuild; missing script: {INDEX_SCRIPT}", file=sys.stderr)
        return

    subprocess.run([sys.executable, str(INDEX_SCRIPT)], check=True)


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    client = CommonsClient(
        user_agent=args.user_agent,
        max_retries=args.max_retries,
        metadata_delay_seconds=args.metadata_delay_seconds,
    )

    titles = list_category_files(client)
    files = get_file_metadata(client, titles)
    total = len(files)
    print(f"Found {total} videos in {CATEGORY}.")

    for index, file_info in enumerate(files, start=1):
        destination = output_dir / file_info["title"]
        expected_size = file_info["size"]
        if destination.exists() and destination.stat().st_size == expected_size:
            print(f"[{index}/{total}] skip {destination.name}")
            continue

        if not file_info["url"]:
            print(f"[{index}/{total}] missing download URL for {destination.name}", file=sys.stderr)
            return 1

        print(f"[{index}/{total}] download {destination.name} ({expected_size} bytes)")
        download_file(client, file_info["url"], destination)

        actual_size = destination.stat().st_size
        if actual_size != expected_size:
            print(
                f"[{index}/{total}] size mismatch for {destination.name}: expected {expected_size}, got {actual_size}",
                file=sys.stderr,
            )
            return 1

        time.sleep(args.delay_seconds)

    rebuild_video_index()
    print(f"Rebuilt video index in {output_dir.parent.parent / 'video-index.json'}")
    print("Download complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
