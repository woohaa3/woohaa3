# soma-body-v2

These eight bodies were generated offline with NVIDIA SOMA-X 0.3.6 (commit
`01ab5b5c0876058bd27d34b1607d74b2e55e0cf4`) and NAVER Anny 0.2.0. SOMA-X uses
Apache-2.0; Anny code uses Apache-2.0 and its MPFB2/MakeHuman body assets use
CC0-1.0. No optional noncommercial SMPL-X topology or separately licensed
SMPL/MANO asset is used.

The quick picker maps directly to Anny's age and gender anchors. It keeps
muscle and weight at their average anchors, uses ideal proportions, and does
not apply head, leg, torso, width, or waist warps. Bodies are normalized to
the fixed scene heights for their age group, fitted and rebound to the SOMA77
skeleton, and placed with soles at Y=0. All ten exported skin influences are
retained. Every preset's parameters, measurements, source asset digests, and
geometry/skeleton digests are in `manifest.json`.

Anny age parameters used here are newborn=-1/3, child=1/3, young=2/3, and
old=1. Gender anchors are male=0 and female=1. The generated runtime data is
embedded in the client build; creating a body needs no Python or download.
Regenerate using `scripts/soma-body-presets/generate.py` and its locked
environment. Published IDs are append-only; v1 remains available for old
canvas documents.
