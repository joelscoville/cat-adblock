#!/usr/bin/env python3

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


VIDEO_ROOT = Path("assets/videos")
INDEX_PATH = Path("assets/video-index.json")


def read_vint(data: bytes, offset: int) -> tuple[int, int]:
    first = data[offset]
    mask = 0x80
    length = 1
    while length <= 8 and not (first & mask):
        mask >>= 1
        length += 1

    if length > 8:
        raise ValueError(f"Invalid VINT at byte offset {offset}")

    value = first & (mask - 1)
    for index in range(1, length):
        value = (value << 8) | data[offset + index]

    return value, length


def read_element_id(data: bytes, offset: int) -> tuple[int, int]:
    first = data[offset]
    mask = 0x80
    length = 1
    while length <= 4 and not (first & mask):
        mask >>= 1
        length += 1

    if length > 4:
        raise ValueError(f"Invalid element ID at byte offset {offset}")

    value = 0
    for index in range(length):
        value = (value << 8) | data[offset + index]

    return value, length


def read_size_vint(data: bytes, offset: int) -> tuple[Optional[int], int]:
    value, length = read_vint(data, offset)
    max_value = (1 << (7 * length)) - 1
    if value == max_value:
        return None, length
    return value, length


def iter_elements(data: bytes, start: int = 0, end: Optional[int] = None):
    limit = len(data) if end is None else min(end, len(data))
    offset = start

    while offset < limit:
        element_id, id_length = read_element_id(data, offset)
        offset += id_length
        size, size_length = read_size_vint(data, offset)
        offset += size_length
        payload_start = offset
        payload_end = limit if size is None else payload_start + size

        if payload_end > len(data):
            raise ValueError("Element payload extends past file boundary")

        yield element_id, payload_start, payload_end
        offset = payload_end


def find_child(data: bytes, parent_start: int, parent_end: int, target_id: int):
    for element_id, payload_start, payload_end in iter_elements(data, parent_start, parent_end):
        if element_id == target_id:
            return payload_start, payload_end

    return None


def decode_uint(data: bytes, start: int, end: int) -> int:
    value = 0
    for byte in data[start:end]:
        value = (value << 8) | byte
    return value


@dataclass(frozen=True)
class VideoMetadata:
    width: int
    height: int


def probe_webm_dimensions(path: Path) -> VideoMetadata:
    data = path.read_bytes()
    segment = find_child(data, 0, len(data), 0x18538067)
    if segment is None:
        raise ValueError("Missing Segment element")

    tracks = find_child(data, segment[0], segment[1], 0x1654AE6B)
    if tracks is None:
        raise ValueError("Missing Tracks element")

    for element_id, entry_start, entry_end in iter_elements(data, tracks[0], tracks[1]):
        if element_id != 0xAE:
            continue

        track_type_element = find_child(data, entry_start, entry_end, 0x83)
        if track_type_element is None:
            continue

        track_type = decode_uint(data, track_type_element[0], track_type_element[1])
        if track_type != 1:
            continue

        video = find_child(data, entry_start, entry_end, 0xE0)
        if video is None:
            continue

        width_element = find_child(data, video[0], video[1], 0xB0)
        height_element = find_child(data, video[0], video[1], 0xBA)
        if width_element is None or height_element is None:
            continue

        width = decode_uint(data, width_element[0], width_element[1])
        height = decode_uint(data, height_element[0], height_element[1])
        if width <= 0 or height <= 0:
            raise ValueError("Invalid video dimensions")

        return VideoMetadata(width=width, height=height)

    raise ValueError("No video track with dimensions found")


def format_category_label(category_id: str) -> str:
    return " ".join(part.capitalize() for part in category_id.replace("_", "-").split("-") if part)


def generate_index(video_root: Path) -> dict:
    categories: list[dict] = []
    for category_dir in sorted(path for path in video_root.iterdir() if path.is_dir()):
        videos: list[dict] = []
        for video_path in sorted(category_dir.glob("*.webm"), key=lambda path: path.name.lower()):
            metadata = probe_webm_dimensions(video_path)
            aspect_ratio = round(metadata.width / metadata.height, 4)
            videos.append(
                {
                    "filename": video_path.name,
                    "path": video_path.as_posix(),
                    "width": metadata.width,
                    "height": metadata.height,
                    "aspectRatio": aspect_ratio,
                }
            )

        categories.append(
            {
                "id": category_dir.name,
                "label": format_category_label(category_dir.name),
                "videos": videos,
            }
        )

    return {"categories": categories}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the local video index for Cat Adblocker.")
    parser.add_argument(
        "--video-root",
        default=str(VIDEO_ROOT),
        help=f"Root directory containing category folders. Default: {VIDEO_ROOT}",
    )
    parser.add_argument(
        "--output",
        default=str(INDEX_PATH),
        help=f"Output path for the generated index JSON. Default: {INDEX_PATH}",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    video_root = Path(args.video_root)
    output_path = Path(args.output)

    if not video_root.exists():
        raise SystemExit(f"Video root not found: {video_root}")

    index = generate_index(video_root)
    output_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote video index to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
