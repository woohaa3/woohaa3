# SOMA body preset generation

This is an offline build tool, never a runtime dependency. The `soma-body-v1`
catalog contains the Cartesian product of male/female, 7/8/9/10 heads and
slim/fat, plus five fixed age shapes: baby, male/female child and male/female teen. A published identifier must never be reused for different geometry.

The source backend is SOMA-X 0.3.6, commit
`01ab5b5c0876058bd27d34b1607d74b2e55e0cf4`, with Anny 0.2.0.
SOMA-X code and public model assets are Apache-2.0; Anny code is Apache-2.0
and its MakeHuman/MPFB2 body assets are CC0-1.0. The optional noncommercial
SMPL-X topology is not an input to this generator.

Generation must measure the final external surface, fit a target skeleton,
retain every exported skin influence and verify the complete catalog before
publishing it. CPU generation is permitted; visual acceptance requires a real
GPU and is separate from numerical validation.

```sh
uv venv .venv-soma
uv pip sync --python .venv-soma/bin/python scripts/soma-body-presets/requirements.lock \
  --extra-index-url https://download.pytorch.org/whl/cpu
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/NVlabs/SOMA-X.git /tmp/soma-x
cd /tmp/soma-x
git checkout 01ab5b5c0876058bd27d34b1607d74b2e55e0cf4
git lfs pull --include='assets/SOMA_neutral.npz,assets/SOMA_template_rig.usda,assets/Anny/*'
cd -
.venv-soma/bin/python scripts/soma-body-presets/generate.py --assets /tmp/soma-x/assets
```

Python 3.11 on Linux CPU was used for the first export. `sources.json` freezes
all four source asset hashes before the layer is initialized. The lock freezes
transitive dependencies and wheel hashes; SOMA-X uses an immutable Git commit.
The generated public manifest freezes parameters and surface measurements.
The catalog is append-only after an export is published. This workspace export
uses the corrected body-segment calibration; future published geometry changes
must use a new catalog version.

The Anny body is shaped with gender/weight and an explicit local waist control.
Anny 0.2.0 defines its gender anchors as `male=0`, `female=1`; the exporter
checks the upstream anchor order before mapping the public catalog labels.
Adult head ratios are calibrated by changing the leg and torso segment lengths
(the legs receive most of the height delta); the chin-to-crown geometry is
kept intact. Nine- and ten-head figures put 78% and 82% of the added height
into the legs. The calibration unit is the visible skinned head: vertices with
at least 50% combined `Head`/`Jaw` influence, including the hair and face
surfaces that are actually rendered. A ratio-specific body-width compensation
keeps seven-head adults close to a realistic silhouette and gives long
heroic figures enough torso and limb volume. For ten-head figures the waist
also receives a separate taper, while the central torso/shoulder/pelvis and
proximal limbs retain game-character mass and distal hands/feet taper back
down. Seven through nine heads retain their existing shared compensation.
SOMA-X then refits and rebinds the skeleton. This preserves full
hand/foot geometry and retains all ten exported skin influences. The generator validates
all twenty-one exports before replacing any output; it never substitutes the old
Kimodo body when generation fails. `--staging /tmp/body-exports` optionally
writes inspectable NPZ intermediates outside the source tree.

Fixed age shapes use Anny age anchors (baby=0, child=1/3, teen=.5), a neutral
gender blend for the baby, and retain natural age-dependent proportions rather
than applying the adult head-ratio calibration. Final heights are .70, 1.15,
and 1.50 m respectively. The generated manifest records the exact marker
vertices, skin joints and influence threshold used for every ratio measurement.
