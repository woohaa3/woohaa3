Synthetic test fixtures, authored in this repository using NumPy `savez_compressed`.
Two joints (Hips / 骨骼), one triangle, eight skin slots, two identity-rotation
frames with a two metre root translation. No external dataset or generated
provider asset is embedded. The fixture covers UTF-32 names, int64 topology,
float64 vertices, float32 rotations and weights, ZIP64 local headers, and DEFLATE.

`bad-rotation.npz`, `bad-rest.npz`, and `bad-topology.npz` are copies of the
synthetic fixtures with respectively one non-orthogonal rotation element,
one inconsistent posed joint position, and one self-parent connection.

`standard-body-motion.npz` uses the embedded official Kimodo SOMA77 bind
matrices (the same source as `soma-humanoid/skeleton.ts`) to author three
controlled frames: standing, horizontal root travel, and 0.3 m root lift.
Local/global rotations and posed joints are computed by FK, with NumPy
`savez_compressed`. It is synthetic validation data, not generated walking
motion, and carries no evidence about foot sliding or motion quality.
