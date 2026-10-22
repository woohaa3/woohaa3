#!/usr/bin/env python3
"""Pure pixel operations for the character Normal + DeLit companion atlas."""

from __future__ import annotations

import math
from array import array
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass

from PIL import Image


DE_LIT_LIMIT = 0.7
DE_LIT_EPSILON = 0.02
_SRGB_TO_LINEAR = tuple(
    value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4
    for value in (byte / 255 for byte in range(256))
)


@dataclass(frozen=True)
class SurfaceTile:
    image: Image.Image
    offset_x: int
    offset_y: int
    logical_width: int
    logical_height: int
    depth: Image.Image | None = None


def resize_original(image: Image.Image, width: int, height: int) -> Image.Image:
    """Resize straight RGBA through premultiplied pixels to protect edge color."""
    return (
        image.convert('RGBA')
        .convert('RGBa')
        .resize((width, height), Image.Resampling.LANCZOS)
        .convert('RGBA')
    )


def encode_camera_space_normal(image: Image.Image) -> bytearray:
    """Normalize raw predicted camera-space XYZ and encode it as RGB UNORM."""
    pixels = bytearray(image.convert('RGB').tobytes())
    for offset in range(0, len(pixels), 3):
        vector = [pixels[offset + axis] / 255 * 2 - 1 for axis in range(3)]
        length = math.sqrt(sum(component * component for component in vector))
        if length < 1e-5:
            vector = [0.0, 0.0, 1.0]
            length = 1.0
        for axis in range(3):
            encoded = (vector[axis] / length * 0.5 + 0.5) * 255
            pixels[offset + axis] = max(0, min(255, int(encoded + 0.5)))
    return pixels


def bleed_rgb(rgb: bytearray, alpha: bytes, width: int, height: int, radius: int) -> None:
    """Copy nearest visible RGB into a small transparent gutter without changing alpha."""
    if radius <= 0:
        return
    unseen = 255
    distance = bytearray([unseen]) * (width * height)
    queue: deque[int] = deque()
    for pixel, value in enumerate(alpha):
        if value:
            distance[pixel] = 0
            queue.append(pixel)
    neighbors = ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0),
                 (-1, 1), (0, 1), (1, 1))
    while queue:
        pixel = queue.popleft()
        current_distance = distance[pixel]
        if current_distance >= radius:
            continue
        x, y = pixel % width, pixel // width
        for delta_x, delta_y in neighbors:
            next_x, next_y = x + delta_x, y + delta_y
            if not (0 <= next_x < width and 0 <= next_y < height):
                continue
            next_pixel = next_y * width + next_x
            if distance[next_pixel] != unseen:
                continue
            source_offset, target_offset = pixel * 3, next_pixel * 3
            rgb[target_offset:target_offset + 3] = rgb[source_offset:source_offset + 3]
            distance[next_pixel] = current_distance + 1
            queue.append(next_pixel)


def _box_blur_pass(
    source: Sequence[float], width: int, height: int, radius: int, horizontal: bool,
) -> array:
    target = array('f', [0.0]) * len(source)
    outer_length, inner_length = (height, width) if horizontal else (width, height)
    window_size = radius * 2 + 1

    def pixel_index(outer: int, inner: int) -> int:
        return outer * width + inner if horizontal else inner * width + outer

    for outer in range(outer_length):
        total = sum(
            source[pixel_index(outer, max(0, min(inner_length - 1, offset)))]
            for offset in range(-radius, radius + 1)
        )
        for inner in range(inner_length):
            target[pixel_index(outer, inner)] = total / window_size
            remove = max(0, min(inner_length - 1, inner - radius))
            add = max(0, min(inner_length - 1, inner + radius + 1))
            total += source[pixel_index(outer, add)] - source[pixel_index(outer, remove)]
    return target


def _alpha_aware_low_pass(
    values: array, alpha: bytes, width: int, height: int, radius: float,
) -> array:
    pass_radius = max(1, round(max(0.0, min(128.0, radius)) / math.sqrt(3)))
    weights = array('f', (value / 255 for value in alpha))
    weighted = array('f', (value * weight for value, weight in zip(values, weights)))
    for _ in range(3):
        weighted = _box_blur_pass(weighted, width, height, pass_radius, True)
        weighted = _box_blur_pass(weighted, width, height, pass_radius, False)
        weights = _box_blur_pass(weights, width, height, pass_radius, True)
        weights = _box_blur_pass(weights, width, height, pass_radius, False)
    return array('f', (
        value / weight if weight > 1e-7 else 0.0
        for value, weight in zip(weighted, weights)
    ))


