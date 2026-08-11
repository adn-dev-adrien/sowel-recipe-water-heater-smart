/**
 * Sowel Recipe: Smart Water Heater (chauffe-eau intelligent)
 *
 * Drives a plain ON/OFF relay in front of a water heater whose own mechanical
 * thermostat decides the final temperature. The recipe never sets a setpoint —
 * it only decides *when* the resistor is allowed to draw power, and it learns
 * how long a full heat-up takes.
 *
 * ── The three reasons to heat, by priority ────────────────────────────────
 *
 *  1. FLOOR (safety, wins over everything)
 *     The bottom-of-tank probe falls under `minTemp` → heat immediately,
 *     whatever the tariff or the sun. Stops at `rescueTemp` (hysteresis).
 *     This is the "gîte" case: showers all afternoon, tank drained, we refill
 *     even at peak price because cold water is not an option.
 *
 *  2. OFF-PEAK (heures creuses, the cheap bulk of the energy)
 *     Inside the HC window the recipe runs one full cycle. In the default
 *     `late` placement it starts at `hcEnd − learnedDuration`, so the cycle
 *     *finishes* as the window closes: the water is at its hottest at wake-up
 *     and spends the fewest hours cooling down in the tank.
 *
 *  3. SOLAR SURPLUS (free energy, outside HC)
 *     Two absolute thresholds read straight off the grid meter: heat once the
 *     house exports more than `surplusStartPower`, stop once the grid supplies
 *     more than `maxGridImport`. The control law adds the heater's own draw
 *     back into the surplus while it is running, otherwise the export collapses
 *     to zero the second the relay closes and the recipe would immediately cut
 *     itself off (classic oscillation).
 *
 * ── How "the tank is full" is detected ────────────────────────────────────
 *
 * There is no usable high setpoint: the heater's own thermostat opens when the
 * water is hot. That shows up as the measured power collapsing from ~2.2 kW to
 * ~0 W while the relay is still closed. Sustained for `cutoffDelay`, that means
 * the tank is full → the relay opens and the cycle is recorded to refine the
 * learned duration. A `tankFull` latch then suppresses further heating until it
 * expires or the probe shows a real draw-off.
 *
 * The bottom probe alone cannot tell you the tank is full — stratification
 * means it can read cold while the top is at 60 °C. That is exactly why the
 * power signal is the primary sensor here and the probe only guards the floor.
 *
 * Everything degrades gracefully: no probe → no floor rescue; no power
 * measurement → cycles are bounded by the HC window and `maxCycle` instead of
 * by cut-off detection.
 */

// ============================================================
// Types (mirrored from Sowel core — recipe plugins don't import core)
// ============================================================

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type:
    | "zone"
    | "equipment"
    | "number"
    | "duration"
    | "time"
    | "boolean"
    | "text"
    | "data-key"
    | "select";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  options?: { value: string; label: string }[];
  hiddenWhen?: { slot: string; equals: string | string[] };
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
    crossZone?: boolean;
    includeDescendants?: boolean;
  };
  group?: string;
}

interface RecipeSlotI18n {
  name: string;
  description: string;
  options?: Record<string, string>;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, RecipeSlotI18n>;
  groups?: Record<string, string>;
}

interface RecipeActionDef {
  id: string;
  type: "cycle";
  stateKey: string;
  options: { value: string; label: string }[];
}

interface DataBindingLite {
  alias: string;
  value?: unknown;
  unit?: string;
  category?: string;
  enumValues?: string[];
  stale?: boolean;
  lastUpdated?: string | null;
}

interface OrderBindingLite {
  alias: string;
  type?: string;
  category?: string;
  enumValues?: string[];
}

interface EquipmentLite {
  id: string;
  name: string;
  type: string;
  status?: string;
  dataBindings: DataBindingLite[];
  orderBindings: OrderBindingLite[];
  computedData?: { alias: string; value: unknown }[];
}

interface RecipeStateStore {
  get(key: string): unknown | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  clear(): void;
}

interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getById(id: string): { id: string; name: string } | null;
    getByIdWithDetails(id: string): EquipmentLite | null;
  };
  zoneManager: { getById(id: string): { id: string; name: string } | null };
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
  state: RecipeStateStore;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    parseDuration(value: unknown): number;
    formatDuration(ms: number): string;
    /** Spec 138, Sowel ≥ 1.36 — absent on older cores, hence optional. */
    getTariff?(): {
      configured: boolean;
      offPeakToday: { start: string; end: string; tariff: string }[];
      isOffPeakNow: boolean | null;
    };
  };
  dispatchOrder(
    equipmentId: string,
    alias: string,
    value: unknown,
  ): Promise<{ success: boolean; error?: string } | void>;
}

