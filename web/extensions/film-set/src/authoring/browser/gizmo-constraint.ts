import { rayPlanePoint, type GizmoYawConstraint, type Ray, type Vec3 } from "@woohaa3/contracts";
const dot = (a: Vec3, b: Vec3) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export function constrainedYawAngle(constraint: GizmoYawConstraint, ray: Ray): number | null {
  if (Math.abs(dot(ray.direction, constraint.normal)) < 0.08) return null;
  const point = rayPlanePoint(ray, constraint.origin, constraint.normal);
  if (!point) return null;
  const delta = point.map((value, index) => value - constraint.origin[index]) as Vec3;
  const { u, v } = constraint;
  const uu=dot(u,u), vv=dot(v,v), uv=dot(u,v), determinant=uu*vv-uv*uv;
  if (!Number.isFinite(determinant) || determinant <= 0) return null;
  const a=(dot(delta,u)*vv-dot(delta,v)*uv)/determinant;
  const b=(dot(delta,v)*uu-dot(delta,u)*uv)/determinant;
  return Number.isFinite(a) && Number.isFinite(b) && Math.hypot(a,b)>1e-5 ? Math.atan2(b,a) : null;
}
export function unwrapAngle(angle: number): number { return Math.atan2(Math.sin(angle), Math.cos(angle)); }

export function gizmoParentBasis(inverse: number[] | undefined, yaw: number, unit: number): number[] {
  if (!inverse) { const c=Math.cos(yaw)*unit, s=Math.sin(yaw)*unit; return [c,0,-s,0,unit,0,s,0,c]; }
  const [a,b,c,d,e,f,g,h,i]=inverse;
  const determinant=a*(e*i-f*h)-d*(b*i-c*h)+g*(b*f-c*e);
  return [(e*i-f*h),(c*h-b*i),(b*f-c*e),(f*g-d*i),(a*i-c*g),(c*d-a*f),(d*h-e*g),(b*g-a*h),(a*e-b*d)].map(value => value/determinant);
}
