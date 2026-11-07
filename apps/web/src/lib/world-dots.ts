/**
 * A dot-matrix world for the region picker: coarse land outlines (lon, lat) tagged with the Varada
 * region they belong to, sampled into evenly spaced dots, then projected onto an orthographic globe
 * or a flat equirectangular map. Outlines are deliberately rough (a dot every ~2.4 degrees), enough
 * to read the continents; region membership follows `COUNTRY_REGIONS` in the SDK (Mexico and the
 * Caribbean are Latin America, Egypt is drawn in Africa, Russia in Europe west of the Urals).
 */

export type MapRegion = "africa" | "asia" | "europe" | "middle-east" | "north-america" | "latin-america" | "oceania";

export const MAP_REGIONS: readonly MapRegion[] = ["north-america", "latin-america", "europe", "africa", "middle-east", "asia", "oceania"];

type Ring = readonly (readonly [number, number])[];

/** Checked in order: the first outline that holds a point names its region. */
const OUTLINES: readonly { region: MapRegion; ring: Ring }[] = [
  // Mexico, Central America and the Caribbean, cut out of North America below.
  {
    region: "latin-america",
    ring: [[-118, 32.6], [-114.7, 32.7], [-111, 31.3], [-106.5, 31.8], [-103, 29], [-100, 28.5], [-97, 25.9], [-90, 24], [-80, 24], [-60, 18], [-60, 5], [-120, 5]],
  },
  {
    region: "north-america",
    ring: [
      [-168, 66], [-162, 70], [-156, 71.3], [-140, 70], [-128, 70], [-115, 68.5], [-95, 72], [-82, 73], [-80, 63], [-94, 59], [-90, 57], [-82, 55], [-78, 52],
      [-77, 60], [-70, 60], [-64, 60], [-56, 52], [-60, 47], [-66, 44], [-70, 42], [-74, 40], [-76, 35], [-81, 31], [-80, 25], [-83, 29], [-90, 30], [-97, 27],
      [-97, 21], [-94, 18], [-90, 21], [-87, 21], [-88, 16], [-83, 15], [-83, 10], [-79, 9], [-80, 7], [-85, 10], [-92, 14], [-96, 16], [-105, 20], [-106, 23],
      [-110, 24], [-112, 29], [-114.5, 31.5], [-110, 23], [-112, 26], [-115, 30], [-117, 32.6], [-120, 34], [-124, 40], [-124, 46], [-123, 49], [-130, 54],
      [-134, 58], [-140, 60], [-147, 61], [-152, 59], [-158, 57], [-164, 55], [-158, 59], [-162, 60], [-165, 62], [-168, 66],
    ],
  },
  // Canadian Arctic islands.
  { region: "north-america", ring: [[-120, 74], [-95, 74], [-80, 74], [-70, 78], [-62, 82], [-90, 82], [-110, 78]] },
  { region: "north-america", ring: [[-73, 78], [-60, 82], [-30, 83], [-20, 80], [-20, 72], [-30, 68], [-40, 65], [-43, 60], [-50, 62], [-54, 67], [-58, 75]] },
  { region: "latin-america", ring: [[-85, 22], [-80, 23.2], [-74, 20], [-78, 19.8]] },
  { region: "latin-america", ring: [[-74.5, 18.5], [-68.5, 18.6], [-68.5, 18], [-74.5, 18]] },
  {
    region: "latin-america",
    ring: [
      [-80, 9], [-75, 11], [-72, 12], [-63, 11], [-60, 8], [-52, 5], [-50, 0], [-44, -2], [-35, -5], [-35, -9], [-39, -15], [-40, -22], [-48, -26], [-53, -34],
      [-58, -35], [-57, -38], [-62, -39], [-65, -42], [-65, -47], [-69, -51], [-68, -55], [-72, -54], [-75, -48], [-74, -40], [-72, -30], [-71, -18], [-76, -14],
      [-81, -5], [-80, -1], [-78, 2], [-77, 7],
    ],
  },
  {
    region: "europe",
    ring: [
      [-10, 36], [-9, 43], [-2, 43.5], [-1, 46], [-5, 48], [-1, 49.5], [2, 51], [5, 53], [8, 54], [8, 57], [10, 59], [5, 59], [5, 62], [12, 66], [18, 70], [25, 71],
      [30, 70], [40, 68], [44, 68], [54, 69], [60, 69], [60, 55], [55, 50], [50, 47], [47, 44], [42, 43], [40, 41.5], [37, 45], [30, 46], [28.5, 41.5], [26, 40.5],
      [23, 36.5], [20, 40], [19, 42], [13.5, 45.5], [12.5, 44], [16, 41.5], [18.5, 40], [16, 38], [15.6, 40], [12, 42], [10, 44], [6, 43], [3, 43], [0, 39],
      [-2, 36.8], [-6, 36],
    ],
  },
  { region: "europe", ring: [[-5.5, 50], [1.5, 51], [2, 53], [-1.5, 55.5], [-2, 58.6], [-5.5, 58.6], [-6, 56], [-4.5, 54.5], [-3, 54], [-5, 52]] },
  { region: "europe", ring: [[-10.5, 51.5], [-6, 52], [-5.8, 55.3], [-8, 55.3], [-10.5, 54]] },
  { region: "europe", ring: [[-24.5, 64], [-22, 66.5], [-15, 66.6], [-13, 65], [-18, 63.3]] },
  {
    region: "middle-east",
    ring: [
      [32.5, 31.5], [35, 28], [39, 22], [43, 13], [45, 12.8], [52, 16], [57, 19], [59.8, 22.5], [56.5, 26], [51.5, 24], [50, 26], [48, 30], [50, 30.2], [56, 27],
      [62, 25], [61, 30], [60.5, 37], [54, 37.5], [48, 39], [44, 39.5], [42, 41.5], [36, 41.5], [28.5, 41.5], [26, 39], [28, 37], [36, 36.5], [35.5, 33], [34.5, 31.5],
    ],
  },
  {
    region: "africa",
    ring: [
      [-17, 21], [-13, 28], [-10, 30], [-9, 33], [-6, 36], [0, 36], [10, 37.2], [11, 33], [20, 31], [25, 32], [32.5, 31.5], [34.5, 29.5], [37, 22], [39, 17],
      [43, 12], [51, 12], [48, 8], [42, -1], [40, -6], [40, -11], [35, -20], [35, -24], [33, -26], [32, -29], [27, -34], [20, -35], [18, -33], [15, -27], [12, -17],
      [13, -12], [12, -5], [9, -1], [9, 4], [6, 4], [2, 6], [-5, 5], [-8, 4.5], [-12, 7], [-15, 11], [-17, 15],
    ],
  },
  { region: "africa", ring: [[44, -25.5], [47.5, -25.5], [50.5, -15.5], [49.3, -12], [44, -17]] },
  {
    region: "asia",
    ring: [
      [60, 55], [60, 69], [70, 73], [80, 73.5], [100, 78], [112, 74], [130, 72], [140, 72.5], [160, 70], [170, 70], [180, 68.5], [180, 65], [170, 60], [163, 59],
      [160, 54], [156.5, 51], [156, 57], [150, 59.5], [143, 59.3], [137, 54], [141, 52], [140, 48], [135, 43], [130, 42], [129, 35], [126.5, 34.5], [126, 38],
      [122, 40], [121.5, 37], [119.5, 35], [122, 31], [121, 28], [117, 23], [110, 21], [108, 21.5], [106, 18], [109, 12], [105, 8.6], [103, 10], [100, 13],
      [100, 8], [103.5, 1.5], [101, 3], [98, 8], [98, 16], [94, 17], [92, 22], [88, 22], [86, 20], [80, 15], [80, 10], [77, 8], [73, 16], [72, 21], [68, 23],
      [66, 25], [62, 25], [61, 30], [60.5, 37], [54, 37.5], [53, 40], [52, 45], [50, 47], [55, 50],
    ],
  },
  { region: "asia", ring: [[130, 31], [132, 34], [135, 33.6], [140, 35], [141, 38], [142, 41], [140, 41], [139, 38], [136, 37], [133, 35.5], [130, 33.5]] },
  { region: "asia", ring: [[140, 42], [143, 42], [145.5, 43.5], [142, 45.5], [140, 43.5]] },
  { region: "asia", ring: [[120, 18.5], [122.3, 18.5], [122, 14], [124, 12.8], [126.5, 7], [125.5, 5.8], [122, 7], [123, 11], [120, 14]] },
  { region: "asia", ring: [[95, 5.6], [98, 4], [104, -2], [106, -6], [102, -4.5], [96, 2]] },
  { region: "asia", ring: [[105, -6], [114.5, -7], [114.5, -8.7], [106, -7.3]] },
  { region: "asia", ring: [[109, 2], [111, -3], [116.5, -4], [119, 1], [117, 7], [115, 5]] },
  { region: "asia", ring: [[119, -5.5], [120.5, 1], [125, 1.5], [121.5, -1], [123, -5.5]] },
  { region: "asia", ring: [[79.7, 9.8], [81.9, 7.5], [81.2, 6.1], [80, 6]] },
  { region: "asia", ring: [[120, 25.2], [122, 25.2], [121, 22], [120, 23]] },
  { region: "oceania", ring: [[131, -1], [141, -2.6], [148, -6], [150.5, -10.5], [143, -9], [138, -8.3], [135, -4.2]] },
  {
    region: "oceania",
    ring: [
      [114, -22], [113.5, -26], [115, -34.3], [118, -35], [124, -33.7], [129, -31.6], [134, -32.5], [138, -35.5], [140, -38], [146, -39], [150, -37.5],
      [153.5, -32], [153, -25], [150, -22], [146, -19], [145, -15], [142.5, -10.7], [141.5, -17], [136, -12], [132, -11.2], [129, -15], [126, -14], [122, -18],
    ],
  },
  { region: "oceania", ring: [[144.6, -40.7], [148.3, -40.9], [147, -43.6], [145.5, -43]] },
  { region: "oceania", ring: [[172.6, -34.4], [175.5, -37], [178.5, -37.7], [175, -41.6], [174, -39.5]] },
  { region: "oceania", ring: [[172.5, -40.5], [174.3, -41.7], [171, -44.3], [166.5, -46.3], [169, -43.5]] },
];

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The region drawn at a point, or null over the sea. The Latin America cut only applies on land. */
export function regionAt(lon: number, lat: number): MapRegion | null {
  const cut = inRing(lon, lat, OUTLINES[0]!.ring);
  for (const o of OUTLINES.slice(1)) {
    if (inRing(lon, lat, o.ring)) return cut && o.region === "north-america" ? "latin-america" : o.region;
  }
  return null;
}

