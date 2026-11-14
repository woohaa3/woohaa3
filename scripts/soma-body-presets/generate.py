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
GENERATOR = 'soma-body-generator-v2'
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
    """Reach a head ratio by changing body segment lengths, not head size.

    The head is the measuring unit in figure construction. Keep the source
    chin-to-crown geometry intact, then distribute the height delta between
    the legs and torso. Long adult figures put a larger share below the pelvis;
    the final uniform normalization preserves the requested ratio without
    introducing a separate head scale.
    """
    _source_v, source_b = fit(layer, source)
    names = [str(n) for n in layer.rig_data['joint_names'][1:]]
    hips_y = float(source_b[names.index('Hips') + 1, 1, 3])
    chest_y = float(source_b[names.index('Chest') + 1, 1, 3])
    bottom = float(source[:, 1].min())
    chin_y = float(source[CHIN, 1])
    head_height = float(source[head_ids, 1].max() - chin_y)
    source_height = float(np.ptp(source[:, 1]))
    leg_length = hips_y - bottom
    torso_length = chin_y - hips_y
    # Uniform height normalization makes long figures thinner in world units.
    # Compensate that predictable loss while keeping seven heads close to a
    # realistic adult silhouette and giving nine/ten-head game figures enough
    # torso and limb volume to read as designed characters rather than wires.
    body_width_factor = .96 if target == 7 else 1.25 if target == 9 else 1.50 if target == 10 else 1.
    # Korean game figures put more of the added height below the pelvis. The
    # previous 72/28 split left ten-head figures with a torso that was too long
    # and legs that read short, even though the measured ratio was correct.
    leg_share = .72 if target <= 8 else .78 if target == 9 else .82
    torso_share = 1. - leg_share
    # Keep the waist narrow while the chest, shoulders and pelvis retain their
    # game-character mass. This only affects torso-influenced vertices, so the
    # upper legs do not get pinched along with the waist.
    waist_factor = 1. if target <= 8 else .90 if target == 9 else .84
    waist_t = np.clip((hips_y + (chest_y - hips_y) * .3 - hips_y) /
                      max(chin_y - hips_y, 1e-6), 0, 1)
    # Korean game figures keep a broad chest, shoulder line and pelvis when
    # they move from eight to ten heads.  Their arms and legs stay long but
    # retain mass, while hands, feet and toes taper back down.  Use the skin
    # regions to apply those three widths instead of one factor to every
    # vertex; this avoids the wire-like limbs seen after height normalization
    # without producing oversized gloves or boots.
    dense_skin = layer.skinning_weights.detach().numpy()[:, 1:]
    limb_joint_indices = np.asarray([i for i, name in enumerate(names)
                                     if any(part in name for part in ('Arm', 'ForeArm', 'Leg', 'Shin'))], dtype=int)
    extremity_joint_indices = np.asarray([i for i, name in enumerate(names)
                                          if any(part in name for part in ('Hand', 'Foot', 'Toe'))], dtype=int)
    limb_influence = dense_skin[:, limb_joint_indices].sum(axis=1)
    extremity_influence = dense_skin[:, extremity_joint_indices].sum(axis=1)
    limb_width_factor = 1 + (body_width_factor - 1) * (.87 if target >= 9 else 1.)
    extremity_width_factor = (limb_width_factor if target < 10
                              else 1 + (body_width_factor - 1) * .65)

    def build(delta):
        new_leg = leg_length + delta * leg_share
        new_torso = torso_length + delta * torso_share
        if min(leg_length, torso_length, new_leg, new_torso) <= 0:
            raise ValueError(f'Invalid body segment lengths for head ratio {target}')
        new_hips = bottom + new_leg
        new_chin = new_hips + new_torso

        def map_y(y):
            if y <= hips_y:
                return bottom + (y - bottom) * new_leg / leg_length
            if y <= chin_y:
                return new_hips + (y - hips_y) * new_torso / torso_length
            return new_chin + (y - chin_y)

        v = source.copy()
        v[:, 1] = np.asarray([map_y(y) for y in v[:, 1]], dtype=v.dtype)
        edge = .06
        blend = np.clip((v[:, 1] - (new_chin - edge)) / edge, 0, 1)
        blend = blend * blend * (3 - 2 * blend)
        body_weight = np.clip(1 - limb_influence - extremity_influence, 0, 1)
        local_width_factor = (body_width_factor * body_weight
                              + limb_width_factor * limb_influence
                              + extremity_width_factor * extremity_influence)
        torso_t = np.clip((v[:, 1] - new_hips) / max(new_chin - new_hips, 1e-6), 0, 1)
        waist_pull = np.exp(-((torso_t - waist_t) / .14) ** 2)
        local_width_factor *= 1 - waist_pull * (1 - waist_factor) * body_weight
        width = local_width_factor + (1 - local_width_factor) * blend
        v[:, [0, 2]] *= width[:, None]
        v, b = normalize(*fit(layer, v))
        ratio = float(np.ptp(v[:, 1]) / (v[head_ids, 1].max()-v[CHIN, 1]))
        return v, b, ratio, new_leg / leg_length, new_torso / torso_length

    # The source mesh is not exactly eight heads tall under the visible-mesh
    # rule, so solve the requested ratio from the resulting fitted geometry
    # instead of assuming that zero warp means eight heads.
    lower = max(-leg_length / leg_share, -torso_length / torso_share) + 1e-4
    upper = max(head_height, source_height)
    while build(lower)[2] > target:
        lower = (lower + max(-leg_length / leg_share, -torso_length / torso_share)) * .5
    while build(upper)[2] < target:
        upper *= 2
    for _ in range(24):
        middle = (lower + upper) * .5
        if build(middle)[2] < target:
            lower = middle
        else:
            upper = middle
    v, b, ratio, leg_factor, torso_factor = build((lower + upper) * .5)
    if abs(ratio-target) > .05:
        raise ValueError(f'Head ratio calibration failed: {target}: {ratio}')
    return (v.astype('<f4'), b.astype('<f4'), leg_factor, torso_factor,
            body_width_factor, ratio, leg_share, waist_factor)


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
    # Measure the visible head from the same skinned mesh that the renderer
    # displays.  The old segment marker removed hair, haircap and face bags,
    # which made the calibration unit materially shorter than the visible
    # head.  A vertex belongs to the head marker when Head/Jaw together carry
    # at least half of its skin influence; the chin remains the fixed SOMA
    # topology marker below.
    head_joint_indices = np.asarray([names.index('Head'), names.index('Jaw')], dtype=int)
    head_influence_threshold = .5
    head_influence = dense[:, head_joint_indices].sum(axis=1)
    head_ids = np.setdiff1d(np.flatnonzero(head_influence >= head_influence_threshold), [CHIN]).astype(int)
    assert len(head_ids) > 4000
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
                vertices, binds, leg_factor, torso_factor, body_width_factor, ratio, leg_share, waist_factor = calibrate(layer, source, heads, head_ids)
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
            localChanges=local_changes, headScale=1.,
            proportionWarp=(dict(legFactor=leg_factor, torsoFactor=torso_factor,
                                 bodyWidthFactor=body_width_factor, legShare=leg_share,
                                 waistFactor=waist_factor) if heads is not None else None),
            measurements=measurements)
        if heads is None:
            entry.pop('proportionWarp')
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
    (OUT/'body-data.ts').write_text(output)
    (PUBLIC/'manifest.json').write_text(manifest_text)
    (OUT/'body-manifest.ts').write_text('// Generated; do not edit.\nexport const SOMA_BODY_MANIFEST = '+json.dumps(manifest,separators=(',',':'))+' as const;\n')
    print('packed bytes',len(output.encode()),'per-instance float32 position/normal bytes',len(vertices)*3*4*2)


if __name__ == '__main__':
    main()
