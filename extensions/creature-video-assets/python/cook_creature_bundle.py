"""Creature-only multi-layer cooker. Inputs are materialized stable Media checkpoints.

Pixel/encoder contracts come from character_surface_pixels and gbuffer_publish_stage;
there is no game target registry, RunStore, approval shell or source-project dependency.
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image
from character_surface_pixels import build_surface_tile
from gbuffer_publish_stage import padded_tile, validate_toktx, validate_ktx2, file_sha

LAYERS = ('body', 'surface', 'material', 'mask', 'shadow', 'baseColor')
GUTTER = 2


def inside(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('Unsafe/missing input')
    return path


def main():
    root, spec_path, destination, toktx = map(Path, sys.argv[1:5])
    version = validate_toktx(toktx)
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {'schema': 'creature-relight.v1', 'fps': 24, 'streams': [],
                'actions': spec['actions'], 'transitions': spec['transitions'],
                'initialStateId': spec['initialStateId'], 'directionPlan': spec['directionPlan'],
                'encoder': version, 'deLitRange': [-.7, .7], 'files': {}}
    for stream_index, stream in enumerate(spec['streams']):
        pages, records = {layer: [] for layer in LAYERS}, []
        for source_frame, frame in enumerate(stream['frames']):
            original = Image.open(inside(root, frame['body'])).convert('RGBA')
            height = min(384, original.height)
            width = max(1, round(original.width * height / original.height))
            size = width, height
            body = original.convert('RGBa').resize(size, Image.Resampling.LANCZOS).convert('RGBA')
            if not body.getchannel('A').getbbox():
                raise ValueError('Empty alpha')
            channels = {name: Image.open(inside(root, frame[name])).resize(original.size, Image.Resampling.LANCZOS)
                        for name in ('normal', 'basecolor', 'roughness', 'metallic', 'depth')}
            tile = build_surface_tile(original, channels['basecolor'], channels['normal'], height, max(width, height))
            if tile.image.size != size or tile.offset_x or tile.offset_y:
                raise ValueError('Surface spatial transform differs from Body')
            depth = channels['depth'].convert('L').resize(size)
            roughness = channels['roughness'].convert('L').resize(size)
            metallic = channels['metallic'].convert('L').resize(size)
            alpha = body.getchannel('A')
            material = Image.merge('RGBA', (depth, roughness, metallic, alpha))
            mask = Image.merge('RGBA', (alpha, alpha, alpha, alpha))
            shadow = Image.merge('RGBA', (depth, depth, depth, alpha))
            base = channels['basecolor'].convert('RGB').resize(size).convert('RGBA')
            base.putalpha(alpha)
            images = dict(body=body, surface=tile.image, material=material, mask=mask,
                          shadow=shadow, baseColor=base)
            # All layers share one rectangle and one source frame. No independent packing.
            columns = max(1, min(4, 2048 // (width + GUTTER * 2)))
            rows = max(1, min(4, 2048 // (height + GUTTER * 2)))
            capacity = columns * rows
            page_index, slot = divmod(source_frame, capacity)
            x, y = (slot % columns) * (width + 4), (slot // columns) * (height + 4)
            for layer in LAYERS:
                if page_index == len(pages[layer]):
                    pages[layer].append(Image.new('RGBA', (columns * (width + 4), rows * (height + 4))))
                pages[layer][page_index].paste(padded_tile(images[layer]), (x, y))
            records.append({'sourceFrame': source_frame, 'rgbSourceFrame': frame['rgbSourceFrame'],
                            'page': page_index, 'rect': [x + 2, y + 2, width, height],
                            'size': [width, height]})
        encoded = []
        for page_index in range(len(pages['body'])):
            page_record = {}
            for layer in LAYERS:
                stem = f'{stream_index}-{page_index}-{layer}'
                png = destination / f'{stem}.png'
                ktx = destination / f'{stem}.ktx2'
                pages[layer][page_index].save(png, compress_level=9)
                subprocess.run([str(toktx), '--threads', '2', '--t2', '--zcmp', '10',
                                '--assign_oetf', 'linear', str(ktx), str(png)],
                               check=True, stdout=subprocess.DEVNULL)
                validate_ktx2(ktx, pages[layer][page_index].size)
                page_record[layer] = {'png': png.name, 'ktx2': ktx.name,
                                      'size': list(pages[layer][page_index].size)}
                for path in (png, ktx):
                    manifest['files'][path.name] = {'sha256': file_sha(path), 'size': path.stat().st_size}
            encoded.append(page_record)
        manifest['streams'].append({k: stream[k] for k in ('key', 'directionId', 'actionId', 'connectorFor')}
                                  | {'frames': records, 'pages': encoded})
    (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    main()
