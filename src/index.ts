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
 *     When the house exports more than the heater draws, heat. The control law
 *     adds the heater's own draw back into the surplus while it is running,
 *     otherwise the export collapses to zero the second the relay closes and
 *     the recipe would immediately cut itself off (classic oscillation).
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
  helpers: { parseDuration(value: unknown): number; formatDuration(ms: number): string };
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

/** How long the "tank is full" latch survives without any other evidence.
 *  Bounded so a stratified tank (cold probe, hot top) is re-probed instead of
 *  being locked out forever. */
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
      description: "On/off relay driving the water heater",
      type: "equipment",
      required: true,
      constraints: { equipmentType: HEATER_TYPES, crossZone: true, includeDescendants: true },
      group: "main",
    },
    {
      id: "tempKey",
      name: "Temperature reading",
      description: "Bottom-of-tank probe binding. Leave empty to disable the hot-water floor.",
      type: "data-key",
      required: false,
      defaultValue: "water_temperature",
      group: "main",
    },
    {
      id: "powerKey",
      name: "Power reading",
      description:
        "Heater power binding, used to detect the tank thermostat cut-off. Leave empty if the relay has no metering.",
      type: "data-key",
      required: false,
      defaultValue: "power",
      group: "main",
    },
    {
      id: "heaterPower",
      name: "Heater power (W)",
      description: "Nominal draw of the resistor, used to size the solar surplus",
      type: "number",
      required: false,
      defaultValue: 2200,
      constraints: { min: 300, max: 9000 },
      group: "main",
    },

    {
      id: "minTemp",
      name: "Minimum temperature (°C)",
      description: "Below this the heater runs immediately, whatever the tariff",
      type: "number",
      required: false,
      defaultValue: 20,
      constraints: { min: 5, max: 70 },
      group: "floor",
    },
    {
      id: "tempMaxAge",
      name: "Probe maximum age",
      description:
        "Beyond this, the probe reading is ignored and the floor is suspended. A tank changes slowly, so a sparse probe is still usable.",
      type: "duration",
      required: false,
      defaultValue: "2h",
      group: "floor",
    },
    {
      id: "rescueTemp",
      name: "Recovery temperature (°C)",
      description: "A rescue heat-up stops here. Must be above the minimum.",
      type: "number",
      required: false,
      defaultValue: 25,
      constraints: { min: 5, max: 80 },
      group: "floor",
    },

    {
      id: "hcStart",
      name: "Off-peak start",
      description: "Beginning of the cheap-tariff window",
      type: "time",
      required: true,
      defaultValue: "22:00",
      group: "hc",
    },
    {
      id: "hcEnd",
      name: "Off-peak end",
      description: "End of the cheap-tariff window",
      type: "time",
      required: true,
      defaultValue: "06:00",
      group: "hc",
    },
    {
      id: "hcMode",
      name: "Cycle placement",
      description:
        "Where the night cycle sits inside the window. End of window keeps the water hottest at wake-up.",
      type: "select",
      required: false,
      defaultValue: "late",
      options: MODE_OPTIONS,
      group: "hc",
    },
    {
      id: "hcEstimate",
      name: "Initial full-heat duration",
      description:
        "Starting guess for a full heat-up. Refined after each cycle once the power channel is proven — until then it is used as-is, so err on the generous side: overshooting only means the tank thermostat regulates for a while, undershooting means lukewarm water.",
      type: "duration",
      required: false,
      defaultValue: "4h",
      group: "hc",
    },
    {
      id: "fullCycleEveryDays",
      name: "Force a full cycle every (days)",
      description:
        "Guarantees a periodic heat-up to the thermostat cut-off (anti-legionella). 0 disables it.",
      type: "number",
      required: false,
      defaultValue: 7,
      constraints: { min: 0, max: 30 },
      group: "hc",
    },

    {
      id: "solarMode",
      name: "Solar surplus",
      description: "How the exportable surplus is measured",
      type: "select",
      required: false,
      defaultValue: "off",
      options: SOLAR_OPTIONS,
      group: "solar",
    },
    {
      id: "gridEquipment",
      name: "Grid meter",
      description: "Main meter measuring the utility feed",
      type: "equipment",
      required: false,
      constraints: { equipmentType: GRID_TYPES, crossZone: true },
      hiddenWhen: { slot: "solarMode", equals: ["off", "production_only"] },
      group: "solar",
    },
    {
      id: "gridSign",
      name: "Grid meter sign",
      description: "Sign convention of the grid meter's power reading",
      type: "select",
      required: false,
      defaultValue: "import_positive",
      options: SIGN_OPTIONS,
      hiddenWhen: { slot: "solarMode", equals: ["off", "production_only"] },
      group: "solar",
    },
    {
      id: "productionEquipment",
      name: "Production meter",
      description:
        "Photovoltaic production. Required in production-only mode; in grid-meter mode it is an optional safety cap — export can never exceed production.",
      type: "equipment",
      required: false,
      constraints: { equipmentType: PRODUCTION_TYPES, crossZone: true },
      hiddenWhen: { slot: "solarMode", equals: "off" },
      group: "solar",
    },
    {
      id: "surplusMargin",
      name: "Surplus margin (W)",
      description:
        "Start above heater power + margin, stop below heater power − margin. Widen it to avoid chattering.",
      type: "number",
      required: false,
      defaultValue: 200,
      constraints: { min: 0, max: 3000 },
      hiddenWhen: { slot: "solarMode", equals: "off" },
      group: "solar",
    },
    {
      id: "surplusStartDelay",
      name: "Surplus confirmation delay",
      description: "Surplus must hold this long before the heater starts",
      type: "duration",
      required: false,
      defaultValue: "3m",
      hiddenWhen: { slot: "solarMode", equals: "off" },
      group: "solar",
    },
    {
      id: "surplusStopDelay",
      name: "Surplus loss delay",
      description: "Surplus must stay lost this long before the heater stops (rides out clouds)",
      type: "duration",
      required: false,
      defaultValue: "5m",
      hiddenWhen: { slot: "solarMode", equals: "off" },
      group: "solar",
    },

    {
      id: "cutoffPower",
      name: "Cut-off threshold (W)",
      description: "Power below this while the relay is closed means the tank thermostat opened",
      type: "number",
      required: false,
      defaultValue: 300,
      constraints: { min: 10, max: 2000 },
      group: "advanced",
    },
    {
      id: "cutoffDelay",
      name: "Cut-off confirmation delay",
      description: "Raise it if the meter reports power slowly",
      type: "duration",
      required: false,
      defaultValue: "5m",
      group: "advanced",
    },
    {
      id: "maxCycle",
      name: "Maximum continuous run",
      description:
        "Hard safety cap on a single uninterrupted heat-up. Keep it above the full-heat duration, or it will cut a legitimate off-peak cycle short.",
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
    heater: { name: "Chauffe-eau", description: "Relais marche/arrêt qui pilote le chauffe-eau" },
    tempKey: {
      name: "Mesure de température",
      description:
        "Binding de la sonde en bas du ballon. Laisser vide pour désactiver le plancher d'eau chaude.",
    },
    powerKey: {
      name: "Mesure de puissance",
      description:
        "Binding de puissance du chauffe-eau, utilisé pour détecter la coupure du thermostat. Laisser vide si le relais ne mesure pas.",
    },
    heaterPower: {
      name: "Puissance du chauffe-eau (W)",
      description: "Puissance nominale de la résistance, sert à dimensionner le surplus solaire",
    },
    minTemp: {
      name: "Température minimale (°C)",
      description: "En dessous, le chauffe-eau démarre immédiatement, quel que soit le tarif",
    },
    tempMaxAge: {
      name: "Âge maximal de la sonde",
      description:
        "Au-delà, la mesure est ignorée et le plancher est suspendu. Un ballon évolue lentement : une sonde qui remonte peu reste exploitable.",
    },
    rescueTemp: {
      name: "Température de reprise (°C)",
      description: "Une chauffe de secours s'arrête ici. Doit être supérieure au minimum.",
    },
    hcStart: { name: "Début heures creuses", description: "Début de la plage tarifaire basse" },
    hcEnd: { name: "Fin heures creuses", description: "Fin de la plage tarifaire basse" },
    hcMode: {
      name: "Placement du cycle",
      description:
        "Position du cycle nocturne dans la plage. « Fin de plage » garde l'eau la plus chaude au réveil.",
      options: {
        late: "Fin de plage (recommandé)",
        early: "Début de plage",
        full: "Toute la plage",
      },
    },
    hcEstimate: {
      name: "Durée de chauffe initiale",
      description:
        "Estimation de départ d'une chauffe complète. Affinée à chaque cycle une fois la mesure de puissance validée ; d'ici là elle est utilisée telle quelle, donc voir large : surestimer fait seulement réguler le thermostat du ballon, sous-estimer donne de l'eau tiède.",
    },
    fullCycleEveryDays: {
      name: "Cycle complet forcé tous les (jours)",
      description:
        "Garantit une chauffe périodique jusqu'à la coupure du thermostat (anti-légionelle). 0 désactive.",
    },
    solarMode: {
      name: "Surplus solaire",
      description: "Méthode de mesure du surplus exportable",
      options: {
        off: "Désactivé",
        grid_injection: "Compteur général (injection)",
        production_only: "Production seule",
      },
    },
    gridEquipment: { name: "Compteur général", description: "Compteur mesurant l'arrivée EDF" },
    gridSign: {
      name: "Convention de signe du compteur",
      description: "Signe de la puissance renvoyée par le compteur général",
      options: {
        import_positive: "Soutirage positif / injection négative",
        import_negative: "Soutirage négatif / injection positive",
      },
    },
    productionEquipment: {
      name: "Compteur de production",
      description:
        "Production photovoltaïque. Obligatoire en mode production seule ; en mode compteur général, c'est un garde-fou optionnel — on ne peut jamais injecter plus qu'on ne produit.",
    },
    surplusMargin: {
      name: "Marge de surplus (W)",
      description:
        "Démarre au-dessus de puissance + marge, s'arrête en dessous de puissance − marge. À élargir si ça bat.",
    },
    surplusStartDelay: {
      name: "Délai de confirmation du surplus",
      description: "Le surplus doit tenir ce délai avant le démarrage",
    },
    surplusStopDelay: {
      name: "Délai de perte du surplus",
      description: "Le surplus doit rester absent ce délai avant l'arrêt (encaisse les passages nuageux)",
    },
    cutoffPower: {
      name: "Seuil de coupure (W)",
      description:
        "Une puissance sous ce seuil alors que le relais est fermé signifie que le thermostat du ballon s'est ouvert",
    },
    cutoffDelay: {
      name: "Délai de confirmation de coupure",
      description: "À augmenter si le compteur remonte la puissance lentement",
    },
    maxCycle: {
      name: "Durée de chauffe maximale",
      description:
        "Garde-fou sur une chauffe continue. À garder au-dessus de la durée de chauffe complète, sinon il coupera un cycle d'heures creuses légitime.",
    },
  },
  groups: {
    main: "Équipement",
    floor: "Plancher d'eau chaude",
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

      if (!isValidHHMM(params.hcStart) || !isValidHHMM(params.hcEnd)) {
        throw new Error("Off-peak start and end must be valid HH:MM times");
      }
      if (params.hcStart === params.hcEnd) {
        throw new Error("Off-peak start and end must differ");
      }

      const minTemp = toNumber(params.minTemp) ?? 20;
      const rescueTemp = toNumber(params.rescueTemp) ?? 25;
      if (rescueTemp <= minTemp) {
        throw new Error("Recovery temperature must be above the minimum temperature");
      }

      const tempKey = String(params.tempKey ?? "");
      if (tempKey && !heater.dataBindings.some((b) => b.alias === tempKey)) {
        throw new Error(`"${heater.name}" has no data binding with alias "${tempKey}"`);
      }
      const powerKey = String(params.powerKey ?? "");
      if (powerKey && !heater.dataBindings.some((b) => b.alias === powerKey)) {
        throw new Error(`"${heater.name}" has no data binding with alias "${powerKey}"`);
      }

      const solarMode = String(params.solarMode ?? "off");
      if (solarMode === "grid_injection" && !params.gridEquipment) {
        throw new Error("Grid-injection mode needs a grid meter");
      }
      if (solarMode === "production_only" && !params.productionEquipment) {
        throw new Error("Production-only mode needs a production meter");
      }
    },

    createInstance(params, ctx): RecipeInstanceHandle {
      // ── Params ────────────────────────────────────────────

      const heaterId = String(params.heater);
      const tempKey = String(params.tempKey ?? "").trim();
      const powerKey = String(params.powerKey ?? "").trim();
      const heaterPowerW = toNumber(params.heaterPower) ?? 2200;

      const minTemp = toNumber(params.minTemp) ?? 20;
      const rescueTemp = toNumber(params.rescueTemp) ?? 25;
      const tempMaxAgeMs = ctx.helpers.parseDuration(params.tempMaxAge ?? "2h") || 2 * 3600_000;

      const hcStartMin = hmToMinutes(String(params.hcStart));
      const hcEndMin = hmToMinutes(String(params.hcEnd));
      const hcWindowMin = windowLength(hcStartMin, hcEndMin);
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
      const surplusMargin = toNumber(params.surplusMargin) ?? 200;
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
          if (reason === "hc" || reason === "boost") {
            hcEstimateMin = learnEstimate(hcEstimateMin, measured, true, hcWindowMin);
          }
          ctx.log(
            `Ballon chaud — thermostat coupé après ${measured} min (${
              reason ? REASON_FR[reason] : "?"
            }). Estimation de chauffe : ${hcEstimateMin} min`,
          );
        } else {
          ctx.log("Ballon chaud — thermostat déjà coupé");
        }
        persist();
      }

      /** The latch only holds while it is fresh *and* the probe hasn't dropped. */
      function isTankFull(temp: number | null, now: number): boolean {
        if (!tankFull || tankFullAt === null) return false;
        if (now - tankFullAt > TANK_FULL_TTL_MS) {
          tankFull = false;
          return false;
        }
        if (temp !== null && tankFullTemp !== null && temp <= tankFullTemp - DRAW_OFF_DELTA_C) {
          tankFull = false;
          ctx.log(`Puisage détecté (${temp.toFixed(1)} °C) — ballon considéré non plein`);
          return false;
        }
        return true;
      }

      // ── Off-peak placement ────────────────────────────────

      /** A forced full cycle (anti-legionella) overrides the placement for the
       *  night: use the whole window so the thermostat is certain to be reached. */
      function needsFullCycle(now: number): boolean {
        if (fullCycleEveryDays <= 0) return false;
        if (lastFullCycleAt === null) return true;
        return now - lastFullCycleAt > fullCycleEveryDays * 24 * 60 * 60 * 1000;
      }

      function hcHeatWindow(now: number): { startMin: number; endMin: number } {
        const effective = needsFullCycle(now) ? "full" : hcMode;
        return computeHcHeatWindow(hcStartMin, hcEndMin, effective, hcEstimateMin);
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
        const temp = tempKey ? readNumeric(eq, tempKey, tempMaxAgeMs) : null;
        // Power keeps core's `stale` rule (2 min for the category): cut-off
        // detection is only meaningful on a live reading.
        const power = powerKey ? readNumeric(eq, powerKey) : null;

        if (tempKey) {
          if (temp === null) {
            warnOnce(
              "temp-stale",
              `Sonde "${tempKey}" muette depuis plus de ${ctx.helpers.formatDuration(
                tempMaxAgeMs,
              )} — plancher d'eau chaude suspendu jusqu'à son retour`,
            );
          } else {
            warned.delete("temp-stale");
          }
        }

        const selfDraw =
          relayOn && (reason === "solar" || reason === "boost")
            ? (power !== null && power > cutoffPower ? power : heaterPowerW)
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
        const heat = hcHeatWindow(now);
        return {
          now,
          nowMin: nMin,
          temp,
          power,
          surplus,
          inHc: isWithinWindow(nMin, hcStartMin, hcEndMin),
          inHcHeat: isWithinWindow(nMin, heat.startMin, heat.endMin),
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
        const startAt = heaterPowerW + surplusMargin;
        const stopAt = Math.max(0, heaterPowerW - surplusMargin);

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

        // 3. Free energy.
        if (!s.inHc && solarOk) return "solar";

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
          if (
            previous === "hc" &&
            !tankFull &&
            !s.inHcHeat &&
            cycleStartedAt !== null &&
            powerKey &&
            powerProven
          ) {
            hcEstimateMin = learnEstimate(hcEstimateMin, 0, false, hcWindowMin);
            ctx.log(
              `Fin de plage sans coupure du thermostat — estimation portée à ${hcEstimateMin} min`,
            );
          }
          if (!(await sendRelay("off"))) return;
          // A whole cycle with the relay closed and no heating-level draw ever
          // seen is a wiring/binding problem, not a hot tank — say so.
          if (powerKey && !powerProven && onSince !== null && s.now - onSince > STARTUP_GRACE_MS) {
            warnOnce(
              "peak-never-seen",
              `La mesure "${powerKey}" n'a jamais dépassé ${Math.round(
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
        if (!powerKey || s.power === null) return;
        if (s.power > cyclePeakPower) cyclePeakPower = s.power;
        if (!powerProven && cyclePeakPower >= heaterPowerW * CUTOFF_MIN_PEAK_RATIO) {
          powerProven = true;
          ctx.state.set("powerProven", true);
          ctx.log(`Mesure "${powerKey}" validée — ${Math.round(cyclePeakPower)} W observés en chauffe`);
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
        ctx.state.set("tankFull", tankFull);
        ctx.state.set("hcWindow", `${minutesToHm(heat.startMin)} → ${minutesToHm(heat.endMin)}`);
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
            ? Math.min(storedEstimate, hcWindowMin)
            : Math.min(
                Math.max(15, Math.round(ctx.helpers.parseDuration(params.hcEstimate ?? "4h") / 60000)),
                hcWindowMin,
              );

        powerProven = ctx.state.get("powerProven") === true;

        const storedMode = ctx.state.get("mode");
        mode = storedMode === "boost" || storedMode === "off" ? storedMode : "auto";
      }

      // ── Start ─────────────────────────────────────────────

      restore();

      const unsubs: Array<() => void> = [];
      const watched = new Map<string, Set<string>>();
      watched.set(heaterId, new Set([tempKey, powerKey, "state"].filter(Boolean)));
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
      const capabilities = [
        tempKey ? `sonde ${tempKey}` : "sans sonde (plancher désactivé)",
        powerKey ? `puissance ${powerKey}` : "sans mesure de puissance (détection de coupure désactivée)",
        solarMode === "off" ? "sans solaire" : `solaire ${solarMode} via ${nameOf(solarSourceId)}`,
      ].join(", ");
      ctx.log(
        `Recette démarrée sur ${heaterName} — HC ${minutesToHm(hcStartMin)}→${minutesToHm(
          hcEndMin,
        )} (${hcMode}), plancher ${minTemp}→${rescueTemp} °C, ${capabilities}`,
      );
      if (!tempKey) {
        warnOnce(
          "no-temp",
          "Aucune sonde configurée : le plancher d'eau chaude est inactif, la recette ne fera que les heures creuses et le solaire",
        );
      }
      if (!powerKey) {
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
