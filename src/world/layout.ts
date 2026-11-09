/**
 * World layout: pure data and functions describing where everything is.
 * No rendering code here, so it can be used by tests, the minimap and the sim.
 *
 * Coordinates: metres. +X = east, +Z = south (so -Z = north). Y = up.
 */
import { distToSegment } from '../util/math';

export const SEED = 4207;
export const WORLD_HALF = 1000;
/** Players cannot walk past this (edge mountains are beyond). */
export const WORLD_LIMIT = 985;
export const WATER_LEVEL = 0;
export const PAD_ELEV = 8;

// ---------------------------------------------------------------- river
export const RIVER_NAME = 'Ash River';
export const RIVER_HALF_WIDTH = 30;
export const RIVER_BANK = 28;
/** X coordinate of the river's centreline at a given Z (flows north–south). */
export function riverX(z: number): number {
  return -230 + 45 * Math.sin(z / 260) + 20 * Math.sin(z / 97 + 1);
}
export function riverDistance(x: number, z: number): number {
  return Math.abs(x - riverX(z));
}

// ---------------------------------------------------------------- zones
export interface Rect {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
}
export interface FlatZone extends Rect {
  id: string;
  elev: number;
  falloff: number;
}

export const PLANT: FlatZone = { id: 'plant', cx: -500, cz: 0, hx: 170, hz: 185, elev: PAD_ELEV, falloff: 50 };
export const TOWN: FlatZone = { id: 'town', cx: 85, cz: 40, hx: 240, hz: 215, elev: PAD_ELEV, falloff: 60 };
export const INDUSTRIAL: FlatZone = { id: 'industrial', cx: 360, cz: 540, hx: 150, hz: 100, elev: 10, falloff: 60 };
export const FLAT_ZONES: readonly FlatZone[] = [PLANT, TOWN, INDUSTRIAL];

export const FARMLAND = { minX: 430, maxX: 820, minZ: 90, maxZ: 420 };
export const LOOKOUT = { x: 520, z: -520, height: 130, sigma: 170 };

const RIVER_AT_BRIDGE = riverX(0);
export const BRIDGE = {
  z: 0,
  x0: RIVER_AT_BRIDGE - 60,
  x1: RIVER_AT_BRIDGE + 60,
  halfWidth: 5,
  deckTop: PAD_ELEV + 0.3,
  /** Terrain is flattened to deck level this far either side of the deck. */
  flatHalfZ: 8,
};

/** Player start: just inside the plant's security gate, facing the reactor. */
export const SPAWN = { x: -345, z: 12, yaw: Math.PI / 2 };

export function inRect(x: number, z: number, r: Rect, margin = 0): boolean {
  return Math.abs(x - r.cx) <= r.hx + margin && Math.abs(z - r.cz) <= r.hz + margin;
}

// ---------------------------------------------------------------- plant layout
export const PLANT_LAYOUT = {
  containment: { x: -525, z: -40, r: 22, h: 42 },
  turbineHall: { cx: -450, cz: -40, w: 70, d: 36, h: 22 },
  controlRoom: { cx: -490, cz: 25, w: 30, d: 20, h: 8 },
  coolingTowers: [
    { x: -610, z: 95 },
    { x: -530, z: 115 },
  ],
  switchyard: { cx: -390, cz: 110, w: 60, d: 50 },
  spentFuel: { cx: -620, cz: -120, w: 40, d: 30 },
  admin: { cx: -385, cz: -110, w: 34, d: 20, h: 12 },
  parking: { cx: -370, cz: 45, w: 40, d: 36 },
  gate: { x: -330, z: 0 },
  fence: { minX: -668, maxX: -332, minZ: -183, maxZ: 183, gateHalf: 6 },
};

// ---------------------------------------------------------------- town layout
export const TOWN_STREETS_X = [-60, 60, 180, 290] as const;
export const TOWN_STREETS_Z = [-100, 120, 230] as const;
export const TOWN_GRID = { minX: -125, maxX: 300, minZ: -165, maxZ: 240 };
/** Faces north onto Main Street across the town square. */
export const TOWN_HALL = { cx: 0, cz: 72, w: 36, d: 24, h: 14 };
export const TOWN_SQUARE = { x: TOWN_HALL.cx, z: TOWN_HALL.cz - TOWN_HALL.d / 2 - 14 };
export const SCHOOL = { cx: 120, cz: -52, w: 50, d: 22, h: 10 };