export interface WorldDot {
  lon: number;
  lat: number;
  region: MapRegion;
}

/** Land dots about `step` degrees apart (wider in longitude towards the poles, so spacing is even). */
export function landDots(step = 2.4): WorldDot[] {
  const out: WorldDot[] = [];
  for (let lat = -56; lat <= 83; lat += step) {
    const lonStep = step / Math.max(Math.cos((lat * Math.PI) / 180), 0.18);
    for (let lon = -180 + lonStep / 2; lon < 180; lon += lonStep) {
      const region = regionAt(lon, lat);
      if (region) out.push({ lon, lat, region });
    }
  }
  return out;
}

/** Where each region's view centres (lon, lat): the globe turns to it when it is picked. */
export const REGION_CENTRES: Readonly<Record<MapRegion, readonly [number, number]>> = {
  "north-america": [-98, 42],
  "latin-america": [-68, -8],
  europe: [16, 50],
  africa: [20, 4],
  "middle-east": [46, 28],
  asia: [98, 32],
  oceania: [142, -24],
};

export interface GlobeView {
  /** Longitude and latitude at the centre of the disc. */
  lon: number;
  lat: number;
  /** Disc radius and centre in SVG units. */
  r: number;
  cx: number;
  cy: number;
}

const RAD = Math.PI / 180;

