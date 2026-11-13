#!/usr/bin/env python3
"""Offline SOMA-X/Anny export. No application, service or private-repo imports."""
import argparse
import base64
import hashlib
import itertools
import importlib.metadata
import json
import pathlib

import numpy as np
import torch
import trimesh
from scipy.spatial.transform import Rotation
from soma import SOMALayer
from anny.models.phenotype import PHENOTYPE_VARIATIONS

VERSION = 'soma-body-v1'
GENERATOR = 'soma-body-generator-v1'
SOMA_COMMIT = '01ab5b5c0876058bd27d34b1607d74b2e55e0cf4'
# SOMA mid topology, external midsagittal underside of chin, not a joint.
CHIN = 16
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'web/contracts/src/canvas/soma-humanoid'
PUBLIC = ROOT / 'web/frontend/public/soma/body-v1'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def packed(a, dtype):
    return base64.b64encode(np.asarray(a, dtype=dtype).tobytes()).decode('ascii')


def section(mesh, height):
    cut = mesh.section(plane_origin=[0, height, 0], plane_normal=[0, 1, 0])
    if cut is None:
        raise ValueError('Missing torso section')
    paths = [p for p in cut.discrete if np.linalg.norm(p[0]-p[-1]) < 1e-4]
    # Arms form separate loops; use the contour nearest the midsagittal plane.
    p = min(paths, key=lambda p: abs(np.mean(p[:, 0])))
    return float(np.linalg.norm(np.diff(p, axis=0), axis=1).sum()), float(np.ptp(p[:, 2]))


def fit(layer, vertices):
    rest = torch.from_numpy(vertices.astype('float32'))[None]
    bind = layer.skeleton_transfer.fit(rest)
    layer.batched_skinning.rebind(bind, rest)
    v, b = layer.batched_skinning.pose(
        local_rotations=layer.bind_pose_local[..., :3, :3],
        global_translation=layer.bind_pose_local[..., 1, :3, 3],
        align_translation=torch.tensor([0., 0., 0.]),
        return_transforms=True, absolute_pose=True)
    return v[0].numpy().copy(), b[0].numpy().copy()


def normalize(v, b, height=1.7):
    bottom = float(v[:, 1].min())
    scale = height / float(np.ptp(v[:, 1]))
    v[:, 1] -= bottom
    b[1:, 1, 3] -= bottom
    v *= scale
    b[1:, :3, 3] *= scale
    return v, b