// ---------------------------------------------------------------- roads
export type RoadKind = 'asphalt' | 'dirt';
export interface Road {
  name: string;
  kind: RoadKind;
  width: number;
  points: ReadonlyArray<readonly [number, number]>;
}

const townStreets: Road[] = [
  ...TOWN_STREETS_X.map((x): Road => ({
    name: 'Street', kind: 'asphalt', width: 8,
    points: [[x, TOWN_GRID.minZ], [x, TOWN_GRID.maxZ]],
  })),
  ...TOWN_STREETS_Z.map((z): Road => ({
    name: 'Street', kind: 'asphalt', width: 8,
    points: [[TOWN_GRID.minX, z], [TOWN_GRID.maxX, z]],
  })),
];

export const ROADS: readonly Road[] = [
  { name: 'Plant Road', kind: 'asphalt', width: 8, points: [[-660, 0], [-330, 0]] },
  { name: 'Switchyard Spur', kind: 'asphalt', width: 6, points: [[-390, 0], [-390, 84]] },
  { name: 'Admin Spur', kind: 'asphalt', width: 6, points: [[-385, 0], [-385, -99]] },
  { name: 'Fuel Pad Spur', kind: 'asphalt', width: 6, points: [[-600, 0], [-618, -104]] },
  { name: 'Turbine Hall Spur', kind: 'asphalt', width: 6, points: [[-450, 0], [-450, -21]] },
  { name: 'Control Room Spur', kind: 'asphalt', width: 4, points: [[-490, 0], [-490, 14]] },
  { name: 'Station Access', kind: 'asphalt', width: 9, points: [[-330, 0], [BRIDGE.x0 + 1, 0]] },
  { name: 'Main Street', kind: 'asphalt', width: 10, points: [[BRIDGE.x1 - 1, 0], [330, 0]] },
  ...townStreets,
  {
    name: 'Hill Road', kind: 'dirt', width: 6,
    points: [[330, 0], [400, -110], [455, -250], [540, -320], [470, -395], [560, -440], [528, -500]],
  },
  { name: 'Mill Road', kind: 'asphalt', width: 8, points: [[180, 240], [230, 380], [300, 450], [330, 470]] },
  { name: 'County Road', kind: 'asphalt', width: 8, points: [[330, 0], [520, 60], [700, 160], [900, 250]] },
  { name: 'Farm Track', kind: 'dirt', width: 5, points: [[700, 160], [690, 330], [640, 410]] },
  { name: 'Orchard Lane', kind: 'dirt', width: 5, points: [[520, 60], [540, 250], [650, 330]] },
];