/** Orthographic projection; null for a point on the far side. */
export function projectGlobe(lon: number, lat: number, v: GlobeView): [number, number] | null {
  const l = (lon - v.lon) * RAD;
  const p = lat * RAD;
  const p0 = v.lat * RAD;
  const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
  if (cosc <= 0.02) return null;
  const x = v.r * Math.cos(p) * Math.sin(l);
  const y = v.r * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l));
  return [v.cx + x, v.cy - y];
}

/** Equirectangular projection onto a `w` x `h` box covering latitudes 84 to -58. */
export function projectFlat(lon: number, lat: number, w: number, h: number): [number, number] {
  return [((lon + 180) / 360) * w, ((84 - lat) / 142) * h];
}

/**
 * One SVG path per region, each dot a zero-length segment: drawn with `stroke-linecap: round` the
 * strokes become dots, so the whole map is seven elements however many dots it has.
 */
export function regionPaths(dots: readonly WorldDot[], project: (lon: number, lat: number) => [number, number] | null): Record<MapRegion, string> {
  const parts: Record<MapRegion, string[]> = { "north-america": [], "latin-america": [], europe: [], africa: [], "middle-east": [], asia: [], oceania: [] };
  for (const d of dots) {
    const xy = project(d.lon, d.lat);
    if (xy) parts[d.region].push(`M${xy[0].toFixed(1)} ${xy[1].toFixed(1)}h0`);
  }
  return Object.fromEntries(MAP_REGIONS.map((r) => [r, parts[r].join("")])) as Record<MapRegion, string>;
}

/** Shortest turn from one longitude to another, in degrees (-180, 180]. */
export function lonDelta(from: number, to: number): number {
  const d = (((to - from) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}
