Synthetic test fixtures, authored in this repository using NumPy `savez_compressed`.
Two joints (Hips / 骨骼), one triangle, eight skin slots, two identity-rotation
frames with a two metre root translation. No external dataset or generated
provider asset is embedded. The fixture covers UTF-32 names, int64 topology,
float64 vertices, float32 rotations and weights, ZIP64 local headers, and DEFLATE.

`bad-rotation.npz`, `bad-rest.npz`, and `bad-topology.npz` are copies of the
synthetic fixtures with respectively one non-orthogonal rotation element,
one inconsistent posed joint position, and one self-parent connection.
