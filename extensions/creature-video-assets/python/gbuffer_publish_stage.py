#!/usr/bin/env python3
# 例外原因: 分页、编码器校验与原子发布是同一套发布协议，拆开会让 staging 约定变成隐式契约。
"""Shared staging, validation and atomic-publish helpers for the Lab G-buffer publishers.

`build_raven_monster_surface_atlas.py` publishes two unrelated assets (raven and the
sand-centipede encounter) through the same steps:

  * validate the `toktx` build the pages will be encoded with
  * lay frames out on fixed-size pages with a gutter
  * write pages into a temporary stage, then swap the stage into the output directory
    atomically, deleting files the previous manifest no longer references

Those steps have nothing to do with either creature, so they live here once. Each target
supplies only its own frame composition and manifest body.

The atomic swap matters: a half-written page directory would be served to the runtime, and
the runtime's own contract is "commit a complete bundle or keep the old frame". Replacing
files one by one in place would violate that, so the manifest is the last thing to move and
stale outputs are removed only after it lands.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

TOKTX_VERSION = "toktx v4.4.2"
KTX2_IDENTIFIER = bytes.fromhex("ab4b5458203230bb0d0a1a0a")
PADDING = 2
PAGE_COLUMNS = 8
FRAMES_PER_PAGE = 32


@dataclass
class AssetSource:
    name: str
    runtime: Path
    source_zip: Path
    remote_job_id: str
    frame_width: int
    frame_height: int


def file_sha(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def bytes_sha(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def validate_toktx(toktx: Path) -> str:
    version = subprocess.check_output(
        [str(toktx), "--version"], text=True, stderr=subprocess.STDOUT
    ).strip()
    if version != TOKTX_VERSION:
        raise ValueError(f"Unsupported encoder {version}; expected {TOKTX_VERSION}")
    return version


def validate_ktx2(path: Path, expected_size: tuple[int, int]) -> None:
    header = path.read_bytes()[:48]
    if header[:12] != KTX2_IDENTIFIER:
        raise ValueError(f"Invalid KTX2 identifier: {path}")
    if struct.unpack_from("<I", header, 12)[0] != 37:
        raise ValueError(f"Relight data must use lossless RGBA8 UNORM: {path}")
    if struct.unpack_from("<II", header, 20) != expected_size:
        raise ValueError(f"KTX2 dimensions changed: {path}")
    if struct.unpack_from("<I", header, 44)[0] != 2:
        raise ValueError(f"Relight data must use Zstd supercompression: {path}")


def page_size(frame_width: int, frame_height: int, count: int) -> tuple[int, int]:
    rows = -(-count // PAGE_COLUMNS)
    columns = PAGE_COLUMNS if rows > 1 else count
    return columns * (frame_width + 2 * PADDING), rows * (frame_height + 2 * PADDING)


def page_layout() -> dict[str, Any]:
    return {
        "framesPerPage": FRAMES_PER_PAGE,
        "columns": PAGE_COLUMNS,
        "gutter": PADDING,
        "orientation": "top-left",
    }


def padded_tile(tile: Image.Image) -> Image.Image:
    pixels = np.asarray(tile.convert("RGBA"))
    padding = ((PADDING, PADDING), (PADDING, PADDING), (0, 0))
    return Image.fromarray(np.pad(pixels, padding, mode="edge"))


def atlas_box(index: int, layout: dict[str, Any]) -> tuple[int, int, int, int]:
    width, height = layout["frameWidth"], layout["frameHeight"]
    x = index % layout["columns"] * width
    y = index // layout["columns"] * height
    return x, y, x + width, y + height


def output_records(stage: Path) -> dict[str, dict[str, Any]]:
    return {
        path.name: {"sha256": file_sha(path), "bytes": path.stat().st_size}
        for path in sorted(stage.iterdir())
        if path.is_file()
    }


def publish_directory(output: Path, stage: Path, manifest: dict[str, Any]) -> None:
    """Swap a fully written stage into `output`, then drop outputs the manifest no longer lists."""
    output.mkdir(parents=True, exist_ok=True)
    old_manifest_path = output / "manifest.json"
    old_outputs: set[str] = set()
    if old_manifest_path.is_file():
        old_outputs = set(json.loads(old_manifest_path.read_text()).get("outputs", {}))
    manifest_path = stage / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    next_manifest = output / "manifest.json.next"
    for path in stage.iterdir():
        if path.is_file() and path.name != "manifest.json":
            os.replace(path, output / path.name)
    shutil.copyfile(manifest_path, next_manifest)
    os.replace(next_manifest, old_manifest_path)
    for stale in old_outputs - set(manifest["outputs"]):
        stale_path = output / Path(stale).name
        if stale_path.parent == output and stale_path.exists():
            stale_path.unlink()
