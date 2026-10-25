#!/usr/bin/env python3
"""Regenerate the extruded brand-letter meshes for the empty-film-set plinth.

The generated Rust module in `bevy/src/model3d/empty_placeholder/text.rs` is compiled directly
into the Bevy crate, so the runtime never performs an asset load for the lettering. Run this
script only when the text, font, type size or extrusion changes:

    python3 scripts/generate-plinth-labels.py

Development dependencies: fonttools, shapely, mapbox_earcut, skia-pathops (and numpy, which
mapbox_earcut uses). The generated mesh is one label-height tall, centred on X/Y, with z from 0
to `DEPTH_RATIO`.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import mapbox_earcut
import numpy as np
import pathops
from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont
from shapely.geometry import Polygon

CLIENT_ROOT = Path(__file__).resolve().parents[1]
FONT = CLIENT_ROOT / "bevy/assets/fonts/NotoSansSC-Regular.otf"
OUT = CLIENT_ROOT / "bevy/src/model3d/empty_placeholder/text.rs"
DEPTH_RATIO = 0.18
CURVE_STEPS = 10


def cubic(p0, p1, p2, p3, t):
    u = 1.0 - t
    return (
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    )


def quadratic(p0, p1, p2, t):
    u = 1.0 - t
    return (
        u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
        u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    )


class FlattenPen(BasePen):
    """Collect flattened glyph contours in font units."""

    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.contours = []
        self.current = []

    def _flush(self):
        if len(self.current) >= 3:
            if self.current[0] != self.current[-1]:
                self.current.append(self.current[0])
            self.contours.append(self.current)
        self.current = []

    def _moveTo(self, point):
        self._flush()
        self.current = [point]

    def _lineTo(self, point):
        self.current.append(point)

    def _curveToOne(self, p1, p2, p3):
        p0 = self.current[-1]
        for i in range(1, CURVE_STEPS + 1):
            self.current.append(cubic(p0, p1, p2, p3, i / CURVE_STEPS))

    def _qCurveToOne(self, p1, p2):
        p0 = self.current[-1]
        for i in range(1, CURVE_STEPS + 1):
            self.current.append(quadratic(p0, p1, p2, i / CURVE_STEPS))

    def _closePath(self):
        self._flush()

    def _endPath(self):
        self._flush()


def glyph_contours(font, glyph_set, char, x_offset):
    cmap = font.getBestCmap()
    name = cmap.get(ord(char))
    if name is None:
        raise SystemExit(f"missing glyph for {char!r}")
    pen = FlattenPen(glyph_set)
    glyph_set[name].draw(pen)
    pen._flush()
    return [[(x + x_offset, y) for x, y in contour] for contour in pen.contours]


def simplify_glyph(contours):
    path = pathops.Path()
    for contour in contours:
        path.moveTo(*contour[0])
        for point in contour[1:]:
            path.lineTo(*point)
        path.close()
    return pathops.simplify(path)


def rings_of(path):
    rings = []
    current = []
    for verb, points in path.segments:
        if verb == "moveTo":
            current = [points[0]]
        elif verb == "lineTo":
            current.append(points[0])
        elif verb == "closePath":
            if len(current) >= 3:
                if current[0] == current[-1]:
                    current.pop()
                rings.append(current)
            current = []
    return rings


def signed_area(points):
    area = 0.0
    for i in range(len(points)):
        x0, y0 = points[i]
        x1, y1 = points[(i + 1) % len(points)]
        area += x0 * y1 - x1 * y0
    return area * 0.5


def group_rings(rings, simplified):
    """Return (outer ring, hole rings) groups.

    Whether a ring is an outer depends on whether the filled region is inside it, which is more
    reliable than font winding order. Holes are attached to the smallest containing outer.
    """
    outers, holes = [], []
    for i, ring in enumerate(rings):
        area = signed_area(ring)
        best = max(
            range(len(ring)),
            key=lambda k: math.hypot(
                ring[(k + 1) % len(ring)][0] - ring[k][0],
                ring[(k + 1) % len(ring)][1] - ring[k][1],
            ),
        )
        p0 = ring[best]
        p1 = ring[(best + 1) % len(ring)]
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        length = math.hypot(dx, dy)
        if length < 1e-6:
            continue
        normal = (-dy / length, dx / length) if area > 0 else (dy / length, -dx / length)
        mid = ((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5)
        eps = max(0.4, length * 0.002)
        sample = (mid[0] + normal[0] * eps, mid[1] + normal[1] * eps)
        (outers if simplified.contains(sample) else holes).append(i)

    groups = []
    for i in outers:
        outer_polygon = Polygon(rings[i])
        group_holes = []
        for hole in holes:
            point = Polygon(rings[hole]).representative_point()
            if not outer_polygon.contains(point):
                continue
            if any(
                Polygon(rings[k]).area < outer_polygon.area
                and Polygon(rings[k]).contains(point)
                for k in outers
            ):
                continue
            group_holes.append(hole)
        groups.append((i, group_holes))
    return groups


def triangulate_group(rings, outer, holes):
    coords = []
    ring_ends = []
    for index in [outer] + holes:
        for x, y in rings[index]:
            coords.extend((x, y))
        ring_ends.append(len(coords) // 2)
    if len(coords) < 6:
        return []
    vertices = np.asarray(coords, dtype=np.float64).reshape(-1, 2)
    ends = np.asarray(ring_ends, dtype=np.uint32)
    triangles = mapbox_earcut.triangulate_float64(vertices, ends)
    result = []
    for i in range(0, len(triangles), 3):
        a, b, c = (int(triangles[i]), int(triangles[i + 1]), int(triangles[i + 2]))
        pa, pb, pc = vertices[a], vertices[b], vertices[c]
        area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
        if area < 0:
            b, c = c, b
        result.append((tuple(pa), tuple(pb), tuple(pc)))
    return result


def build_text(text, tracking_em=0.0):
    font = TTFont(FONT)
    glyph_set = font.getGlyphSet()
    units_per_em = font["head"].unitsPerEm
    hmtx = font["hmtx"]
    cursor = 0.0
    positions = []
    indices = []
    for char in text:
        name = font.getBestCmap().get(ord(char))
        if name is None:
            raise SystemExit(f"missing glyph for {char!r}")
        contours = glyph_contours(font, glyph_set, char, cursor)
        simplified = simplify_glyph(contours)
        rings = rings_of(simplified)
        for outer, holes in group_rings(rings, simplified):
            for a, b, c in triangulate_group(rings, outer, holes):
                # Front cap at z=1 (scaled to DEPTH_RATIO later); reverse for the back cap.
                front = len(positions)
                positions.extend([[a[0], a[1], 1.0], [b[0], b[1], 1.0], [c[0], c[1], 1.0]])
                indices.extend([front, front + 1, front + 2])
                back = len(positions)
                positions.extend([[a[0], a[1], 0.0], [c[0], c[1], 0.0], [b[0], b[1], 0.0]])
                indices.extend([back, back + 1, back + 2])
        for ring in rings:
            for i in range(len(ring)):
                p0 = ring[i]
                p1 = ring[(i + 1) % len(ring)]
                dx, dy = p1[0] - p0[0], p1[1] - p0[1]
                length = math.hypot(dx, dy)
                if length < 1e-6:
                    continue
                normal = (dy / length, -dx / length)
                mid = ((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5)
                eps = max(0.4, length * 0.002)
                sample = (mid[0] + normal[0] * eps, mid[1] + normal[1] * eps)
                flip = simplified.contains(sample)
                quad = [
                    [p0[0], p0[1], 0.0],
                    [p1[0], p1[1], 0.0],
                    [p1[0], p1[1], 1.0],
                    [p0[0], p0[1], 1.0],
                ]
                side_triangles = [(0, 2, 1), (0, 3, 2)] if flip else [(0, 1, 2), (0, 2, 3)]
                base = len(positions)
                positions.extend(quad)
                for a, b, c in side_triangles:
                    indices.extend([base + a, base + b, base + c])
        cursor += hmtx[name][0] + tracking_em * units_per_em
    font.close()

    xs = [point[0] for point in positions]
    ys = [point[1] for point in positions]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    height = max_y - min_y
    if height <= 0:
        raise SystemExit("empty text")
    center_x, center_y = (min_x + max_x) * 0.5, (min_y + max_y) * 0.5
    scale = 1.0 / height
    normalized = [
        [
            round((x - center_x) * scale, 5),
            round((y - center_y) * scale, 5),
            round(z * DEPTH_RATIO, 5),
        ]
        for x, y, z in positions
    ]
    return {
        "positions": normalized,
        "indices": indices,
        "width": round((max_x - min_x) * scale, 5),
        "height": 1.0,
        "depth": DEPTH_RATIO,
        "triangles": len(indices) // 3,
    }


def rust_const(name, json_text):
    chunks = [json_text[i : i + 2000] for i in range(0, len(json_text), 2000)]
    assert all('"#' not in chunk for chunk in chunks)
    lines = [f"pub(crate) const {name}: &str = concat!("]
    lines.extend(f'    r#"{chunk}"#,' for chunk in chunks)
    lines.append(");")
    return lines


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    meshes = []
    for name, text, tracking in [
        ("WOOHAA3_JSON", "WOOHAA3", 0.03),
        ("PIANCHANG_JSON", "片场", 0.0),
    ]:
        data = build_text(text, tracking)
        encoded = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        meshes.extend(rust_const(name, encoded))
        print(
            name,
            "width",
            data["width"],
            "depth",
            data["depth"],
            "verts",
            len(data["positions"]),
            "tris",
            data["triangles"],
        )
    header = [
        "// @generated by client/scripts/generate-plinth-labels.py; do not edit.",
        "// Extruded glyph meshes for the empty film set plinth; parsed once by empty_placeholder.rs.",
        "",
    ]
    OUT.write_text("\n".join(header + meshes) + "\n")
    print("wrote", OUT, "bytes", OUT.stat().st_size)


if __name__ == "__main__":
    main()
