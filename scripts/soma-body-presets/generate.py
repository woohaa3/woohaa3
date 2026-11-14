#!/usr/bin/env python3
"""Offline SOMA-X/Anny export. No application, service or private-repo imports."""
import argparse
import base64
import hashlib
import importlib.metadata
import json
import pathlib

import numpy as np
import torch
import trimesh
from scipy.spatial.transform import Rotation
from soma import SOMALayer
from anny.models.phenotype import PHENOTYPE_VARIATIONS

VERSION = 'soma-body-v2'
GENERATOR = 'soma-body-generator-v3'
SOMA_COMMIT = '01ab5b5c0876058bd27d34b1607d74b2e55e0cf4'
# SOMA mid topology, external midsagittal underside of chin, not a joint.
CHIN = 16
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'web/contracts/src/canvas/soma-humanoid'
PUBLIC = ROOT / 'web/frontend/public/soma/body-v2'
DATA_OUT = OUT / 'body-data-v2.ts'
MANIFEST_OUT = OUT / 'body-manifest-v2.ts'


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



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', type=pathlib.Path, required=True, help='assets/ from frozen SOMA-X checkout')
    parser.add_argument('--staging', type=pathlib.Path, help='write inspectable NPZ exports outside the source tree')
    args = parser.parse_args()
    assert importlib.metadata.version('py-soma-x') == '0.3.6'
    assert importlib.metadata.version('anny') == '0.2.0'
    assert PHENOTYPE_VARIATIONS == {
        'race': ['african', 'asian', 'caucasian'],
        'gender': ['male', 'female'],
        'age': ['newborn', 'baby', 'child', 'young', 'old'],
        'muscle': ['minmuscle', 'averagemuscle', 'maxmuscle'],
        'weight': ['minweight', 'averageweight', 'maxweight'],
        'height': ['minheight', 'maxheight'],
        'proportions': ['idealproportions', 'uncommonproportions'],
        'cupsize': ['mincup', 'averagecup', 'maxcup'],
        'firmness': ['minfirmness', 'averagefirmness', 'maxfirmness'],
    }, 'Anny phenotype anchors changed'
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
    # Measure the visible head from the same skinned mesh that the renderer
    # displays. A vertex belongs to the head marker when Head/Jaw together
    # carry at least half of its skin influence; the chin remains the fixed
    # SOMA topology marker below. This is diagnostic metadata only: v2 never
    # changes the mesh to force a target head ratio.
    head_joint_indices = np.asarray([names.index('Head'), names.index('Jaw')], dtype=int)
    head_influence_threshold = .5
    head_influence = dense[:, head_joint_indices].sum(axis=1)
    head_ids = np.setdiff1d(np.flatnonzero(head_influence >= head_influence_threshold), [CHIN]).astype(int)
    assert len(head_ids) > 4000
    shared = dict(faces=packed(faces, '<u4'), indices=packed(indices, '<u4'), weights=packed(weights, '<f4'), influenceCount=width)
    entries = []
    payload = {}
    # The quick picker deliberately exposes only Anny's stable age and gender
    # dimensions. Weight and muscle stay at their official average anchors
    # until a dedicated advanced control exists; no body warp or waist patch is
    # applied after Anny evaluates the phenotype.
    choices = [(sex, sex, None, 'adult', 1.70, 2/3, .5, .5)
               for sex in ['male', 'female']]
    choices += [(f'{sex}-{age}', sex, None, age, height, age_parameter, .5, .5)
                for age, height, age_parameter in [('newborn', .52, -1/3), ('child', 1.15, 1/3), ('old', 1.68, 1.)]
                for sex in ['male', 'female']]
    for key, sex, build, age_group, height, age_parameter, muscle, weight in choices:
        gender = .5 if sex == 'neutral' else float(PHENOTYPE_VARIATIONS['gender'].index(sex))
        parameters = [gender, age_parameter, muscle, weight, .5, 0.]
        with torch.no_grad():
            scales = torch.zeros(1, len(layer.identity_model.scale_param_names))
            layer.prepare_identity(torch.tensor([parameters]), scale_params=scales)
            source = layer._cached_rest_shape[0].numpy().copy()
            vertices, binds = normalize(*fit(layer, source), height=height)
            vertices, binds = vertices.astype('<f4'), binds.astype('<f4')
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
        entry = dict(id=f'{VERSION}/{key}', sex=sex, heads=None, build=build, sha256=digest(geometry),
            skeletonSha256=digest(binds.tobytes()), parameters=dict(zip(['gender','age','muscle','weight','height','proportions'],parameters)),
            localChanges={}, headScale=1.,
            measurements=measurements)
        entry['ageGroup'] = age_group
        entries.append(entry)
        payload[key] = dict(vertices=packed(vertices,'<f4'), inverseBindMatrices=packed(inverse,'<f4'), joints=joints)
        if args.staging:
            args.staging.mkdir(parents=True, exist_ok=True)
            np.savez(args.staging/f'{key}.npz',vertices=vertices,binds=binds,faces=faces,indices=indices,weights=weights)
        print(key, json.dumps(measurements), flush=True)
    assert len(entries)==8 and len({e['sha256'] for e in entries})==8
    asset_hashes = {str(p.relative_to(args.assets)):digest(p.read_bytes()) for p in [args.assets/'SOMA_neutral.npz',args.assets/'SOMA_template_rig.usda',args.assets/'Anny/base_body.obj',args.assets/'Anny/SOMA_wrap.obj']}
    manifest = dict(version=VERSION,generator=GENERATOR,somaCommit=SOMA_COMMIT,annyVersion='0.2.0',seed=0,
        measurement=dict(chinVertex=CHIN, headSurfaceVertices=head_ids.tolist(),
                         headSkinJoints=[str(names[i]) for i in head_joint_indices],
                         headSkinInfluenceThreshold=head_influence_threshold,
                         girth='closed horizontal torso surface contour'),
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
    DATA_OUT.write_text(output)
    (PUBLIC/'manifest.json').write_text(manifest_text)
    MANIFEST_OUT.write_text('// Generated; do not edit.\nexport const SOMA_BODY_MANIFEST_V2 = '+json.dumps(manifest,separators=(',',':'))+' as const;\n')
    print('packed bytes',len(output.encode()),'per-instance float32 position/normal bytes',len(vertices)*3*4*2)


if __name__ == '__main__':
    main()