def calibrate(layer, source, target, head_ids):
    chin = source[CHIN].copy()
    lo, hi = .4, 1.6
    for _ in range(22):
        factor = (lo + hi) / 2
        v = source.copy()
        # Continuous head/neck deformation; torso and limbs keep Anny's shape.
        blend = np.clip((v[:, 1] - chin[1] + .07) / .08, 0, 1)
        blend = blend * blend * (3 - 2 * blend)
        v[:, [0, 2]] = chin[[0, 2]] + (v[:, [0, 2]] - chin[[0, 2]]) * (1 + (factor-1)*blend[:, None])
        v[:, 1] += (factor-1) * np.maximum(v[:, 1] - chin[1], 0)
        v, b = normalize(*fit(layer, v))
        ratio = float(np.ptp(v[:, 1]) / (v[head_ids, 1].max()-v[CHIN, 1]))
        if ratio > target:
            lo = factor
        else:
            hi = factor
    if abs(ratio-target) > .05:
        raise ValueError(f'Head ratio calibration failed: {target}: {ratio}')
    return v.astype('<f4'), b.astype('<f4'), factor, ratio


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', type=pathlib.Path, required=True, help='assets/ from frozen SOMA-X checkout')
    parser.add_argument('--staging', type=pathlib.Path, help='write inspectable NPZ exports outside the source tree')
    args = parser.parse_args()
    assert importlib.metadata.version('py-soma-x') == '0.3.6'
    assert importlib.metadata.version('anny') == '0.2.0'
    assert PHENOTYPE_VARIATIONS['gender'] == ['male', 'female'], 'Anny gender anchors changed'
    sources = json.loads(pathlib.Path(__file__).with_name('sources.json').read_text())
    for name, expected in sources.items():
        if digest((args.assets/name).read_bytes()) != expected:
            raise ValueError(f'Wrong frozen source asset: {name}')
    torch.manual_seed(0)
    torch.set_num_threads(4)
    layer = SOMALayer(data_root=args.assets, identity_model_type='anny', device='cpu', mode='torch',
                      enable_procedural_transforms=False, correctives_model_path=None)
    rig = layer.rig_data
    faces = rig['triangles'].astype('<u4')
    names = [str(n) for n in rig['joint_names'][1:]]
    parents = rig['joint_parent_ids'][1:].astype(int)-1
    dense = layer.skinning_weights.numpy()[:, 1:]
    assert not layer.skinning_weights.numpy()[:, 0].any(), 'Virtual Root has nonzero skin influence'
    width = int((dense > 0).sum(1).max())
    indices = np.argsort(-dense, axis=1, kind='stable')[:, :width].astype('<u4')
    weights = np.take_along_axis(dense, indices, axis=1).astype('<f4')
    assert np.allclose(weights.sum(1), 1, atol=1e-5)
    excluded = np.unique(np.concatenate([rig[k] for k in ['segment_hair','segment_haircap','segment_eye_bags','segment_mouth_bag']]))
    head_ids = np.setdiff1d(rig['segment_head'], excluded).astype(int)
    assert CHIN not in excluded
    shared = dict(faces=packed(faces, '<u4'), indices=packed(indices, '<u4'), weights=packed(weights, '<f4'), influenceCount=width)
    entries = []
    payload = {}
    choices = [(f'{sex}-{heads}-{build}', sex, heads, build, None, 1.7, .5)
               for sex, heads, build in itertools.product(['male', 'female'], [7, 8, 9, 10], ['slim', 'fat'])]
    choices += [('baby', 'neutral', None, None, 'baby', .70, 0.)]
    choices += [(f'{sex}-{age}', sex, None, None, age, height, age_parameter)
                for age, height, age_parameter in [('child', 1.15, 1/3), ('teen', 1.50, .5)]
                for sex in ['male', 'female']]
    for key, sex, heads, build, age_group, height, age_parameter in choices:
        gender = .5 if sex == 'neutral' else float(PHENOTYPE_VARIATIONS['gender'].index(sex))
        parameters = [gender, age_parameter, .5, .15 if build == 'slim' else .95 if build == 'fat' else .5, .5, .5]
        with torch.no_grad():
            local_changes = {'measure-waist-circ-incr': .45} if build == 'fat' else {}
            scales = torch.zeros(1, len(layer.identity_model.scale_param_names))
            for name, value in local_changes.items():
                scales[0, layer.identity_model.scale_param_names.index(name)] = value
            layer.prepare_identity(torch.tensor([parameters]), scale_params=scales)
            source = layer._cached_rest_shape[0].numpy().copy()
            if heads is not None:
                vertices, binds, factor, ratio = calibrate(layer, source, heads, head_ids)
            else:
                vertices, binds = normalize(*fit(layer, source), height=height)
                vertices, binds = vertices.astype('<f4'), binds.astype('<f4')
                factor = 1.
                ratio = float(np.ptp(vertices[:, 1]) / (vertices[head_ids, 1].max()-vertices[CHIN, 1]))
        binds = binds[1:]
        local = binds.copy()
        for i, parent in enumerate(parents):
            if parent >= 0:
                local[i] = np.linalg.inv(binds[parent]) @ binds[i]
        joints = [dict(name=name, parent=int(parents[i]), position=local[i,:3,3].tolist(),
                       rotation=Rotation.from_matrix(local[i,:3,:3]).as_euler('YXZ', degrees=True)[[1,0,2]].tolist(),
                       bind=binds[i].tolist()) for i,name in enumerate(names)]
        inverse = np.linalg.inv(binds).transpose(0,2,1).reshape(77,16).astype('<f4')
        arrays = [vertices, binds, inverse, weights]
        assert all(np.isfinite(a).all() for a in arrays)
        geometry = b''.join(a.tobytes() for a in [vertices, binds, inverse, faces, indices, weights])
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
        by_name = dict(zip(names, binds))
        hips = float(by_name['Hips'][1,3]); chest = float(by_name['Chest'][1,3]); neck = float(by_name['Neck1'][1,3])
        waist, depth = section(mesh, hips + (chest-hips)*.3)
        chest_girth, _ = section(mesh, chest+(neck-chest)*.65)
        hip_girth, _ = section(mesh, hips-.02)
        measurements = dict(height=float(np.ptp(vertices[:,1])), soleHeight=float(vertices[:,1].min()),
            headHeight=float(vertices[head_ids,1].max()-vertices[CHIN,1]), headRatio=ratio,
            chest=chest_girth, waist=waist, hips=hip_girth, bodyDepth=depth)
        assert abs(measurements['height']-height)<.001 and abs(measurements['soleHeight'])<1e-6
        entry = dict(id=f'{VERSION}/{key}', sex=sex, heads=heads, build=build, sha256=digest(geometry),
            skeletonSha256=digest(binds.tobytes()), parameters=dict(zip(['gender','age','muscle','weight','height','proportions'],parameters)),
            localChanges=local_changes, headScale=factor, measurements=measurements)
        if age_group:
            entry['ageGroup'] = age_group
        entries.append(entry)
        payload[key] = dict(vertices=packed(vertices,'<f4'), inverseBindMatrices=packed(inverse,'<f4'), joints=joints)
        if args.staging:
            args.staging.mkdir(parents=True, exist_ok=True)
            np.savez(args.staging/f'{key}.npz',vertices=vertices,binds=binds,faces=faces,indices=indices,weights=weights)
        print(key, json.dumps(measurements), flush=True)
    for sex, heads in itertools.product(['male','female'], [7,8,9,10]):
        pair = [e for e in entries if e['sex']==sex and e['heads']==heads]
        assert pair[1]['measurements']['waist'] >= pair[0]['measurements']['waist']*1.15, 'Insufficient waist distinction'
    assert len(entries)==21 and len({e['sha256'] for e in entries})==21
    asset_hashes = {str(p.relative_to(args.assets)):digest(p.read_bytes()) for p in [args.assets/'SOMA_neutral.npz',args.assets/'SOMA_template_rig.usda',args.assets/'Anny/base_body.obj',args.assets/'Anny/SOMA_wrap.obj']}
    manifest = dict(version=VERSION,generator=GENERATOR,somaCommit=SOMA_COMMIT,annyVersion='0.2.0',seed=0,
        measurement=dict(chinVertex=CHIN,headSurfaceVertices=head_ids.tolist(),exclusions=excluded.tolist(),girth='closed horizontal torso surface contour'),
        sourceAssets=asset_hashes,vertexCount=len(vertices),triangleCount=len(faces),influenceCount=width,entries=entries)
    output = '// Generated by client/scripts/soma-body-presets/generate.py; do not edit.\n'
    output += 'export const SOMA_BODY_PACKED = '+json.dumps(dict(shared=shared,bodies=payload), separators=(',',':'))+';\n'
    manifest_text = json.dumps(manifest,indent=2)+'\n'
    # Append-only catalog: every previously published entry and shared measurement contract stays immutable.
    previous = PUBLIC/'manifest.json'
    if previous.exists():
        old = json.loads(previous.read_text())
        current_by_id = {entry['id']: entry for entry in entries}
        if any(current_by_id.get(entry['id']) != entry for entry in old['entries']) or any(
                old[key] != manifest[key] for key in old if key != 'entries'):
            raise ValueError('Published entries are immutable; use a new version for changed geometry or metadata')
    PUBLIC.mkdir(parents=True,exist_ok=True)
    (OUT/'body-data.ts').write_text(output)
    (PUBLIC/'manifest.json').write_text(manifest_text)
    (OUT/'body-manifest.ts').write_text('// Generated; do not edit.\nexport const SOMA_BODY_MANIFEST = '+json.dumps(manifest,separators=(',',':'))+' as const;\n')
    print('packed bytes',len(output.encode()),'per-instance float32 position/normal bytes',len(vertices)*3*4*2)


if __name__ == '__main__':
    main()
