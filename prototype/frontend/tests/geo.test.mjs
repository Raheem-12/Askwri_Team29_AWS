import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { latLonToXYZ, angleBetween, framingDistance } from '../src/geo.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('lat/lon lands exactly where three.js SphereGeometry puts the texture', () => {
  // Texture u=0 is 180 W and v=1 is the north pole. If our mapping disagreed with
  // SphereGeometry anywhere, a pin would sit on the wrong continent.
  const geometry = new THREE.SphereGeometry(1, 72, 36);
  const pos = geometry.attributes.position, uv = geometry.attributes.uv;
  let checked = 0;
  for (let i = 0; i < pos.count; i++) {
    const lon = uv.getX(i) * 360 - 180, lat = uv.getY(i) * 180 - 90;
    const [x, y, z] = latLonToXYZ(lat, lon);
    close(pos.getX(i), x, 1e-5); close(pos.getY(i), y, 1e-5); close(pos.getZ(i), z, 1e-5);
    checked++;
  }
  assert.ok(checked > 2000);
});

test('cardinal points', () => {
  const [nx, ny, nz] = latLonToXYZ(90, 0);
  close(nx, 0); close(ny, 1); close(nz, 0);
  const [gx, gy, gz] = latLonToXYZ(0, 0);
  close(gx, 1); close(gy, 0); close(gz, 0);
  const [, sy] = latLonToXYZ(-90, 0);
  close(sy, -1);
});

test('every point is on the unit sphere and scales with radius', () => {
  for (const [lat, lon] of [[-6.17, 106.83], [4.6, -74.09], [-1.28, 36.81], [55, 12]]) {
    close(Math.hypot(...latLonToXYZ(lat, lon)), 1);
    close(Math.hypot(...latLonToXYZ(lat, lon, 1.5)), 1.5);
  }
});

test('Jakarta and Bogota are on opposite sides of the globe', () => {
  const jakarta = latLonToXYZ(-6.17, 106.83), bogota = latLonToXYZ(4.6, -74.09);
  assert.ok(angleBetween(jakarta, bogota) > 2.5); // roughly 180 degrees apart
  close(angleBetween(jakarta, jakarta), 0, 1e-6);
});

test('framing distance grows with spread and stays in range', () => {
  assert.ok(framingDistance(0) >= 2.7);
  assert.ok(framingDistance(1) > framingDistance(0.2));
  assert.equal(framingDistance(10), 5.2);
});