export function distanceToRoads(x: number, z: number): number {
  let best = Infinity;
  for (const r of ROADS) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const [ax, az] = r.points[i];
      const [bx, bz] = r.points[i + 1];
      const d = distToSegment(x, z, ax, az, bx, bz) - r.width / 2;
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------- power grid

export type SubstationId = 'town' | 'industrial' | 'farmland' | 'city';

export const SUBSTATION_SITES: Record<SubstationId, { x: number; z: number; name: string }> = {
  town: { x: 352, z: 268, name: 'Millbrook Substation' },
  industrial: { x: 545, z: 520, name: 'Industrial Park Substation' },
  farmland: { x: 640, z: 60, name: 'Farmland Substation' },
  city: { x: 905, z: -70, name: 'City Tie-Line Terminal' },
};

/** Switchyard at the plant, where every line starts. */
export const SWITCHYARD_POINT: readonly [number, number] = [-390, 110];
/** Where the trunk line splits towards the substations. */
export const GRID_JUNCTION: readonly [number, number] = [150, 330];

export interface PowerLine {
  id: string;
  /** Substations that lose supply if this line is down. */
  feeds: SubstationId[];
  points: ReadonlyArray<readonly [number, number]>;
}

export const POWER_LINES: readonly PowerLine[] = [
  { id: 'trunk', feeds: ['town', 'industrial', 'farmland', 'city'], points: [SWITCHYARD_POINT, [-300, 250], [-100, 320], GRID_JUNCTION] },
  { id: 'town', feeds: ['town'], points: [GRID_JUNCTION, [SUBSTATION_SITES.town.x, SUBSTATION_SITES.town.z]] },
  { id: 'industrial', feeds: ['industrial'], points: [GRID_JUNCTION, [330, 410], [520, 425], [SUBSTATION_SITES.industrial.x, SUBSTATION_SITES.industrial.z]] },
  { id: 'farmland', feeds: ['farmland', 'city'], points: [GRID_JUNCTION, [420, 300], [SUBSTATION_SITES.farmland.x, SUBSTATION_SITES.farmland.z]] },
  { id: 'city', feeds: ['city'], points: [[SUBSTATION_SITES.farmland.x, SUBSTATION_SITES.farmland.z], [770, -30], [SUBSTATION_SITES.city.x, SUBSTATION_SITES.city.z]] },
];

/** Millbrook's 8 distribution districts: 4 columns (between the N–S streets) × north/south of Main Street. */
export const TOWN_DISTRICTS = 8;
export function townDistrictAt(x: number, z: number): number {
  const edges = [-60, 60, 180];
  let col = 0;
  while (col < edges.length && x > edges[col]) col++;
  return col + (z >= 0 ? 4 : 0);
}
export const TOWN_DISTRICT_NAMES = [
  'Riverside North', 'Old Town North', 'Schoolside', 'East End North',
  'Riverside South', 'Town Hall', 'Midtown South', 'East End South',
];

// ---------------------------------------------------------------- names & zones
export const PLANT_NAME = 'Riverbend Generating Station';
export const TOWN_NAME = 'Millbrook';

export interface MapLabel {
  name: string;
  x: number;
  z: number;
  size: 'lg' | 'md' | 'sm';
}
export const MAP_LABELS: readonly MapLabel[] = [
  { name: 'Riverbend Station', x: PLANT.cx, z: PLANT.cz - 200, size: 'lg' },
  { name: TOWN_NAME, x: TOWN.cx, z: TOWN.cz - 235, size: 'lg' },
  { name: 'Lookout Hill', x: LOOKOUT.x, z: LOOKOUT.z - 40, size: 'md' },
  { name: 'Industrial Park', x: INDUSTRIAL.cx, z: INDUSTRIAL.cz + 120, size: 'md' },
  { name: 'Farmland', x: 640, z: 250, size: 'md' },
  { name: 'North Woods', x: -150, z: -600, size: 'md' },
  { name: 'West Woods', x: -820, z: 200, size: 'sm' },
  { name: RIVER_NAME, x: riverX(420) + 40, z: 420, size: 'sm' },
  { name: 'City Tie-Line', x: 905, z: -110, size: 'sm' },
];

/** Human-readable name of the area at a position (for the HUD). */
export function zoneNameAt(x: number, z: number): string {
  if (inRect(x, z, PLANT, 10)) return PLANT_NAME;
  if (Math.abs(z) < 12 && x > PLANT.cx + PLANT.hx && x < BRIDGE.x0) return 'Station Access Road';
  if (Math.abs(z - BRIDGE.z) < 12 && x > BRIDGE.x0 - 5 && x < BRIDGE.x1 + 5) return 'Riverbend Bridge';
  if (riverDistance(x, z) < RIVER_HALF_WIDTH + 6) return RIVER_NAME;
  if (inRect(x, z, TOWN, 5)) return TOWN_NAME;
  if (inRect(x, z, INDUSTRIAL, 10)) return 'Millbrook Industrial Park';
  if (Math.hypot(x - LOOKOUT.x, z - LOOKOUT.z) < 90) return 'Lookout Hill — Summit';
  if (Math.hypot(x - LOOKOUT.x, z - LOOKOUT.z) < 320) return 'Lookout Hill';
  if (x > FARMLAND.minX && x < FARMLAND.maxX && z > FARMLAND.minZ && z < FARMLAND.maxZ) return 'Farmland';
  if (z < -300) return 'North Woods';
  if (x < -700) return 'West Woods';
  return 'Countryside';
}