def _weighted_median(values: Sequence[float], alpha: bytes) -> float:
    visible = [(value, weight / 255) for value, weight in zip(values, alpha) if weight]
    if not visible:
        return 0.0
    minimum = min(value for value, _ in visible)
    maximum = max(value for value, _ in visible)
    if maximum <= minimum:
        return minimum
    weights = [0.0] * 4096
    weighted_values = [0.0] * 4096
    scale = 4095 / (maximum - minimum)
    for value, weight in visible:
        bin_index = min(4095, int((value - minimum) * scale))
        weights[bin_index] += weight
        weighted_values[bin_index] += value * weight
    midpoint, accumulated = sum(weights) * 0.5, 0.0
    for weight, weighted_value in zip(weights, weighted_values):
        accumulated += weight
        if accumulated >= midpoint and weight > 0:
            return weighted_value / weight
    return maximum


def create_de_lit(
    original: Image.Image,
    base_color: Image.Image,
    alpha: bytes,
    blur_radius: float,
) -> bytes:
    original_rgb = original.convert('RGB').tobytes()
    base_rgb = base_color.convert('RGB').tobytes()
    raw = array('f', [0.0]) * len(alpha)
    for pixel, alpha_byte in enumerate(alpha):
        if not alpha_byte:
            continue
        offset = pixel * 3
        original_luma = sum(
            _SRGB_TO_LINEAR[original_rgb[offset + axis]] * weight
            for axis, weight in enumerate((0.2126, 0.7152, 0.0722))
        )
        base_luma = sum(
            _SRGB_TO_LINEAR[base_rgb[offset + axis]] * weight
            for axis, weight in enumerate((0.2126, 0.7152, 0.0722))
        )
        raw[pixel] = math.log(original_luma + DE_LIT_EPSILON) - math.log(
            base_luma + DE_LIT_EPSILON
        )
    low_pass = _alpha_aware_low_pass(raw, alpha, original.width, original.height, blur_radius)
    median = _weighted_median(low_pass, alpha)
    encoded = bytearray([128]) * len(alpha)
    for pixel, alpha_byte in enumerate(alpha):
        if not alpha_byte:
            continue
        centered = max(-DE_LIT_LIMIT, min(DE_LIT_LIMIT, low_pass[pixel] - median))
        encoded[pixel] = int((centered + DE_LIT_LIMIT) / (DE_LIT_LIMIT * 2) * 255 + 0.5)
    return bytes(encoded)


def build_surface_tile(
    original: Image.Image,
    base_color: Image.Image,
    normal: Image.Image,
    target_height: int,
    crop_margin: int,
) -> SurfaceTile:
    logical_width = max(1, round(original.width * target_height / original.height))
    size = (logical_width, target_height)
    resized_original = resize_original(original, *size)
    resized_base = base_color.convert('RGB').resize(size, Image.Resampling.LANCZOS)
    resized_normal = normal.convert('RGB').resize(size, Image.Resampling.LANCZOS)
    alpha_image = resized_original.getchannel('A')
    bounds = alpha_image.getbbox()
    if bounds is None:
        raise ValueError('Original frame has no visible alpha')
    alpha = alpha_image.tobytes()
    normal_rgb = encode_camera_space_normal(resized_normal)
    for pixel, alpha_byte in enumerate(alpha):
        if not alpha_byte:
            offset = pixel * 3
            normal_rgb[offset:offset + 3] = bytes((128, 128, 255))
    bleed_rgb(normal_rgb, alpha, *size, max(1, round(4 * target_height / original.height)))
    de_lit = create_de_lit(
        resized_original,
        resized_base,
        alpha,
        32 * target_height / original.height,
    )
    packed = bytearray(logical_width * target_height * 4)
    for pixel, de_lit_byte in enumerate(de_lit):
        source_offset, target_offset = pixel * 3, pixel * 4
        packed[target_offset:target_offset + 3] = normal_rgb[source_offset:source_offset + 3]
        packed[target_offset + 3] = de_lit_byte
    left = max(0, bounds[0] - crop_margin)
    top = max(0, bounds[1] - crop_margin)
    right = min(logical_width, bounds[2] + crop_margin)
    bottom = min(target_height, bounds[3] + crop_margin)
    image = Image.frombytes('RGBA', size, bytes(packed)).crop((left, top, right, bottom))
    return SurfaceTile(image, left, top, logical_width, target_height)
