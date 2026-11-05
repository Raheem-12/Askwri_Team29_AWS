// Only places with usable coordinates reach the globe.
export function cleanPlaces(list) {
  return (Array.isArray(list) ? list : [])
    .filter(p => p && typeof p.id === 'string' && typeof p.name === 'string'
      && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180
      && Array.isArray(p.issues))
    .map(p => ({ ...p, issues: p.issues.filter(i => i && typeof i.issue === 'string') }));
}