interface RecipeInstanceHandle {
  stop(): void;
  onAction?(action: string, payload?: Record<string, unknown>): void;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  actions?: RecipeActionDef[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(params: Record<string, unknown>, ctx: RecipeContext): RecipeInstanceHandle;
}

// ============================================================
// Constants
// ============================================================

/** Reconciliation period. Everything (delays, cut-off, min on/off) is derived
 *  from the wall clock inside `evaluate()`, so the tick only has to be finer
 *  than the shortest delay we care about. */
const TICK_MS = 30_000;

/** After closing the relay, ignore the power reading for this long: a Zigbee
 *  plug takes a few seconds to report, and a cold resistor ramps up. */
const STARTUP_GRACE_MS = 90_000;

/** A relay state that disagrees with what we commanded is only treated as a
 *  human action after it has held this long (covers Zigbee round-trip lag). */
const MANUAL_CONFIRM_MS = 60_000;

/** How long the "tank is full" latch survives when nothing can corroborate it.
 *  Bounded so a stratified tank (cold probe, hot top) is re-probed instead of
 *  being locked out forever.
 *
 *  With a live probe the latch lives much longer — see `tankFullMemory`: a
 *  tank the sun filled at 15:00 is still hot at 02:00, and the probe is there
 *  to say so. Without one, two hours of blind trust is the ceiling. */
const TANK_FULL_TTL_MS = 2 * 60 * 60 * 1000;

/** Probe drop, in °C, that invalidates the `tankFull` latch — someone drew hot
 *  water, so the tank is no longer full whatever the latch says. */
const DRAW_OFF_DELTA_C = 3;

/**
 * Fraction of the nominal power the channel must reach for the recipe to
 * accept that it really is watching this heater.
 *
 * "Relay closed, no draw" has two readings: the thermostat is open (tank full)
 * or the channel isn't measuring the heater at all — a wrong binding, a dead
 * sensor, a relay that never closed. Within a single cycle they are
 * indistinguishable, so the recipe refuses to conclude until it has seen the
 * resistor pull *once*. After that the channel is proven and a collapse to
 * zero can be trusted, including on a cycle that starts already cut off.
 *
 * The asymmetry is deliberate: concluding "full" wrongly leaves the household
 * without hot water, while refusing to conclude only leaves a relay closed on
 * a circuit that is drawing nothing.
 */
const CUTOFF_MIN_PEAK_RATIO = 0.5;

/** Relay protection: never cycle faster than this. */
const MIN_ON_MS = 5 * 60 * 1000;
const MIN_OFF_MS = 10 * 60 * 1000;

/** Safety margin added to a measured cycle before it becomes the new estimate. */
const LEARN_MARGIN_MIN = 20;

/**
 * Shortest cycle that is allowed to teach the estimate.
 *
 * A top-up on an already-hot tank reaches the thermostat in minutes and says
 * nothing about how long a full heat-up takes — but `learnEstimate` cannot
 * tell the two apart from the duration alone, and smoothing a ten-minute
 * cycle in drags a three-hour estimate down by an hour. Two sunny days in a
 * row and the off-peak placement no longer covers a real heat-up. Cycles
 * below this floor are recorded as "tank full" and teach nothing.
 */
const LEARN_MIN_MEASURED_MIN = 30;

/** How much the estimate grows when a cycle ran out of window without ever
 *  reaching the thermostat cut-off. */
const LEARN_GROWTH_MIN = 45;

/** Exponential smoothing weight given to the newly measured cycle. */
const LEARN_ALPHA = 0.4;

const HEATER_TYPES = ["water_heater", "switch"];
const GRID_TYPES = ["main_energy_meter", "energy_meter"];
const PRODUCTION_TYPES = ["energy_production_meter", "solar_panel", "energy_meter"];

/** Aliases tried, in order, when reading an active-power channel off a meter. */
const POWER_ALIASES = ["power", "active_power", "power_total", "total_power", "p"];

type Reason = "floor" | "hc" | "solar" | "boost";
type Mode = "auto" | "boost" | "off";

// ============================================================
// Pure helpers (exported for tests)
// ============================================================

export function isValidHHMM(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function hmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToHm(total: number): string {
  const t = ((Math.round(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Inclusive-start, exclusive-end, wrapping over midnight. */
export function isWithinWindow(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true; // degenerate = 24 h
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

/** Length of a window in minutes, wrapping over midnight. 0 is read as 24 h. */
export function windowLength(startMin: number, endMin: number): number {
  const len = (endMin - startMin + 1440) % 1440;
  return len === 0 ? 1440 : len;
}

/**
 * Where inside the off-peak window the heating is actually allowed to run.
 *
 * `late` — the interesting one — pushes the cycle against the end of the
 * window so the tank finishes hot right when the window closes. The estimate
 * is clamped to the window: an estimate longer than the window simply means
 * "use the whole window".
 */
export function computeHcHeatWindow(
  hcStartMin: number,
  hcEndMin: number,
  mode: "late" | "early" | "full",
  estimateMin: number,
): { startMin: number; endMin: number } {
  const len = windowLength(hcStartMin, hcEndMin);
  const est = Math.max(1, Math.min(Math.round(estimateMin), len));
  if (mode === "full" || est >= len) return { startMin: hcStartMin, endMin: hcEndMin };
  if (mode === "early") return { startMin: hcStartMin, endMin: (hcStartMin + est) % 1440 };
  return { startMin: ((hcEndMin - est) % 1440 + 1440) % 1440, endMin: hcEndMin };
}

/**
 * Refine the learned full-heat duration.
 *
 * `completed` — the thermostat cut off, so `measuredMin` is a real full cycle:
 * smooth it in, plus a margin so the next placement starts slightly early.
 * `!completed` — the window ran out first, so we only know the truth is
 * *longer* than what we allowed: grow the estimate, never shrink it.
 */
export function learnEstimate(
  currentMin: number,
  measuredMin: number,
  completed: boolean,
  maxMin: number,
): number {
  if (!completed) return Math.min(Math.round(currentMin + LEARN_GROWTH_MIN), maxMin);
  const target = measuredMin + LEARN_MARGIN_MIN;
  const next = currentMin * (1 - LEARN_ALPHA) + target * LEARN_ALPHA;
  return Math.max(15, Math.min(Math.round(next), maxMin));
}

/**
 * Exportable surplus, in watts.
 *
 * `grid_injection` reads the main meter and flips the sign per the meter's
 * convention. The `selfDraw` term is the heater's own consumption, added back
 * because it is precisely the load we are deciding about: without it, closing
 * the relay eats the export and the next evaluation would reopen it.
 *
 * `production_only` has no such feedback (production is unaffected by the
 * heater), so `selfDraw` is ignored.
 */
/**
 * Pick the night window out of the instance's configured off-peak slots.
 *
 * A tariff may declare several HC slots (a night one plus a midday one, say).
 * This recipe drives a single bulk heat-up, so it takes the longest slot —
 * that is the one with room for a full tank. Ties keep the first declared.
 */
export function pickMainOffPeakSlot(
  slots: { start: string; end: string }[],
): { startMin: number; endMin: number } | null {
  let best: { startMin: number; endMin: number; len: number } | null = null;
  for (const s of slots) {
    if (!isValidHHMM(s.start) || !isValidHHMM(s.end)) continue;
    const startMin = hmToMinutes(s.start);
    const endMin = hmToMinutes(s.end);
    const len = windowLength(startMin, endMin);
    if (!best || len > best.len) best = { startMin, endMin, len };
  }
  return best ? { startMin: best.startMin, endMin: best.endMin } : null;
}

/**
 * Which binding carries a given reading on the heater.
 *
 * An explicit slot value always wins. Otherwise the conventional alias is
 * tried, then any binding of the right category — a vendor that names its
 * channel `active_power` or `temp` still works. Resolved on every read rather
 * than pinned at start, so a metering channel bound after the instance was
 * created is picked up without editing anything.
 */
export function resolveBindingAlias(
  bindings: { alias: string; category?: string }[],
  explicit: string,
  preferredAlias: string,
  category: string,
): string | null {
  if (explicit) return explicit;
  const byName = bindings.find((b) => b.alias === preferredAlias);
  if (byName) return byName.alias;
  return bindings.find((b) => b.category === category)?.alias ?? null;
}

export function computeSurplus(
  mode: "off" | "grid_injection" | "production_only",
  reading: number | null,
  gridSign: "import_positive" | "import_negative",
  selfDraw: number,
  productionW: number | null = null,
): number | null {
  if (mode === "off" || reading === null) return null;
  if (mode === "production_only") return reading;
  const exported = gridSign === "import_positive" ? -reading : reading;
  const surplus = exported + selfDraw;
  // Physical ceiling: without storage, a house cannot export more than it
  // produces. When a production meter is available this caps a mis-signed or
  // mis-wired grid clamp — the failure mode that would otherwise run 2.2 kW
  // off the grid at peak price.
  if (productionW === null) return surplus;
  return Math.min(surplus, productionW);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isOnValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").toUpperCase();
  return s === "ON" || s === "TRUE" || s === "1";
}

function nowMinutes(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

// ============================================================
// Slots
// ============================================================

const MODE_OPTIONS = [
  { value: "late", label: "End of window (recommended)" },
  { value: "early", label: "Start of window" },
  { value: "full", label: "Whole window" },
];

const SOLAR_OPTIONS = [
  { value: "off", label: "Disabled" },
  { value: "grid_injection", label: "Grid meter (export)" },
  { value: "production_only", label: "Production only" },
];

const SIGN_OPTIONS = [
  { value: "import_positive", label: "Import positive / export negative" },
  { value: "import_negative", label: "Import negative / export positive" },
];

/**
 * NOTE — `heater` must stay the FIRST non-list `equipment` slot: the recipe
 * form resolves every `data-key` slot against that one equipment.
 */
function buildSlots(): RecipeSlotDef[] {
  return [
    {
      id: "zone",
      name: "Zone",
      description: "Zone the water heater belongs to",
      type: "zone",
      required: true,
      group: "main",
    },
    {
      id: "heater",
      name: "Water heater",
      description: "On/off relay",
      type: "equipment",
      required: true,
      constraints: { equipmentType: HEATER_TYPES, crossZone: true, includeDescendants: true },
      group: "main",
    },
    {
      id: "tempKey",
      name: "Temp. reading",
      description: "Empty = found alone",
      type: "data-key",
      required: false,
      group: "main",
    },
    {
      id: "powerKey",
      name: "Power reading",
      description: "Empty = found alone",
      type: "data-key",
      required: false,
      group: "main",
    },
    {
      id: "heaterPower",
      name: "Heater power",
      description: "Resistor rating (W)",
      type: "number",
      required: false,
      defaultValue: 2200,
      constraints: { min: 300, max: 9000 },
      group: "main",
    },

    {
      id: "minTemp",
      name: "Rescue below",
      description: "Heats now (°C)",
      type: "number",
      required: false,
      defaultValue: 20,
      constraints: { min: 5, max: 70 },
      group: "floor",
    },
    {
      id: "tempMaxAge",
      name: "Probe stale",
      description: "Then ignored",
      type: "duration",
      required: false,
      defaultValue: "2h",
      group: "floor",
    },
    {
      id: "rescueTemp",
      name: "Rescue up to",
      description: "Ends there (°C)",
      type: "number",
      required: false,
      defaultValue: 25,
      constraints: { min: 5, max: 80 },
      group: "floor",
    },

    {
      id: "tankFullMemory",
      name: "Stays hot for",
      description: "Then heats again",
      type: "duration",
      required: false,
      defaultValue: "12h",
      group: "floor",
    },

    {
      id: "hcMode",
      name: "Placement",
      description: "Inside off-peak",
      type: "select",
      required: false,
      defaultValue: "late",
      options: MODE_OPTIONS,
      group: "hc",
    },
    {
      id: "hcEstimate",
      name: "First duration",
      description: "Learned from use",
      type: "duration",
      required: false,
      defaultValue: "4h",
      group: "hc",
    },
    {
      id: "fullCycleEveryDays",
      name: "Full cycle",
      description: "Every N days, 0 off",
      type: "number",
      required: false,
      defaultValue: 7,
      constraints: { min: 0, max: 30 },
      group: "hc",
    },

    {
      id: "solarMode",
      name: "Solar surplus",
      description: "How it is measured",
      type: "select",
      required: false,
      defaultValue: "off",
      options: SOLAR_OPTIONS,
      group: "solar",
    },
    {
      id: "gridEquipment",
      name: "Grid meter",
      description: "Utility feed",
      type: "equipment",
      required: false,
      constraints: { equipmentType: GRID_TYPES, crossZone: true },
      hiddenWhen: { slot: "solarMode", equals: ["off", "production_only"] },
      group: "solar",
    },
    {
      id: "gridSign",
      name: "Meter sign",
      description: "Export is + or −",
      type: "select",
      required: false,
      defaultValue: "import_positive",
      options: SIGN_OPTIONS,
      hiddenWhen: { slot: "solarMode", equals: ["off", "production_only"] },
      group: "solar",
    },
    {
      id: "productionEquipment",
      name: "PV meter",
      description: "Production reading",
      type: "equipment",
      required: false,
      constraints: { equipmentType: PRODUCTION_TYPES, crossZone: true },
      hiddenWhen: { slot: "solarMode", equals: "off" },
      group: "solar",
    },
    {
      id: "surplusStartPower",
      name: "Start (W)",
      description: "Minimum export",
      type: "number",
      required: false,
      defaultValue: 2500,
      constraints: { min: 0, max: 10000 },
      hiddenWhen: { slot: "solarMode", equals: "off" },
      group: "solar",
    },
    {
      id: "maxGridImport",
      name: "Stop (W)",
      description: "Maximum grid draw",
      type: "number",
      required: false,
      defaultValue: 200,
      constraints: { min: 0, max: 2000 },
      hiddenWhen: { slot: "solarMode", equals: "off" },
      group: "solar",
    },
    {
      id: "surplusStartDelay",
      name: "Start delay",
      description: "Surplus must hold",
      type: "duration",
      required: false,
      defaultValue: "3m",
      hiddenWhen: { slot: "solarMode", equals: "off" },
      group: "solar",
    },
    {
      id: "surplusStopDelay",
      name: "Stop delay",
      description: "Surplus stays off",
      type: "duration",
      required: false,
      defaultValue: "5m",
      hiddenWhen: { slot: "solarMode", equals: "off" },
      group: "solar",
    },

    {
      id: "cutoffPower",
      name: "Cut-off (W)",
      description: "Thermostat opened",
      type: "number",
      required: false,
      defaultValue: 300,
      constraints: { min: 10, max: 2000 },
      group: "advanced",
    },
    {
      id: "cutoffDelay",
      name: "Cut-off delay",
      description: "Before concluding",
      type: "duration",
      required: false,
      defaultValue: "5m",
      group: "advanced",
    },
    {
      id: "maxCycle",
      name: "Longest run",
      description: "Safety cap",
      type: "duration",
      required: false,
      defaultValue: "6h",
      group: "advanced",
    },
  ];
}

// ============================================================
// i18n
// ============================================================

const FR: RecipeLangPack = {
  name: "Chauffe-eau intelligent",
  description:
    "Pilote un chauffe-eau on/off : plancher d'eau chaude garanti, chauffe nocturne calée en fin d'heures creuses, et chauffe opportuniste sur surplus solaire. Détecte la coupure du thermostat du ballon via la chute de puissance.",
  slots: {
    zone: { name: "Zone", description: "Zone du chauffe-eau" },
    heater: { name: "Chauffe-eau", description: "Relais marche/arrêt" },
    tempKey: {
      name: "Mesure temp.",
      description: "Vide = trouvée seule",
    },
    powerKey: {
      name: "Mesure puiss.",
      description: "Vide = trouvée seule",
    },
    heaterPower: {
      name: "Puissance (W)",
      description: "Nominale résistance",
    },
    minTemp: {
      name: "Secours sous",
      description: "Chauffe aussitôt",
    },
    tempMaxAge: {
      name: "Sonde périmée",
      description: "Au-delà, ignorée",
    },
    rescueTemp: {
      name: "Secours à",
      description: "Fin du secours (°C)",
    },
    tankFullMemory: {
      name: "Reste chaud",
      description: "Puis réchauffe",
    },
    hcMode: {
      name: "Placement",
      description: "Dans la plage HC",
      options: {
        late: "Fin de plage (recommandé)",
        early: "Début de plage",
        full: "Toute la plage",
      },
    },
    hcEstimate: {
      name: "Durée initiale",
      description: "Affinée à l'usage",
    },
    fullCycleEveryDays: {
      name: "Cycle complet",
      description: "Tous les N jours",
    },
    solarMode: {
      name: "Surplus",
      description: "Méthode de mesure",
      options: {
        off: "Désactivé",
        grid_injection: "Compteur général (injection)",
        production_only: "Production seule",
      },
    },
    gridEquipment: { name: "Compteur EDF", description: "Arrivée générale" },
    gridSign: {
      name: "Signe compteur",
      description: "Injection + ou −",
      options: {
        import_positive: "Soutirage positif / injection négative",
        import_negative: "Soutirage négatif / injection positive",
      },
    },
    productionEquipment: {
      name: "Compteur PV",
      description: "Mesure de production",
    },
    surplusStartPower: {
      name: "Départ (W)",
      description: "Injection minimale",
    },
    maxGridImport: {
      name: "Arrêt (W)",
      description: "Soutirage maximal",
    },
    surplusStartDelay: {
      name: "Délai départ",
      description: "Surplus maintenu",
    },
    surplusStopDelay: {
      name: "Délai arrêt",
      description: "Surplus absent",
    },
    cutoffPower: {
      name: "Coupure (W)",
      description: "Thermostat ouvert",
    },
    cutoffDelay: {
      name: "Délai coupure",
      description: "Avant de conclure",
    },
    maxCycle: {
      name: "Chauffe maxi",
      description: "Garde-fou",
    },
  },
  groups: {
    main: "Équipement",
    floor: "Chauffe de secours (plus d'eau chaude)",
    hc: "Heures creuses",
    solar: "Surplus solaire",
    advanced: "Réglages avancés",
  },
};

// ============================================================
// Recipe definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "water-heater-smart",
    name: "Smart Water Heater",
    description:
      "Drives an on/off water heater: hot-water floor, off-peak night cycle placed just before the window ends, and opportunistic solar-surplus heating. Detects the tank thermostat cut-off from the power draw.",
    slots: buildSlots(),

    actions: [
      {
        id: "set_mode",
        type: "cycle",
        stateKey: "mode",
        options: [
          { value: "auto", label: "Auto" },
          { value: "boost", label: "Boost" },
          { value: "off", label: "Paused" },
        ],
      },
    ],

    i18n: { fr: FR },

    validate(params, ctx) {
      if (!params.zone) throw new Error("Zone is required");

      const heaterId = String(params.heater ?? "");
      if (!heaterId) throw new Error("A water heater equipment is required");

      const heater = ctx.equipmentManager.getByIdWithDetails(heaterId);
      if (!heater) throw new Error("The selected water heater no longer exists");
      if (!findOnOffOrderAlias(heater)) {
        throw new Error(`"${heater.name}" has no on/off order binding (expected alias "state")`);
      }

      // The off-peak hours are the instance's, full stop. They are configured
      // once under Settings → Administration → Energy tariff; letting the
      // recipe carry a second copy would mean two sources of truth that drift
      // apart silently. Fail here rather than at 3 a.m.
      const readTariff = ctx.helpers?.getTariff;
      if (typeof readTariff !== "function") {
        throw new Error(
          "This Sowel version does not expose the energy tariff to recipes. Sowel 1.36 or later is required.",
        );
      }
      let tariffConfigured = false;
      try {
        tariffConfigured = readTariff().configured;
      } catch {
        tariffConfigured = false;
      }
      if (!tariffConfigured) {
        throw new Error(
          "No energy tariff is configured. Fill Settings → Administration → Energy tariff and save it, then create this instance.",
        );
      }

      const minTemp = toNumber(params.minTemp) ?? 20;
      const rescueTemp = toNumber(params.rescueTemp) ?? 25;
      if (rescueTemp <= minTemp) {
        throw new Error("Recovery temperature must be above the minimum temperature");
      }

      // Only an alias the user typed can be wrong. Left empty, the binding is
      // discovered at runtime — and may legitimately not exist yet, so its
      // absence must not block creating the instance.
      for (const slot of ["tempKey", "powerKey"] as const) {
        const alias = String(params[slot] ?? "");
        if (alias && !heater.dataBindings.some((b) => b.alias === alias)) {
          throw new Error(`"${heater.name}" has no data binding with alias "${alias}"`);
        }
      }

      const solarMode = String(params.solarMode ?? "off");
      if (solarMode === "grid_injection" && !params.gridEquipment) {
        throw new Error("Grid-injection mode needs a grid meter");
      }
      if (solarMode === "production_only" && !params.productionEquipment) {
        throw new Error("Production-only mode needs a production meter");
      }

      // Both solar thresholds are absolute meter readings, so nothing stops a
      // user from picking a pair that contradicts itself. Starting at S watts
      // exported puts `heaterPower - S` watts on the grid the instant the relay
      // closes; if the tolerated draw does not strictly exceed that, the stop
      // condition is already true and the recipe would start and stop on every
      // cycle. Catch it here rather than let it wear out a contactor.
      if (solarMode !== "off") {
        const heaterPowerW = toNumber(params.heaterPower) ?? 2200;
        const startPower = toNumber(params.surplusStartPower) ?? 2500;
        const gridImport = toNumber(params.maxGridImport) ?? 200;
        const drawAtStart = heaterPowerW - startPower;
        if (gridImport <= drawAtStart) {
          throw new Error(
            `Starting at ${startPower} W exported draws ${drawAtStart} W from the grid with a ${heaterPowerW} W heater, ` +
              `which already meets the ${gridImport} W stop threshold — the heater would stop as soon as it starts. ` +
              `Raise the tolerated grid draw above ${drawAtStart} W, or raise the start threshold.`,
          );
        }
      }
    },

    createInstance(params, ctx): RecipeInstanceHandle {
      // ── Params ────────────────────────────────────────────

      const heaterId = String(params.heater);
      const tempOverride = String(params.tempKey ?? "").trim();
      const powerOverride = String(params.powerKey ?? "").trim();

      function tempAlias(): string | null {
        const eq = heaterEq();
        return eq
          ? resolveBindingAlias(eq.dataBindings, tempOverride, "water_temperature", "temperature")
          : null;
      }
      function powerAlias(): string | null {
        const eq = heaterEq();
        return eq ? resolveBindingAlias(eq.dataBindings, powerOverride, "power", "power") : null;
      }
      const heaterPowerW = toNumber(params.heaterPower) ?? 2200;

      const minTemp = toNumber(params.minTemp) ?? 20;
      const rescueTemp = toNumber(params.rescueTemp) ?? 25;
      const tempMaxAgeMs = ctx.helpers.parseDuration(params.tempMaxAge ?? "2h") || 2 * 3600_000;
      // How long a probe-corroborated "tank is full" is trusted. Clamped to at
      // least the blind TTL: a shorter value would make the probe a liability.
      const tankFullMemoryMs = Math.max(
        TANK_FULL_TTL_MS,
        ctx.helpers.parseDuration(params.tankFullMemory ?? "12h") || 12 * 3600_000,
      );

      const hcMode = (["late", "early", "full"] as const).includes(params.hcMode as never)
        ? (params.hcMode as "late" | "early" | "full")
        : "late";
      const fullCycleEveryDays = toNumber(params.fullCycleEveryDays) ?? 7;

      const solarMode = (["off", "grid_injection", "production_only"] as const).includes(
        params.solarMode as never,
      )
        ? (params.solarMode as "off" | "grid_injection" | "production_only")
        : "off";
      const gridId = params.gridEquipment ? String(params.gridEquipment) : null;
      const productionId = params.productionEquipment ? String(params.productionEquipment) : null;
      const gridSign =
        params.gridSign === "import_negative" ? "import_negative" : "import_positive";
      const surplusStartPower = toNumber(params.surplusStartPower) ?? 2500;
      const maxGridImport = toNumber(params.maxGridImport) ?? 200;
      const surplusStartMs = ctx.helpers.parseDuration(params.surplusStartDelay ?? "3m");
      const surplusStopMs = ctx.helpers.parseDuration(params.surplusStopDelay ?? "5m");

      const cutoffPower = toNumber(params.cutoffPower) ?? 300;
      const cutoffDelayMs = ctx.helpers.parseDuration(params.cutoffDelay ?? "5m");
      const maxCycleMs = ctx.helpers.parseDuration(params.maxCycle ?? "6h");

      const solarSourceId = solarMode === "grid_injection" ? gridId : productionId;

      // ── Volatile runtime state ────────────────────────────

      let stopped = false;
      let relayOn = false; // what *we* commanded
      let reason: Reason | null = null;
      let onSince: number | null = null;
      // Epoch, not `now`: the relay-protection lockout must not delay the very
      // first decision after an instance start or a param edit.
      let offSince = 0;
      let cycleStartedAt: number | null = null;

      let lowPowerSince: number | null = null;
      let cyclePeakPower = 0;
      /** Persisted: the power channel has been seen carrying the heater's draw. */
      let powerProven = false;
      let surplusOkSince: number | null = null;
      let surplusLowSince: number | null = null;
      let mismatchSince: number | null = null;
      let manualOn = false;

      let hcEstimateMin = 180;
      let tankFull = false;
      let tankFullAt: number | null = null;
      let tankFullTemp: number | null = null;
      let lastFullCycleAt: number | null = null;
      let mode: Mode = "auto";

      /** One-shot log guards, so a permanent condition doesn't spam the journal. */
      const warned = new Set<string>();
      function warnOnce(key: string, message: string): void {
        if (warned.has(key)) return;
        warned.add(key);
        ctx.log(message, "warn");
      }

      // ── Equipment reads ───────────────────────────────────

      function heaterEq(): EquipmentLite | null {
        return ctx.equipmentManager.getByIdWithDetails(heaterId);
      }

      function nameOf(id: string | null): string {
        if (!id) return "?";
        return ctx.equipmentManager.getById(id)?.name ?? id.slice(0, 8);
      }

      /**
       * `null` means "unusable" — missing, non-numeric, or too old.
       *
       * With `maxAgeMs`, freshness is judged on the binding's own age instead
       * of core's `stale` flag. That flag uses a 15 min window for the
       * `temperature` category, which is right for a room sensor and wrong for
       * a tank: several hundred litres of water do not change temperature
       * between two sparse reports from a battery probe. A reading two hours
       * old still says something true about the tank; a twelve-hour-old one
       * does not, and that is the distinction worth making.
       */
      function readNumeric(
        eq: EquipmentLite | null,
        alias: string,
        maxAgeMs?: number,
      ): number | null {
        if (!eq || !alias) return null;
        const b = eq.dataBindings.find((d) => d.alias === alias);
        if (b) {
          if (maxAgeMs === undefined) return b.stale === true ? null : toNumber(b.value);
          if (b.lastUpdated) {
            const t = Date.parse(b.lastUpdated.replace(" ", "T"));
            if (Number.isFinite(t) && Date.now() - t > maxAgeMs) return null;
          }
          return toNumber(b.value);
        }
        const c = eq.computedData?.find((d) => d.alias === alias);
        return c ? toNumber(c.value) : null;
      }

      function readFirstNumeric(eq: EquipmentLite | null, aliases: string[]): number | null {
        if (!eq) return null;
        for (const alias of aliases) {
          const b = eq.dataBindings.find((d) => d.alias === alias);
          if (b) return b.stale === true ? null : toNumber(b.value);
        }
        // Fall back to any binding carrying a power category (vendor alias).
        const byCategory = eq.dataBindings.find((d) => d.category === "power");
        if (byCategory) return byCategory.stale === true ? null : toNumber(byCategory.value);
        return null;
      }

      /** Actual relay state as reported by the device, or null when unknown. */
      function readRelayState(eq: EquipmentLite | null): boolean | null {
        if (!eq) return null;
        const alias = findOnOffOrderAlias(eq);
        const b =
          (alias ? eq.dataBindings.find((d) => d.alias === alias) : undefined) ??
          eq.dataBindings.find((d) => d.category === "light_state") ??
          eq.dataBindings.find((d) => d.alias === "state");
        if (!b || b.value === undefined || b.value === null) return null;
        return isOnValue(b.value);
      }

      // ── Orders ────────────────────────────────────────────

      function resolveOnOffValue(eq: EquipmentLite | null, target: "on" | "off"): unknown {
        const alias = eq ? findOnOffOrderAlias(eq) : null;
        const ob = alias ? eq?.orderBindings.find((o) => o.alias === alias) : undefined;
        if (ob?.enumValues?.length) {
          const match = ob.enumValues.find((v) => v.toLowerCase() === target);
          return match ?? target.toUpperCase();
        }
        if (ob?.type === "boolean") return target === "on";
        return target.toUpperCase();
      }

      async function sendRelay(target: "on" | "off"): Promise<boolean> {
        const eq = heaterEq();
        const alias = eq ? findOnOffOrderAlias(eq) : null;
        if (!eq || !alias) {
          warnOnce("no-order", `${nameOf(heaterId)} : aucun ordre marche/arrêt disponible`);
          return false;
        }
        try {
          const res = await ctx.dispatchOrder(heaterId, alias, resolveOnOffValue(eq, target));
          if (res && typeof res === "object" && res.success === false) {
            ctx.log(`Échec ordre ${target.toUpperCase()} : ${res.error ?? "erreur inconnue"}`, "error");
            return false;
          }
          return true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`Échec ordre ${target.toUpperCase()} : ${msg}`, "error");
          return false;
        }
      }

      // ── Tank-full latch ───────────────────────────────────

      const REASON_FR: Record<Reason, string> = {
        floor: "plancher",
        hc: "heures creuses",
        solar: "surplus solaire",
        boost: "boost",
      };

      /** `endedAt` is when the resistor actually stopped drawing — i.e. when the
       *  power collapsed, not when we finished confirming it. Feeding the
       *  detection delay into the learner would inflate every estimate by
       *  `cutoffDelay` and drift the off-peak placement earlier each night. */
      function markTankFull(temp: number | null, now: number, endedAt: number = now): void {
        tankFull = true;
        tankFullAt = now;
        tankFullTemp = temp;
        lastFullCycleAt = now;

        if (cycleStartedAt !== null) {
          const measured = Math.max(0, Math.round((endedAt - cycleStartedAt) / 60000));
          // A cycle only teaches when it plausibly started from a cold tank.
          // See LEARN_MIN_MEASURED_MIN: a top-up is short by definition, and
          // letting it in walks the estimate down until the off-peak placement
          // no longer covers a real heat-up.
          const teaches =
            (reason === "hc" || reason === "boost") && measured >= LEARN_MIN_MEASURED_MIN;
          if (teaches) {
            hcEstimateMin = learnEstimate(hcEstimateMin, measured, true, currentWindowMin());
          }
          ctx.log(
            `Ballon chaud — thermostat coupé après ${measured} min (${
              reason ? REASON_FR[reason] : "?"
            }). ${
              teaches
                ? `Estimation de chauffe : ${hcEstimateMin} min`
                : `Cycle trop court pour être représentatif — estimation inchangée (${hcEstimateMin} min)`
            }`,
          );
        } else {
          ctx.log("Ballon chaud — thermostat déjà coupé");
        }
        persist();
      }

      /**
       * The latch only holds while it is fresh *and* the probe hasn't dropped.
       *
       * "Fresh" depends on what can corroborate it. With a live probe reading
       * next to the temperature recorded at cut-off, the latch is checked
       * against reality on every tick — a puisage drops the bottom of the tank
       * by several degrees and clears it at once, and standing losses clear it
       * on their own after a few hours. That evidence is worth trusting for
       * `tankFullMemory` (12 h by default), which is what stops the recipe
       * from re-running a full off-peak cycle at 02:00 on a tank the sun
       * brought to the thermostat at 15:00.
       *
       * With no probe — or a probe gone stale, which is the same thing — there
       * is nothing to contradict the latch, so it expires blind after
       * `TANK_FULL_TTL_MS` exactly as before. The recipe would rather heat a
       * hot tank (the thermostat cuts it off in minutes) than skip a cycle on
       * an assumption nothing is checking.
       */
      function isTankFull(temp: number | null, now: number): boolean {
        if (!tankFull || tankFullAt === null) return false;
        const corroborated = temp !== null && tankFullTemp !== null;
        const ttl = corroborated ? tankFullMemoryMs : TANK_FULL_TTL_MS;
        if (now - tankFullAt > ttl) {
          tankFull = false;
          if (corroborated) {
            ctx.log(
              `Ballon chaud depuis ${ctx.helpers.formatDuration(
                now - tankFullAt,
              )} — mémoire expirée, chauffe de nouveau autorisée`,
            );
          }
          return false;
        }
        if (corroborated && (temp as number) <= (tankFullTemp as number) - DRAW_OFF_DELTA_C) {
          tankFull = false;
          ctx.log(`Puisage détecté (${(temp as number).toFixed(1)} °C) — ballon considéré non plein`);
          return false;
        }
        return true;
      }

      // ── Off-peak window ───────────────────────────────────

      /**
       * Where the off-peak hours come from.
       *
       * The instance already knows them: they are configured once under
       * Settings → Administration → Energy tariff and drive energy billing.
       * Asking for them again in slots duplicates configuration that then
       * drifts — change the tariff page and the recipe keeps the old hours.
       *
       * So `auto` reads `ctx.helpers.getTariff()` (Sowel ≥ 1.36, spec 138) and
       * falls back to the slots whenever that is unavailable: older core, no
       * tariff configured, or a day the schedule does not cover. Resolved on
       * every evaluation rather than cached at start, so an edit to the tariff
       * page takes effect without touching the instance.
       */
      type HcWindow = { startMin: number; endMin: number };

      /**
       * Tonight's off-peak window, or `null` when the instance has none today.
       *
       * The hours are the instance's own, read from the energy tariff on every
       * evaluation. The recipe deliberately keeps no copy of them: a second
       * place to enter the same hours is a second place for them to be wrong,
       * and the divergence would be invisible — the recipe would keep firing on
       * stale hours long after the tariff page changed.
       *
       * `null` disables off-peak heating for the day and says so. The floor and
       * solar reasons are unaffected, so the house still gets hot water.
       */
      function resolveHcWindow(): HcWindow | null {
        const read = ctx.helpers.getTariff;
        if (typeof read !== "function") {
          warnOnce(
            "no-tariff",
            "Cette version de Sowel n'expose pas le tarif aux recettes (1.36 minimum) — chauffe en heures creuses désactivée",
          );
          return null;
        }

        try {
          const tariff = read();
          if (!tariff.configured) {
            warnOnce(
              "no-tariff",
              "Aucun tarif configuré dans Sowel — chauffe en heures creuses désactivée. Renseigne Réglages → Administration → Tarif d'énergie et enregistre.",
            );
            return null;
          }
          const picked = pickMainOffPeakSlot(tariff.offPeakToday);
          if (!picked) {
            warnOnce(
              "no-slot-today",
              "Le tarif Sowel ne déclare aucune heure creuse aujourd'hui — pas de chauffe nocturne pour cette journée",
            );
            return null;
          }
          warned.delete("no-tariff");
          warned.delete("no-slot-today");
          if (tariff.offPeakToday.length > 1) {
            warnOnce(
              "multi-slot",
              `${tariff.offPeakToday.length} plages d'heures creuses configurées — la recette utilise la plus longue (${minutesToHm(
                picked.startMin,
              )}→${minutesToHm(picked.endMin)})`,
            );
          }
          return picked;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          warnOnce(
            "tariff-read-failed",
            `Lecture du tarif Sowel impossible (${msg}) — chauffe en heures creuses désactivée`,
          );
          return null;
        }
      }

      /** Ceiling the learned duration is clamped to. With no window there are
       *  no off-peak cycles to learn from, so the bound is nominal. */
      function currentWindowMin(): number {
        const w = resolveHcWindow();
        return w ? windowLength(w.startMin, w.endMin) : 1440;
      }

      /** Logged once per change so the journal shows which hours are in force. */
      let lastWindowLabel: string | null = null;
      function announceWindow(w: HcWindow | null): void {
        const label = w ? `${minutesToHm(w.startMin)}→${minutesToHm(w.endMin)}` : "aucune";
        if (label === lastWindowLabel) return;
        if (lastWindowLabel !== null) ctx.log(`Heures creuses : ${label}`);
        lastWindowLabel = label;
        ctx.state.set("hcWindowToday", label);
      }

      // ── Off-peak placement ────────────────────────────────

      /** A forced full cycle (anti-legionella) overrides the placement for the
       *  night: use the whole window so the thermostat is certain to be reached. */
      function needsFullCycle(now: number): boolean {
        if (fullCycleEveryDays <= 0) return false;
        if (lastFullCycleAt === null) return true;
        return now - lastFullCycleAt > fullCycleEveryDays * 24 * 60 * 60 * 1000;
      }

      function hcHeatWindow(now: number): { startMin: number; endMin: number } | null {
        const w = resolveHcWindow();
        announceWindow(w);
        if (!w) return null;
        const effective = needsFullCycle(now) ? "full" : hcMode;
        return computeHcHeatWindow(w.startMin, w.endMin, effective, hcEstimateMin);
      }

      // ── Decision ──────────────────────────────────────────

      interface Snapshot {
        now: number;
        nowMin: number;
        temp: number | null;
        power: number | null;
        surplus: number | null;
        inHc: boolean;
        inHcHeat: boolean;
      }

      function snapshot(date: Date): Snapshot {
        const now = date.getTime();
        const eq = heaterEq();
        const tKey = tempAlias();
        const temp = tKey ? readNumeric(eq, tKey, tempMaxAgeMs) : null;
        // Power keeps core's `stale` rule (2 min for the category): cut-off
        // detection is only meaningful on a live reading.
        const pKey = powerAlias();
        const power = pKey ? readNumeric(eq, pKey) : null;

        if (tKey) {
          if (temp === null) {
            warnOnce(
              "temp-stale",
              `Sonde "${tKey}" muette depuis plus de ${ctx.helpers.formatDuration(
                tempMaxAgeMs,
              )} — chauffe de secours suspendue jusqu'à son retour`,
            );
          } else {
            warned.delete("temp-stale");
          }
        }

        // The heater's own draw is added back whatever the reason it is
        // running: `surplus` means "the export the meter would show with this
        // heater off", and that statement does not depend on why the relay is
        // closed. Restricting it to solar cycles made the surplus read as zero
        // during an off-peak or floor run, so the recipe could not see a
        // hand-over coming and dropped the relay for a full MIN_OFF before
        // picking the same heat back up on the sun.
        const selfDraw = relayOn
          ? power !== null && power > cutoffPower
            ? power
            : heaterPowerW
          : 0;
        const raw = solarSourceId
          ? readFirstNumeric(ctx.equipmentManager.getByIdWithDetails(solarSourceId), POWER_ALIASES)
          : null;
        // In grid_injection mode a production meter is optional but valuable:
        // it turns an un-verifiable sign convention into a bounded one.
        const productionW =
          solarMode === "grid_injection" && productionId
            ? readFirstNumeric(ctx.equipmentManager.getByIdWithDetails(productionId), POWER_ALIASES)
            : null;
        const surplus = computeSurplus(solarMode, raw, gridSign, selfDraw, productionW);

        if (productionW !== null && raw !== null) {
          const uncapped = (gridSign === "import_positive" ? -raw : raw) + selfDraw;
          if (uncapped > productionW + heaterPowerW) {
            warnOnce(
              "sign-suspect",
              `Injection annoncée (${Math.round(uncapped)} W) très supérieure à la production (${Math.round(
                productionW,
              )} W) — convention de signe du compteur probablement inversée. Surplus plafonné à la production.`,
            );
          }
        }

        const nMin = nowMinutes(date);
        const hcWindow = resolveHcWindow();
        const heat = hcHeatWindow(now);
        return {
          now,
          nowMin: nMin,
          temp,
          power,
          surplus,
          inHc: hcWindow !== null && isWithinWindow(nMin, hcWindow.startMin, hcWindow.endMin),
          inHcHeat: heat !== null && isWithinWindow(nMin, heat.startMin, heat.endMin),
        };
      }

      /**
       * Surplus hysteresis. Both edges are time-confirmed so a passing cloud or
       * a kettle doesn't toggle a 2.2 kW relay.
       */
      function surplusWantsHeat(s: Snapshot): boolean {
        if (solarMode === "off" || s.surplus === null) {
          surplusOkSince = null;
          surplusLowSince = null;
          return false;
        }
        // Both thresholds are expressed in meter watts, the way a user reads
        // them off the grid meter — start above N watts exported, stop above M
        // watts imported. Neither is a margin relative to the heater.
        //
        // `surplus` is the export the meter WOULD show with the heater off: it
        // already has the heater's own draw added back. So while the heater is
        // off it is the raw export, and comparing it to `surplusStartPower`
        // directly is exactly "we are exporting at least that much".
        //
        // Stopping is the same statement mirrored: `heaterPowerW - surplus` is
        // the watts currently coming off the grid, so stopping below
        // `heaterPowerW - maxGridImport` means "the grid supplies more than
        // tolerated". Keeping the two independent matters — a single symmetric
        // margin would tie being picky about starting to tolerating imports,
        // i.e. buying power at peak price under the name of solar surplus.
        //
        // The two are only coherent if `surplusStartPower + maxGridImport`
        // exceeds `heaterPowerW`; otherwise starting instantly satisfies the
        // stop condition. `validate()` rejects that at configuration time.
        const startAt = surplusStartPower;
        const stopAt = heaterPowerW - maxGridImport;

        if (relayOn && reason === "solar") {
          if (s.surplus < stopAt) {
            surplusLowSince ??= s.now;
            return s.now - surplusLowSince < surplusStopMs;
          }
          surplusLowSince = null;
          return true;
        }

        if (s.surplus >= startAt) {
          surplusOkSince ??= s.now;
          return s.now - surplusOkSince >= surplusStartMs;
        }
        surplusOkSince = null;
        return false;
      }

      function decide(s: Snapshot): Reason | null {
        // Evaluated unconditionally so the hysteresis timers keep tracking even
        // on ticks where a higher-priority reason short-circuits the decision —
        // otherwise a stale "surplus has been fine for 3 min" would fire the
        // moment the floor or the off-peak cycle releases the relay.
        const solarOk = surplusWantsHeat(s);

        if (mode === "off") return null;

        // 1. Hot-water floor — the only reason that ignores the tank-full latch
        //    being *absent*; it still yields to it, because a stratified tank
        //    reads cold at the bottom while the thermostat is already open.
        if (s.temp !== null && !isTankFull(s.temp, s.now)) {
          if (s.temp < minTemp) return "floor";
          if (reason === "floor" && relayOn && s.temp < rescueTemp) return "floor";
        }

        if (mode === "boost") {
          if (isTankFull(s.temp, s.now)) {
            mode = "auto";
            ctx.log("Boost terminé — ballon chaud, retour en automatique");
          } else {
            return "boost";
          }
        }

        if (isTankFull(s.temp, s.now)) return null;

        // 2. Off-peak bulk heating.
        if (s.inHc && s.inHcHeat) return "hc";

        // 3. Free energy — everywhere the off-peak cycle is not already
        //    running. The guard used to be `!s.inHc`, which silently disabled
        //    solar heating across the whole off-peak window. That is harmless
        //    on a night window and wrong on a daytime one: the Enedis
        //    afternoon HC slots sit squarely in the production hours, and
        //    refusing free watts there to wait for cheap ones is backwards.
        //    Reaching this line already means we are outside the placement
        //    sub-window, so the two reasons cannot fight over the relay.
        if (solarOk) return "solar";

        return null;
      }

      // ── Reconciliation ────────────────────────────────────

      async function apply(desired: Reason | null, s: Snapshot): Promise<void> {
        if (manualOn) return; // a human is in charge, stay out of the way

        if (desired !== null && !relayOn) {
          if (s.now - offSince < MIN_OFF_MS) return;
          if (!(await sendRelay("on"))) return;
          relayOn = true;
          reason = desired;
          onSince = s.now;
          cycleStartedAt = s.now;
          lowPowerSince = null;
          cyclePeakPower = 0;
          ctx.log(`Chauffe démarrée (${REASON_FR[desired]})`);
          return;
        }

        if (desired === null && relayOn) {
          if (onSince !== null && s.now - onSince < MIN_ON_MS) return;
          const previous = reason;
          // An off-peak cycle that ran until the window closed without ever
          // reaching the cut-off only tells us the estimate was too short —
          // grow it, never shrink it. A stop for any other cause (pause, manual,
          // tank full) says nothing about the duration and must not teach.
          // `powerProven` is required: without a channel that has demonstrably
          // seen the heater, "the window closed before the cut-off" is not a
          // fact — the cut-off may simply be invisible. Growing on that would
          // walk the estimate up to the whole window night after night and
          // heat until 6 am for nothing.
          // Without a proven metering channel the thermostat cut-off can never
          // be observed, so `lastFullCycleAt` would stay null forever and the
          // periodic full cycle would be "due" every single night — pinning the
          // window wide open and defeating the late placement. A cycle that ran
          // the whole off-peak window is the best evidence available that the
          // tank was filled; record it as such.
          if (previous === "hc" && !s.inHcHeat && cycleStartedAt !== null && !powerProven) {
            lastFullCycleAt = s.now;
          }
          if (
            previous === "hc" &&
            !tankFull &&
            !s.inHcHeat &&
            cycleStartedAt !== null &&
            powerAlias() !== null &&
            powerProven
          ) {
            hcEstimateMin = learnEstimate(hcEstimateMin, 0, false, currentWindowMin());
            ctx.log(
              `Fin de plage sans coupure du thermostat — estimation portée à ${hcEstimateMin} min`,
            );
          }
          if (!(await sendRelay("off"))) return;
          // A whole cycle with the relay closed and no heating-level draw ever
          // seen is a wiring/binding problem, not a hot tank — say so.
          if (powerAlias() && !powerProven && onSince !== null && s.now - onSince > STARTUP_GRACE_MS) {
            warnOnce(
              "peak-never-seen",
              `La mesure "${powerAlias()}" n'a jamais dépassé ${Math.round(
                cyclePeakPower,
              )} W pendant la chauffe (attendu ≈ ${heaterPowerW} W) — détection de coupure inactive tant qu'elle n'a pas vu le chauffe-eau consommer`,
            );
          }
          relayOn = false;
          reason = null;
          onSince = null;
          cycleStartedAt = null;
          lowPowerSince = null;
          cyclePeakPower = 0;
          offSince = s.now;
          ctx.log(`Chauffe arrêtée (${previous ? REASON_FR[previous] : "?"})`);
          return;
        }

        if (desired !== null && relayOn && reason !== desired) {
          ctx.log(
            `Motif de chauffe : ${reason ? REASON_FR[reason] : "?"} → ${REASON_FR[desired]}`,
          );
          reason = desired;
        }
      }

      /**
       * Compare what the device reports with what we commanded. A durable
       * disagreement is a human at the switch — respect it rather than fight it.
       */
      function reconcileManual(s: Snapshot): void {
        const actual = readRelayState(heaterEq());
        if (actual === null) return;

        if (actual === relayOn) {
          mismatchSince = null;
          if (manualOn && !actual) {
            manualOn = false;
            ctx.log("Reprise du pilotage automatique");
          }
          return;
        }

        mismatchSince ??= s.now;
        if (s.now - mismatchSince < MANUAL_CONFIRM_MS) return;
        mismatchSince = null;

        if (actual) {
          manualOn = true;
          warned.delete("manual-off");
          ctx.log("Chauffe-eau allumé manuellement — la recette n'interfère pas", "warn");
        } else {
          relayOn = false;
          reason = null;
          onSince = null;
          cycleStartedAt = null;
          offSince = s.now;
          ctx.log("Chauffe-eau éteint hors recette — état resynchronisé", "warn");
        }
      }

      /**
       * Thermostat cut-off: relay closed, warm-up grace elapsed, no draw.
       *
       * The cycle peak gates the whole thing. "Tank full" is only credible as
       * the *end* of a draw we actually witnessed — a channel that never rose
       * to heating levels is measuring something other than this heater, and
       * concluding "full" from it would wedge the recipe into doing nothing.
       */
      function detectCutoff(s: Snapshot): void {
        if (!relayOn || onSince === null) {
          lowPowerSince = null;
          cyclePeakPower = 0;
          return;
        }
        if (s.power === null) return;
        if (s.power > cyclePeakPower) cyclePeakPower = s.power;
        if (!powerProven && cyclePeakPower >= heaterPowerW * CUTOFF_MIN_PEAK_RATIO) {
          powerProven = true;
          ctx.state.set("powerProven", true);
          ctx.log(
            `Mesure "${powerAlias()}" validée — ${Math.round(cyclePeakPower)} W observés en chauffe`,
          );
        }
        if (s.now - onSince < STARTUP_GRACE_MS) return;
        if (!powerProven) {
          lowPowerSince = null;
          return;
        }

        if (s.power >= cutoffPower) {
          lowPowerSince = null;
          return;
        }
        lowPowerSince ??= s.now;
        if (s.now - lowPowerSince >= cutoffDelayMs) {
          const collapsedAt = lowPowerSince;
          lowPowerSince = null;
          markTankFull(s.temp, s.now, collapsedAt);
        }
      }

      function enforceMaxCycle(s: Snapshot): boolean {
        if (!relayOn || onSince === null) return false;
        if (s.now - onSince < maxCycleMs) return false;
        ctx.log(
          `Garde-fou : ${ctx.helpers.formatDuration(maxCycleMs)} de chauffe continue, arrêt forcé`,
          "warn",
        );
        return true;
      }

      let evaluating = false;
      async function evaluate(): Promise<void> {
        if (stopped || evaluating) return;
        evaluating = true;
        try {
          const s = snapshot(new Date());
          reconcileManual(s);
          detectCutoff(s);

          const desired = enforceMaxCycle(s) ? null : decide(s);
          await apply(desired, s);
          publish(s);
        } catch (err: unknown) {
          ctx.logger.error({ err }, "water-heater-smart evaluate failed");
        } finally {
          evaluating = false;
        }
      }

      // ── Persisted state (survives restarts and param edits) ──

      function persist(): void {
        ctx.state.set("relayOn", relayOn);
        ctx.state.set("reason", reason);
        ctx.state.set("onSince", onSince ? new Date(onSince).toISOString() : null);
        ctx.state.set("tankFull", tankFull);
        ctx.state.set("tankFullAt", tankFullAt ? new Date(tankFullAt).toISOString() : null);
        ctx.state.set("tankFullTemp", tankFullTemp);
        ctx.state.set("hcEstimateMin", hcEstimateMin);
        ctx.state.set(
          "lastFullCycleAt",
          lastFullCycleAt ? new Date(lastFullCycleAt).toISOString() : null,
        );
        ctx.state.set("mode", mode);
        ctx.state.set("powerProven", powerProven);
      }

      function publish(s: Snapshot): void {
        const heat = hcHeatWindow(s.now);
        ctx.state.set("status", relayOn ? "heating" : manualOn ? "manual" : "off");
        ctx.state.set("reason", reason);
        ctx.state.set("mode", mode);
        ctx.state.set("temp", s.temp);
        ctx.state.set("power", s.power);
        ctx.state.set("surplus", s.surplus);
        // The thresholds are derived, not typed: without them on screen the
        // only way to answer "why didn't it start?" is to redo the arithmetic
        // by hand. `surplus` next to `solarStartAt` answers it at a glance.
        ctx.state.set("solarStartAt", solarMode === "off" ? null : surplusStartPower);
        ctx.state.set("solarStopAt", solarMode === "off" ? null : heaterPowerW - maxGridImport);
        ctx.state.set("tankFull", tankFull);
        // Without the expiry on screen, a skipped off-peak cycle looks like a
        // recipe that stopped working. It is the single most surprising thing
        // the hot-tank memory does, so it says when it ends.
        ctx.state.set(
          "tankFullUntil",
          tankFull && tankFullAt !== null
            ? new Date(
                tankFullAt + (tankFullTemp !== null ? tankFullMemoryMs : TANK_FULL_TTL_MS),
              ).toISOString()
            : null,
        );
        ctx.state.set(
          "hcWindow",
          heat ? `${minutesToHm(heat.startMin)} → ${minutesToHm(heat.endMin)}` : null,
        );
        ctx.state.set("hcEstimateMin", hcEstimateMin);
        ctx.state.set("relayOn", relayOn);
        ctx.state.set("onSince", onSince ? new Date(onSince).toISOString() : null);
        ctx.state.set(
          "lastFullCycleAt",
          lastFullCycleAt ? new Date(lastFullCycleAt).toISOString() : null,
        );
      }

      function restore(): void {
        const num = (key: string): number | null => toNumber(ctx.state.get(key));
        const time = (key: string): number | null => {
          const raw = ctx.state.get(key);
          if (typeof raw !== "string") return null;
          const t = Date.parse(raw);
          return Number.isFinite(t) ? t : null;
        };

        relayOn = ctx.state.get("relayOn") === true;
        const storedReason = ctx.state.get("reason");
        reason =
          typeof storedReason === "string" &&
          (["floor", "hc", "solar", "boost"] as string[]).includes(storedReason)
            ? (storedReason as Reason)
            : null;
        onSince = time("onSince");
        if (relayOn && onSince === null) onSince = Date.now();
        cycleStartedAt = relayOn ? onSince : null;

        tankFull = ctx.state.get("tankFull") === true;
        tankFullAt = time("tankFullAt");
        tankFullTemp = num("tankFullTemp");
        lastFullCycleAt = time("lastFullCycleAt");

        const storedEstimate = num("hcEstimateMin");
        hcEstimateMin =
          storedEstimate !== null && storedEstimate > 0
            ? Math.min(storedEstimate, currentWindowMin())
            : Math.min(
                Math.max(15, Math.round(ctx.helpers.parseDuration(params.hcEstimate ?? "4h") / 60000)),
                currentWindowMin(),
              );

        powerProven = ctx.state.get("powerProven") === true;

        const storedMode = ctx.state.get("mode");
        mode = storedMode === "boost" || storedMode === "off" ? storedMode : "auto";
      }

      // ── Start ─────────────────────────────────────────────

      restore();

      const unsubs: Array<() => void> = [];
      const watched = new Map<string, Set<string>>();
      // The heater's own aliases are resolved per read, so accept any of its
      // changes rather than pinning a set that a later binding would miss.
      watched.set(heaterId, new Set<string>());
      if (solarSourceId) watched.set(solarSourceId, new Set(POWER_ALIASES));

      unsubs.push(
        ctx.eventBus.onType("equipment.data.changed", (event) => {
          const eqId = String(event.equipmentId ?? "");
          const aliases = watched.get(eqId);
          // The heater's own relay state can be reported under any alias, so
          // don't filter it out; only the solar source is alias-filtered.
          if (!aliases) return;
          if (eqId === solarSourceId && !aliases.has(String(event.alias ?? ""))) return;
          void evaluate();
        }),
      );

      const ticker = setInterval(() => void evaluate(), TICK_MS);

      const heaterName = nameOf(heaterId);
      const startupWindow = resolveHcWindow();
      announceWindow(startupWindow);
      const capabilities = [
        tempAlias() ? `sonde ${tempAlias()}` : "sans sonde (chauffe de secours désactivée)",
        powerAlias()
          ? `puissance ${powerAlias()}`
          : "sans mesure de puissance (détection de coupure désactivée)",
        solarMode === "off" ? "sans solaire" : `solaire ${solarMode} via ${nameOf(solarSourceId)}`,
      ].join(", ");
      ctx.log(
        `Recette démarrée sur ${heaterName} — HC ${
          startupWindow
            ? `${minutesToHm(startupWindow.startMin)}→${minutesToHm(startupWindow.endMin)} (${hcMode})`
            : "indisponible"
        }, plancher ${minTemp}→${rescueTemp} °C, ${capabilities}`,
      );
      if (!tempAlias()) {
        warnOnce(
          "no-temp",
          "Aucune sonde de température trouvée sur le chauffe-eau : la chauffe de secours est inactive, la recette ne fera que les heures creuses et le solaire",
        );
      }
      if (!powerAlias()) {
        warnOnce(
          "no-power",
          "Aucune mesure de puissance : impossible de détecter la coupure du thermostat, les cycles seront bornés par la plage horaire et la durée maximale",
        );
      }

      void evaluate();

      return {
        stop(): void {
          stopped = true;
          clearInterval(ticker);
          for (const u of unsubs) {
            try {
              u();
            } catch {
              /* unsubscribe must never throw during teardown */
            }
          }
          unsubs.length = 0;
          // The relay is deliberately left as-is: an instance restart (recipe
          // update, param edit) must not interrupt a heat-up. `restore()` picks
          // the cycle back up from persisted state.
          persist();
          ctx.log("Recette arrêtée");
        },

        onAction(action: string, payload?: Record<string, unknown>): void {
          if (action !== "set_mode") return;
          const next = String(payload?.mode ?? "");
          if (next !== "auto" && next !== "boost" && next !== "off") return;
          if (next === mode) return;
          mode = next;
          if (mode === "boost") {
            // A boost is an explicit "I need hot water now" — drop the latch so
            // the tank is re-probed instead of being skipped.
            tankFull = false;
            tankFullAt = null;
            surplusOkSince = null;
          }
          ctx.log(
            mode === "boost"
              ? "Boost demandé — chauffe jusqu'à coupure du thermostat"
              : mode === "off"
                ? "Recette en pause — plus aucun ordre envoyé"
                : "Retour en automatique",
          );
          persist();
          void evaluate();
        },
      };
    },
  };
}

// ============================================================
// Shared equipment probing
// ============================================================

/** The on/off channel of a relay: `state` by convention, then the toggle
 *  category, then any ON/OFF enum (Tasmota-style `power1`). */
export function findOnOffOrderAlias(eq: EquipmentLite | null): string | null {
  const orders = eq?.orderBindings ?? [];
  const byName = orders.find((o) => o.alias === "state");
  if (byName) return byName.alias;
  const byCategory = orders.find((o) => o.category === "light_toggle");
  if (byCategory) return byCategory.alias;
  const byEnum = orders.find(
    (o) =>
      o.enumValues?.some((v) => v.toUpperCase() === "ON") &&
      o.enumValues?.some((v) => v.toUpperCase() === "OFF"),
  );
  if (byEnum) return byEnum.alias;
  const byBoolean = orders.find((o) => o.type === "boolean");
  return byBoolean?.alias ?? null;
}
