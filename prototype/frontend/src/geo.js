// Latitude/longitude to a point on the unit sphere, matching how three.js
// SphereGeometry maps an equirectangular texture (u = 0 at 180 W, v = 1 at the
// north pole). tests/geo.test.mjs proves it against real SphereGeometry vertices.
const RAD = Math.PI / 180;

export function latLonToXYZ(lat, lon, radius = 1) {
  const polar = (90 - lat) * RAD;
  const azimuth = (lon + 180) * RAD;
  return [
    -radius * Math.sin(polar) * Math.cos(azimuth),
    radius * Math.cos(polar),
    radius * Math.sin(polar) * Math.sin(azimuth)
  ];
}

export function angleBetween(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  return Math.acos(Math.min(1, Math.max(-1, dot / (la * lb))));
}

// Camera distance that keeps a spread of points comfortably in view.
export function framingDistance(spreadRadians, { min = 2.7, max = 5.2 } = {}) {
  return Math.min(max, Math.max(min, 2.9 + spreadRadians * 1.7));
}
