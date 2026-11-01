// ETRS89 / UTM zone 32N (EPSG:25832) <-> lat/lon, matching UtmProjection.cs in the game
// so the web map and Unity place things identically.

const A = 6378137.0;
const F = 1 / 298.257222101;
const K0 = 0.9996;
const FALSE_EASTING = 500000.0;
const CENTRAL_MERIDIAN = 9.0;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const DEG = Math.PI / 180;

function meridianArc(phi) {
  const e4 = E2 * E2, e6 = e4 * E2;
  return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
    - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
    - (35 * e6 / 3072) * Math.sin(6 * phi));
}

/** @returns {[number, number]} [easting, northing] */
export function toUtm32(lat, lon) {
  const phi = lat * DEG;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const n = A / Math.sqrt(1 - E2 * sin * sin);
  const t = tan * tan;
  const c = EP2 * cos * cos;
  const a = cos * (lon - CENTRAL_MERIDIAN) * DEG;
  const m = meridianArc(phi);

  const easting = FALSE_EASTING + K0 * n * (a + (1 - t + c) * a ** 3 / 6
    + (5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5 / 120);
  const northing = K0 * (m + n * tan * (a ** 2 / 2 + (5 - t + 9 * c + 4 * c * c) * a ** 4 / 24
    + (61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6 / 720));
  return [easting, northing];
}

/** @returns {[number, number]} [lon, lat] — MapLibre's coordinate order */
export function fromUtm32(easting, northing) {
  const e4 = E2 * E2, e6 = e4 * E2;
  const mu = (northing / K0) / (A * (1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
  const sq = Math.sqrt(1 - E2);
  const e1 = (1 - sq) / (1 + sq);

  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1), cos1 = Math.cos(phi1), tan1 = Math.tan(phi1);
  const c1 = EP2 * cos1 * cos1;
  const t1 = tan1 * tan1;
  const w = 1 - E2 * sin1 * sin1;
  const n1 = A / Math.sqrt(w);
  const r1 = A * (1 - E2) / (w * Math.sqrt(w));
  const d = (easting - FALSE_EASTING) / (n1 * K0);

  const phi = phi1 - (n1 * tan1 / r1) * (d ** 2 / 2
    - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6 / 720);
  const lambda = (d - (1 + 2 * t1 + c1) * d ** 3 / 6
    + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5 / 120) / cos1;

  return [CENTRAL_MERIDIAN + lambda / DEG, phi / DEG];
}
