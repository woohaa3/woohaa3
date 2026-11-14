# SOMA body preset generation

This is an offline build tool, never a runtime dependency. The `soma-body-v2`
catalog uses Anny 0.2.0's official phenotype space without post-generation
head, leg, torso, width, or waist warps. The quick picker currently exposes
only age and gender; muscle, weight, height, and proportions stay at stable
official anchors until a separate advanced control is designed.

The v2 catalog contains eight entries:

- male/female newborn;
- male/female child;
- male/female young adult;
- male/female old adult.

The published `soma-body-v1` catalog remains immutable and readable by old
canvas documents. New geometry is written to `body-data-v2.ts`,
`body-manifest-v2.ts`, and `public/soma/body-v2/manifest.json`; published IDs
are append-only and must never be reused.

The source backend is SOMA-X 0.3.6, commit
`01ab5b5c0876058bd27d34b1607d74b2e55e0cf4`, with Anny 0.2.0.
SOMA-X code and public model assets are Apache-2.0; Anny code is Apache-2.0
and its MakeHuman/MPFB2 body assets are CC0-1.0. The optional noncommercial
SMPL-X topology is not an input to this generator.

Generation uses the frozen dependency lock and source hashes:

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

Anny's age anchors used here are `newborn=-1/3`, `child=1/3`,
`young=2/3`, and `old=1`. Gender uses Anny's `male=0` and `female=1`
anchors. The generated manifest records the exact surface measurements and
source hashes. CPU generation is permitted; visual acceptance still requires
the project's real GPU review path.
