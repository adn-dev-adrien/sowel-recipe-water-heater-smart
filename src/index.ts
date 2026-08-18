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
 *  3. SOLAR SURPLUS (free energy)
 *     Delegated to the core capacity arbiter (spec 140, Sowel ≥ 1.39): the
 *     recipe holds a *claim* on the heater and heats while the claim is
 *     granted. It never reads the grid meter itself.
 *
 *     This is not a refactor for tidiness. A recipe controlling on its own
 *     export threshold consumes the signal it observes — closing the relay
 *     kills the export that justified it — so it can only work by adding its
 *     own draw back, which one recipe can do correctly and two cannot. The
 *     arbiter is the single meter reader, does that accounting once for every
 *     load, and allocates the surplus in the *user's* priority order. Two
 *     surplus-aware recipes stop fighting over the same watts.
 *
 *     Nothing about the heater's configuration is solar any more: enable
 *     arbitration on the equipment (admin) and place it in the priority list.
 *     If that was not done, or the arbiter is off, or the home has no PV at
 *     all, the claim is simply denied and reasons 1 and 2 carry the recipe —
 *     off-peak plus floor is a complete mode, not a degraded one.
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

/** Spec 140: present only when an admin enabled arbitration on the equipment.
 *  Its presence is what makes the heater claimable, and `nominalPowerW` is a
 *  better source for the resistor rating than anything this recipe can ask. */
interface EnergyLoadProfileLite {
  class: "comfort" | "deferrable";
  nominalPowerW: number;
  minOnS: number;
  minOffS: number;
  learned?: { watts: number; atIso: string; runs: number };
}

interface EquipmentLite {
  id: string;
  name: string;
  type: string;
  status?: string;
  dataBindings: DataBindingLite[];
  orderBindings: OrderBindingLite[];
  computedData?: { alias: string; value: unknown }[];
  energyProfile?: EnergyLoadProfileLite;
}

// ── Capacity arbiter (spec 140, Sowel ≥ 1.39) ────────────────

type CapacitySlack = "none" | "some" | "high";

type CapacityRevokeReason =
  | "surplus-deficit"
  | "priority-preempted"
  | "manual-override"
  | "meter-stale"
  | "disabled";

type CapacityDenyReason =
  | "not-profiled"
  | "equipment-already-claimed"
  | "arbiter-disabled"
  | "override-active";

interface CapacityClaimHandle {
  readonly id: string;
  status(): "pending" | "granted" | "denied" | "released";
  readonly deniedReason?: CapacityDenyReason;
  release(): void;
}

interface RecipeEnergyHelpers {
  claimCapacity(req: {
    equipmentId: string;
    watts?: number;
    toleratedImportW?: number;
    slack?: CapacitySlack;
    note?: string;
    onGranted: () => void;
    onRevoked: (reason: CapacityRevokeReason) => void;
  }): CapacityClaimHandle;
  getCapacityState(): {
    enabled: boolean;
    availableSurplusW: number | null;
    grants: Array<{ equipmentId: string; watts: number; sinceIso: string }>;
  };
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
    /** Spec 140, Sowel ≥ 1.39. Always present on a supported core — the
     *  arbiter being *off* shows up as a `arbiter-disabled` denial, not as an
     *  absent helper. Optional here only so a mis-declared core degrades
     *  instead of throwing. */
    energy?: RecipeEnergyHelpers;
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

/**
 * Fallback cut-off detection, for the very common install where the heater has
 * no meter of its own but the house does.
 *
 * The inference is one-sided and needs no per-load channel: whatever else is
 * running, a household total below the heater's declared power proves the
 * heater is not pulling it. The converse says nothing — a high total may be an
 * oven — which is why this can only ever conclude "full", never "still going".
 *
 * `household = grid + production`, with grid signed positive on import. That is
 * core's own convention (the arbiter reads `exportW = -signedGridW`), so the
 * recipe does not re-ask the user for a sign it would only get wrong.
 *
 * Two ratios rather than one, because the declared power is a user-typed number
 * and a 2200 W plate can hide an 1800 W element:
 *  - PROVEN — the total must have been seen this high with the relay closed
 *    before any conclusion is drawn. A "main meter" that does not actually
 *    cover the heater never reaches it, and the detector stays silent instead
 *    of declaring a full tank on every cycle.
 *  - CUTOFF — below this, sustained for `cutoffDelay`, the resistor is off.
 * PROVEN sits above CUTOFF on purpose: the gap is the hysteresis.
 */
const HOUSEHOLD_PROVEN_RATIO = 0.9;
const HOUSEHOLD_CUTOFF_RATIO = 0.8;

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

/** Meters read only to infer the cut-off; never to decide when to heat. */
const GRID_TYPES = ["main_energy_meter"];
const PRODUCTION_TYPES = ["energy_production_meter"];

/** Aliases a meter equipment may carry its instantaneous power under. */
const POWER_ALIASES = ["power", "power_a", "power_total"];

/**
 * Grid the recipe accepts to buy, as a fraction of the heater's rating, when
 * the surplus almost covers a cycle.
 *
 * A resistor is all-or-nothing: waiting for the export to cover 2.2 kW whole
 * before closing the relay declines most of a day's surplus for the sake of
 * the last few percent. The arbiter takes this as `toleratedImportW` and
 * widens engage / narrows release by exactly that much. Scaled off the rating
 * rather than fixed, so a 1.2 kW tank and a 3 kW tank both get a sane figure.
 */
const DEFAULT_IMPORT_TOLERANCE_RATIO = 0.1;

/** How close to the floor the tank has to be before the recipe stops yielding
 *  its place in the priority list. Below `minTemp + this`, a shower is close
 *  enough to going cold that the watts are not negotiable. */
const FLOOR_URGENCY_MARGIN_C = 5;

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

// ============================================================
// Tank charge observer
// ============================================================

/**
 * What the bottom probe cannot say, and how the recipe says it anyway.
 *
 * A probe sitting low in the tank, in the thermostat's own orifice, reads the
 * coldest water there is. During a draw it collapses in minutes while most of
 * the tank is still hot; measured against the energy the following night had
 * to put back, the gap between what it reads and the tank's mean runs to
 * 25–30 °C. Any threshold placed on the raw reading is therefore a threshold on
 * the wrong quantity.
 *
 * So the state tracked here is **energy**, not temperature — the mean falls out
 * of it — and the probe is used only for the two things it does report
 * faithfully: that a draw is happening, and how hot the tank is at the one
 * instant it is uniform.
 *
 * The model is never trusted for long. The thermostat's own cut-off is a free
 * anchor: when it opens, the whole tank has reached its setpoint, so stored
 * energy IS capacity and the accumulated error is discarded. That happens most
 * nights, which bounds drift to roughly a day.
 *
 * `drawWhPerC` is the one coefficient nothing measures directly. It is fitted,
 * not chosen: the duration of each anchoring cycle reveals the deficit the
 * model should have predicted, and the ratio corrects it. See
 * `calibrateDrawCoefficient`.
 */
export interface TankModel {
  /** Energy stored above the cold-inlet reference, Wh. */
  storedWh: number;
  /** Coldest reading ever seen — the cold-water inlet, learned. */
  coldC: number;
  /** Reading at the last thermostat cut-off — the tank's full temperature. */
  fullC: number;
  /** Wh removed per °C of probe collapse during a draw. Fitted nightly. */
  drawWhPerC: number;
  /**
   * False until the first thermostat cut-off. Before that the balance has no
   * origin, so every figure derived from it is meaningless — and "0 %" on a
   * hot tank is worse than no number at all. The UI says so instead.
   */
  anchored: boolean;
}

/** 1 litre raised by 1 K = 4186 J = 1.163 Wh. */
const WH_PER_LITRE_KELVIN = 1.163;

/**
 * Probe fall between two samples that means a draw rather than cooling.
 *
 * The separation is wide enough not to be a tuning knob: measured showers move
 * the probe 1.6–4.0 °C between samples, standing loss moves it 0.22 °C per
 * hour. Anything gentler is the tank cooling, and the standby term has it.
 */
const DRAW_TICK_DROP_C = 1;

/**
 * A cycle only teaches the off-peak duration if it started from a tank that
 * was genuinely low.
 *
 * The duration floor alone is not enough: a 39 min top-up on an almost full
 * tank cleared it and dragged the estimate from 151 to 114 min, which then
 * left the next night's cycle short of the thermostat. Charge is the honest
 * test, and the observer is what makes it available.
 */
const LEARN_MAX_START_CHARGE = 0.5;

/** Starting guess for `drawWhPerC`, replaced by the first calibration. */
export const DEFAULT_DRAW_WH_PER_C = 120;

/** Bounds on the fitted coefficient — a bad night must not wreck the model. */
const DRAW_COEFF_MIN = 20;
const DRAW_COEFF_MAX = 600;
/** Correction is smoothed: one cycle is evidence, not proof. */
const DRAW_COEFF_ALPHA = 0.3;

/** Energy a full tank holds above the cold inlet, Wh. */
export function tankCapacityWh(volumeL: number, model: TankModel): number {
  return Math.max(0, volumeL * WH_PER_LITRE_KELVIN * (model.fullC - model.coldC));
}

/** Modelled mean temperature — the number the probe cannot give directly. */
export function modelMeanC(volumeL: number, model: TankModel): number | null {
  if (volumeL <= 0) return null;
  return model.coldC + model.storedWh / (volumeL * WH_PER_LITRE_KELVIN);
}

/** Stored energy expressed as litres at the tank's full temperature. */
export function modelHotLitres(volumeL: number, model: TankModel): number | null {
  const span = model.fullC - model.coldC;
  if (span <= 0) return null;
  return model.storedWh / (WH_PER_LITRE_KELVIN * span);
}

/** Heating, standing loss and draws, all in Wh, clamped to [0, capacity]. */
export function applyEnergy(
  model: TankModel,
  capacityWh: number,
  deltaWh: number,
): TankModel {
  const stored = Math.max(0, Math.min(capacityWh, model.storedWh + deltaWh));
  return { ...model, storedWh: stored };
}

/**
 * The free anchor: the thermostat opened, so the tank is uniformly at its
 * setpoint. Stored energy is capacity by definition and the drift is dropped.
 * The reading also *is* the full temperature, so it retrains `fullC`.
 */
export function anchorOnCutoff(
  model: TankModel,
  volumeL: number,
  probeC: number | null,
): TankModel {
  const fullC = probeC !== null && probeC > model.coldC ? probeC : model.fullC;
  const next: TankModel = { ...model, fullC, anchored: true };
  return { ...next, storedWh: tankCapacityWh(volumeL, next) };
}

/** The coldest reading ever seen is the inlet temperature, learned for free. */
export function learnColdInlet(model: TankModel, probeC: number | null): TankModel {
  if (probeC === null || probeC >= model.coldC) return model;
  return { ...model, coldC: probeC };
}

/**
 * Fit `drawWhPerC` from a cycle that ended on the thermostat.
 *
 * The cycle delivered `deliveredWh` and finished full, so the tank really was
 * `deliveredWh` short when it started. The model thought it was
 * `predictedDeficitWh` short, and the difference is almost entirely the draws
 * it mis-sized. Scaling by the ratio therefore corrects the coefficient — but
 * only a share of the way, and never outside its bounds.
 *
 * Cycles too short to be informative are refused: on a nearly full tank both
 * numbers are small and their ratio is noise.
 */
export function calibrateDrawCoefficient(
  current: number,
  deliveredWh: number,
  predictedDeficitWh: number,
  capacityWh: number,
): number {
  if (deliveredWh < capacityWh * 0.1) return current;
  if (predictedDeficitWh < capacityWh * 0.05) return current;
  const ratio = deliveredWh / predictedDeficitWh;
  const next = current * (1 - DRAW_COEFF_ALPHA) + current * ratio * DRAW_COEFF_ALPHA;
  return Math.round(Math.max(DRAW_COEFF_MIN, Math.min(DRAW_COEFF_MAX, next)));
}

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

/**
 * How hard the tank is asking, expressed the only way the arbiter accepts:
 * by stepping *down* the user's priority list, never up.
 *
 * The user owns the order between loads; what the user cannot express in a
 * static list is the tank's state of charge, which changes hourly and only
 * this recipe knows. So the recipe yields when it can afford to:
 *
 * - `none`  — we are going to run whatever happens (floor breached, boost, or
 *             an anti-legionella cycle is due). Claiming anyway is author
 *             rule 5: a grant landing on an already-running load makes the
 *             arbiter's books exact instead of leaving a hole in the surplus.
 *             It is also the only slack allowed to preempt loads below it.
 * - `some`  — a real heat-up is still needed today, but tonight's off-peak
 *             window can cover it.
 * - `high`  — the tank is essentially hot; this would be a top-up. Anything
 *             else in the list deserves the watts more.
 */
export function computeSlack(input: {
  mode: Mode;
  temp: number | null;
  minTemp: number;
  needsFullCycle: boolean;
  tankFull: boolean;
}): CapacitySlack {
  if (input.mode === "boost") return "none";
  if (input.temp !== null && input.temp < input.minTemp + FLOOR_URGENCY_MARGIN_C) return "none";
  if (input.needsFullCycle) return "none";
  if (input.tankFull) return "high";
  return "some";
}

/** One decimal, or null — the state is read by humans. */
function round1(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
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

/**
 * NOTE — `heater` must stay the FIRST non-list `equipment` slot: the recipe
 * form resolves every `data-key` slot against that one equipment.
 *
 * The form is deliberately shallow. Everything solar disappeared with spec
 * 140 — no meter, no sign convention, no thresholds, no hysteresis delays,
 * because none of that is the recipe's business any more. What is left splits
 * into what a household actually decides (how cold is too cold, where in the
 * off-peak window to heat) and what only exists to accommodate a particular
 * device, which lives under "advanced" and is meant to stay untouched.
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
      id: "minTemp",
      name: "Rescue below",
      description: "Heats now (\u00b0C)",
      type: "number",
      required: false,
      defaultValue: 20,
      constraints: { min: 5, max: 70 },
      group: "floor",
    },
    {
      id: "rescueTemp",
      name: "Rescue up to",
      description: "Ends there (\u00b0C)",
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
      id: "tempKey",
      name: "Temp. reading",
      description: "Empty = found alone",
      type: "data-key",
      required: false,
      group: "advanced",
    },
    {
      id: "powerKey",
      name: "Power reading",
      description: "Empty = found alone",
      type: "data-key",
      required: false,
      group: "advanced",
    },
    {
      id: "heaterPower",
      name: "Heater power",
      description: "Blank = profile",
      type: "number",
      required: false,
      constraints: { min: 300, max: 9000 },
      group: "advanced",
    },
    {
      id: "toleratedImport",
      name: "Tolerated grid",
      description: "Blank = 10 % of load",
      type: "number",
      required: false,
      constraints: { min: 0, max: 2000 },
      group: "advanced",
    },
    {
      id: "tempMaxAge",
      name: "Probe stale",
      description: "Then ignored",
      type: "duration",
      required: false,
      defaultValue: "2h",
      group: "advanced",
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
      id: "gridEquipment",
      name: "House meter",
      description: "Cut-off fallback",
      type: "equipment",
      required: false,
      constraints: { equipmentType: GRID_TYPES, crossZone: true },
      group: "cutoff",
    },
    {
      id: "productionEquipment",
      name: "PV meter",
      description: "Required if solar",
      type: "equipment",
      required: false,
      constraints: { equipmentType: PRODUCTION_TYPES, crossZone: true },
      group: "cutoff",
    },
    {
      id: "tankVolume",
      name: "Tank volume (L)",
      description: "Sizes the model",
      type: "number",
      required: false,
      defaultValue: 200,
      constraints: { min: 30, max: 1000 },
      group: "tank",
    },
    {
      id: "standbyPower",
      name: "Standing loss (W)",
      description: "Measured, not rated",
      type: "number",
      required: false,
      defaultValue: 70,
      constraints: { min: 0, max: 500 },
      group: "tank",
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
    "Pilote un chauffe-eau on/off : plancher d'eau chaude garanti, chauffe nocturne cal\u00e9e en fin d'heures creuses, et chauffe sur surplus solaire arbitr\u00e9 par Sowel. D\u00e9tecte la coupure du thermostat du ballon via la chute de puissance.",
  slots: {
    zone: { name: "Zone", description: "Zone du chauffe-eau" },
    heater: { name: "Chauffe-eau", description: "Relais marche/arr\u00eat" },
    minTemp: {
      name: "Secours sous",
      description: "Chauffe aussit\u00f4t",
    },
    rescueTemp: {
      name: "Secours \u00e0",
      description: "Fin du secours (\u00b0C)",
    },
    tankFullMemory: {
      name: "Reste chaud",
      description: "Puis r\u00e9chauffe",
    },
    hcMode: {
      name: "Placement",
      description: "Dans la plage HC",
      options: {
        late: "Fin de plage (recommand\u00e9)",
        early: "D\u00e9but de plage",
        full: "Toute la plage",
      },
    },
    hcEstimate: {
      name: "Dur\u00e9e initiale",
      description: "Affin\u00e9e \u00e0 l'usage",
    },
    fullCycleEveryDays: {
      name: "Cycle complet",
      description: "Tous les N jours",
    },
    tempKey: {
      name: "Mesure temp.",
      description: "Vide = trouv\u00e9e seule",
    },
    powerKey: {
      name: "Mesure puiss.",
      description: "Vide = trouv\u00e9e seule",
    },
    heaterPower: {
      name: "Puissance (W)",
      description: "Vide = profil",
    },
    toleratedImport: {
      name: "Soutirage OK",
      description: "Vide = 10 % charge",
    },
    tempMaxAge: {
      name: "Sonde p\u00e9rim\u00e9e",
      description: "Au-del\u00e0, ignor\u00e9e",
    },
    cutoffPower: {
      name: "Coupure (W)",
      description: "Thermostat ouvert",
    },
    cutoffDelay: {
      name: "D\u00e9lai coupure",
      description: "Avant de conclure",
    },
    gridEquipment: {
      name: "Compteur g\u00e9n\u00e9ral",
      description: "Repli d\u00e9tection coupure",
    },
    productionEquipment: {
      name: "Compteur production",
      description: "Obligatoire si solaire",
    },
    tankVolume: {
      name: "Volume du ballon (L)",
      description: "Dimensionne le modèle",
    },
    standbyPower: {
      name: "Pertes statiques (W)",
      description: "Mesurées, pas la plaque",
    },
    maxCycle: {
      name: "Chauffe maxi",
      description: "Garde-fou",
    },
  },
  groups: {
    main: "\u00c9quipement",
    floor: "Chauffe de secours (plus d'eau chaude)",
    hc: "Heures creuses",
    tank: "Mod\u00e8le de charge du ballon",
    cutoff: "D\u00e9tection de coupure sans mesure d\u00e9di\u00e9e",
    advanced: "R\u00e9glages avanc\u00e9s",
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
      "Drives an on/off water heater: hot-water floor, off-peak night cycle placed just before the window ends, and solar-surplus heating arbitrated by Sowel. Detects the tank thermostat cut-off from the power draw.",
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
      // once in the "Energy tariffs" card under Settings; letting the
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
          "No energy tariff is configured. Fill the \"Energy tariffs\" card in Settings and save it, then create this instance.",
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

      // Solar validates nothing any more, because there is nothing left that
      // can contradict itself: no meter to pick, no sign convention to get
      // wrong, no pair of thresholds that cancel each other. The heater is
      // claimable or it is not, the arbiter answers that at runtime, and both
      // answers leave a working recipe — so an unprofiled heater is a line in
      // the journal at start-up, never a refusal to create the instance.
    },

    createInstance(params, ctx): RecipeInstanceHandle {
      // ── Params ────────────────────────────────────────────

      const heaterId = String(params.heater);
      const tempOverride = String(params.tempKey ?? "").trim();
      const powerOverride = String(params.powerKey ?? "").trim();
      /** Cut-off fallback only — nothing here decides when to heat. */
      const gridId = params.gridEquipment ? String(params.gridEquipment) : null;
      const productionId = params.productionEquipment ? String(params.productionEquipment) : null;

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
      /**
       * The resistor rating, in watts.
       *
       * The energy profile wins when there is one: an admin filled it to
       * enrol the heater under arbitration, the core pre-fills it from
       * measured power, and keeping a second copy in the recipe form is the
       * same drift trap as the off-peak hours. The slot survives as an
       * override for an unprofiled heater, and 2200 W is the fallback of last
       * resort — the rating of the tank in most French homes.
       */
      function heaterPower(): number {
        return (
          toNumber(params.heaterPower) ?? heaterEq()?.energyProfile?.nominalPowerW ?? 2200
        );
      }

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

      const tankVolumeL = toNumber(params.tankVolume) ?? 200;
      const standbyW = toNumber(params.standbyPower) ?? 70;
      const cutoffPower = toNumber(params.cutoffPower) ?? 300;
      const cutoffDelayMs = ctx.helpers.parseDuration(params.cutoffDelay ?? "5m");
      const maxCycleMs = ctx.helpers.parseDuration(params.maxCycle ?? "6h");

      /** Grid the recipe accepts to buy to catch a nearly-free cycle. */
      function toleratedImportW(): number {
        return (
          toNumber(params.toleratedImport) ??
          Math.round(heaterPower() * DEFAULT_IMPORT_TOLERANCE_RATIO)
        );
      }

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
      /** Same idea for the household total, when it is the only witness. */
      let householdLowSince: number | null = null;
      let householdProven = false;

      /** Charge observer (persisted). Read-only for now: it decides nothing. */
      let tank: TankModel = {
        storedWh: 0,
        coldC: 20,
        fullC: 60,
        drawWhPerC: DEFAULT_DRAW_WH_PER_C,
        anchored: false,
      };
      /** Probe reading at the previous tick — draws are read from its drops. */
      let lastProbeC: number | null = null;
      /** Wall clock of the previous observer update, for the energy integral. */
      let lastModelAt: number | null = null;
      /** Stored energy when the running cycle began — the calibration target. */
      let storedAtCycleStart: number | null = null;
      let mismatchSince: number | null = null;
      let manualOn = false;

      let hcEstimateMin = 180;
      let tankFull = false;
      let tankFullAt: number | null = null;
      let tankFullTemp: number | null = null;
      let lastFullCycleAt: number | null = null;
      let mode: Mode = "auto";

      /** The surplus reservation held with the core arbiter, if any. */
      let claim: CapacityClaimHandle | null = null;
      /** Slack the live claim was opened with — re-issuing is how it changes. */
      let claimSlack: CapacitySlack | null = null;
      /** Set by the arbiter's callbacks. The *only* solar input this recipe has. */
      let granted = false;
      let lastDenial: CapacityDenyReason | null = null;

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

      /** First alias that yields a live number — meters do not agree on naming. */
      function readFirstNumeric(eq: EquipmentLite | null, aliases: string[]): number | null {
        for (const alias of aliases) {
          const v = readNumeric(eq, alias);
          if (v !== null) return v;
        }
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

      const REVOKE_FR: Record<CapacityRevokeReason, string> = {
        "surplus-deficit": "surplus insuffisant",
        "priority-preempted": "priorité donnée à une autre charge",
        "manual-override": "commande manuelle sur le chauffe-eau",
        "meter-stale": "compteur muet",
        disabled: "arbitrage désactivé",
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

        // Read before anchoring: the anchor overwrites both of these.
        const capacityAtStart = tankCapacityWh(tankVolumeL, tank);
        const chargeAtStart =
          tank.anchored && capacityAtStart > 0 && storedAtCycleStart !== null
            ? storedAtCycleStart / capacityAtStart
            : null;

        // The free anchor. Fit the draw coefficient against what this cycle
        // actually had to deliver, THEN discard the drift — in that order, or
        // the evidence is erased before it is used.
        if (cycleStartedAt !== null && storedAtCycleStart !== null) {
          const hours = Math.max(0, endedAt - cycleStartedAt) / 3_600_000;
          const deliveredWh = Math.max(0, heaterPower() * hours - standbyW * hours);
          const before = tank.drawWhPerC;
          tank = {
            ...tank,
            drawWhPerC: calibrateDrawCoefficient(
              before,
              deliveredWh,
              tankCapacityWh(tankVolumeL, tank) - storedAtCycleStart,
              tankCapacityWh(tankVolumeL, tank),
            ),
          };
          if (tank.drawWhPerC !== before) {
            ctx.log(
              `Modèle recalé : ${Math.round(deliveredWh)} Wh restitués, coefficient de puisage ${before} → ${tank.drawWhPerC} Wh/°C`,
            );
          }
        }
        tank = anchorOnCutoff(tank, tankVolumeL, temp);
        storedAtCycleStart = null;

        if (cycleStartedAt !== null) {
          const measured = Math.max(0, Math.round((endedAt - cycleStartedAt) / 60000));
          // A cycle only teaches when it plausibly started from a cold tank.
          // See LEARN_MIN_MEASURED_MIN: a top-up is short by definition, and
          // letting it in walks the estimate down until the off-peak placement
          // no longer covers a real heat-up.
          // `chargeAtStart === null` means the observer has no origin yet, so
          // the duration floor stands alone — as it did before the model.
          const startedLow = chargeAtStart === null || chargeAtStart < LEARN_MAX_START_CHARGE;
          const teaches =
            (reason === "hc" || reason === "boost") &&
            measured >= LEARN_MIN_MEASURED_MIN &&
            startedLow;
          if (teaches) {
            hcEstimateMin = learnEstimate(hcEstimateMin, measured, true, currentWindowMin());
          }
          ctx.log(
            `Ballon chaud — thermostat coupé après ${measured} min (${
              reason ? REASON_FR[reason] : "?"
            }). ${
              teaches
                ? `Estimation de chauffe : ${hcEstimateMin} min`
                : startedLow
                  ? `Cycle trop court pour être représentatif — estimation inchangée (${hcEstimateMin} min)`
                  : `Ballon déjà chargé à ${Math.round((chargeAtStart as number) * 100)} % au départ — estimation inchangée (${hcEstimateMin} min)`
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
       * the "Energy tariffs" card under Settings and drive energy billing.
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
              "Aucun tarif configuré dans Sowel — chauffe en heures creuses désactivée. Renseigne la carte « Tarifs énergie » dans les Réglages et enregistre.",
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
        /** Household draw, or null when it cannot be established honestly. */
        household: number | null;
        inHc: boolean;
        inHcHeat: boolean;
      }

      /**
       * Household draw, or null when it cannot be established honestly.
       *
       * Null on a missing/stale grid reading, and — the case that matters — null
       * whenever the sun is up but no production meter is bound. Grid alone is
       * not the household total under PV: 2.2 kW of resistor covered by the
       * panels shows as ~0 W at the grid, which reads exactly like a tank that
       * just filled. Rather than guess, the detector stands down for the day.
       * The arbiter's surplus is the tell-tale, and it is already on hand.
       */
      function householdPowerW(): number | null {
        if (!gridId) return null;
        const grid = readFirstNumeric(
          ctx.equipmentManager.getByIdWithDetails(gridId),
          POWER_ALIASES,
        );
        // A meter that reads nothing is the one failure that looks exactly like
        // silence from the detector. Name it, or "the relay stays closed on a
        // full tank" has no explanation anywhere in the journal.
        if (grid === null) {
          warnOnce(
            "household-grid-mute",
            `Compteur général « ${nameOf(gridId)} » : aucune puissance lisible (alias attendu parmi ${POWER_ALIASES.join(", ")}) — coupure du thermostat indétectable`,
          );
          return null;
        }
        warned.delete("household-grid-mute");

        if (productionId) {
          const prod = readFirstNumeric(
            ctx.equipmentManager.getByIdWithDetails(productionId),
            POWER_ALIASES,
          );
          if (prod === null) {
            warnOnce(
              "household-prod-mute",
              `Compteur de production « ${nameOf(productionId)} » : aucune puissance lisible (alias attendu parmi ${POWER_ALIASES.join(", ")}) — coupure du thermostat indétectable`,
            );
            return null;
          }
          warned.delete("household-prod-mute");
          return grid + Math.max(0, prod);
        }

        const surplus = readCapacityState()?.availableSurplusW ?? null;
        if (surplus !== null && surplus > 0) {
          warnOnce(
            "household-needs-pv",
            "Détection de coupure suspendue tant que le soleil produit : renseigne le compteur de production dans les réglages avancés, le compteur général seul ne donne pas la consommation totale sous photovoltaïque",
          );
          return null;
        }
        return grid;
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

        const nMin = nowMinutes(date);
        const hcWindow = resolveHcWindow();
        const heat = hcHeatWindow(now);
        return {
          now,
          nowMin: nMin,
          temp,
          power,
          household: power === null && relayOn ? householdPowerW() : null,
          inHc: hcWindow !== null && isWithinWindow(nMin, hcWindow.startMin, hcWindow.endMin),
          inHcHeat: heat !== null && isWithinWindow(nMin, heat.startMin, heat.endMin),
        };
      }

      // ── Surplus reservation (spec 140) ────────────────────

      /**
       * Whether the tank has any use for free watts right now.
       *
       * Deliberately wider than "would heat on solar": the claim stays open
       * while the floor or the off-peak cycle is driving the relay. That is
       * author rule 5 — a load running without a grant is a hole in the
       * arbiter's surplus, and a grant landing on it costs nothing and makes
       * the books exact for everyone else in the priority list.
       */
      function wantsCapacity(s: Snapshot): boolean {
        return mode !== "off" && !isTankFull(s.temp, s.now);
      }

      /** A core that answers badly must not take the recipe down with it. */
      function readCapacityState(): { enabled: boolean; availableSurplusW: number | null } | null {
        try {
          return ctx.helpers.energy?.getCapacityState() ?? null;
        } catch {
          return null;
        }
      }

      /** Log-friendly wording for the reasons a claim can be turned down. */
      const DENY_FR: Record<CapacityDenyReason, string> = {
        "not-profiled":
          "le chauffe-eau n'est pas déclaré comme charge pilotable — ouvre sa fiche dans Équipements, panneau « Pilotage énergie », et coche « Charge pilotable »",
        "arbiter-disabled":
          "l'arbitrage du surplus est désactivé — Réglages, carte « Arbitre de surplus »",
        "equipment-already-claimed": "une autre recette a déjà réservé cet équipement",
        "override-active": "pilotage suspendu après une commande manuelle",
      };

      /**
       * Keep the reservation in step with what the tank needs.
       *
       * One claim at a time, held for as long as the need lasts: a revocation
       * leaves it *pending* in the arbiter's queue, so the recipe never has to
       * re-ask after losing the surplus to a cloud. Re-issuing happens only to
       * change `slack`, and never while granted — dropping a live grant to
       * announce a lower urgency would hand the watts away mid-cycle.
       */
      function syncClaim(s: Snapshot): void {
        const energy = ctx.helpers.energy;
        if (!energy) return;

        if (!wantsCapacity(s)) {
          if (claim) {
            claim.release();
            claim = null;
            claimSlack = null;
            granted = false;
          }
          return;
        }

        const slack = computeSlack({
          mode,
          temp: s.temp,
          minTemp,
          needsFullCycle: needsFullCycle(s.now),
          tankFull,
        });

        if (claim) {
          const live = claim.status();
          if (live === "pending" || live === "granted") {
            if (slack === claimSlack || live === "granted") return;
            claim.release();
            granted = false;
          }
          claim = null;
          claimSlack = null;
        }

        const handle = energy.claimCapacity({
          equipmentId: heaterId,
          watts: heaterPower(),
          toleratedImportW: toleratedImportW(),
          slack,
          note: "chauffe sur surplus",
          onGranted: () => {
            granted = true;
            ctx.log("Surplus accordé par Sowel — chauffe sur le solaire");
            void evaluate();
          },
          onRevoked: (why) => {
            granted = false;
            ctx.log(`Surplus repris par Sowel (${REVOKE_FR[why] ?? why})`);
            void evaluate();
          },
        });

        if (handle.status() === "denied") {
          const why = handle.deniedReason ?? "arbiter-disabled";
          // Worth saying once, and only once: without it "the sun is out and
          // nothing happens" is unexplainable from the journal. Everything
          // else about the recipe keeps working, so it is not an error.
          if (why !== lastDenial) {
            lastDenial = why;
            ctx.log(`Pas de chauffe sur surplus : ${DENY_FR[why]}`);
          }
          claim = null;
          claimSlack = null;
          granted = false;
          return;
        }

        lastDenial = null;
        claim = handle;
        claimSlack = slack;
      }

      function decide(s: Snapshot): Reason | null {
        // The arbiter owns this decision entirely: `granted` is set by its
        // callbacks and nothing here looks at a meter. Hysteresis, cloud
        // filtering and anti-short-cycling all live in core now, where they
        // can see every load instead of this one.
        const solarOk = granted;

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
          storedAtCycleStart = tank.storedWh;
          lowPowerSince = null;
          householdLowSince = null;
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
              )} W pendant la chauffe (attendu ≈ ${heaterPower()} W) — détection de coupure inactive tant qu'elle n'a pas vu le chauffe-eau consommer`,
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
      /**
       * Cut-off inferred from the household total, for a heater with no meter
       * of its own. Only ever concludes "full": a total below the declared
       * power proves the resistor is off, a high one proves nothing.
       *
       * Runs only as a fallback. A dedicated channel measures this heater and
       * nothing else, so wherever one exists it wins and this stays idle.
       */
      function detectCutoffFromHousehold(s: Snapshot): void {
        if (s.household === null) return;

        const declared = heaterPower();
        if (s.household >= declared * HOUSEHOLD_PROVEN_RATIO && !householdProven) {
          householdProven = true;
          ctx.state.set("householdProven", true);
          ctx.log(
            `Consommation totale validée comme témoin — ${Math.round(s.household)} W observés, relais fermé`,
          );
        }
        if (s.now - onSince! < STARTUP_GRACE_MS) return;
        if (!householdProven) {
          householdLowSince = null;
          return;
        }

        if (s.household >= declared * HOUSEHOLD_CUTOFF_RATIO) {
          householdLowSince = null;
          return;
        }
        householdLowSince ??= s.now;
        if (s.now - householdLowSince >= cutoffDelayMs) {
          const collapsedAt = householdLowSince;
          householdLowSince = null;
          ctx.log(
            `Ballon plein déduit de la consommation totale (${Math.round(
              s.household,
            )} W < ${declared} W déclarés, relais fermé)`,
          );
          markTankFull(s.temp, s.now, collapsedAt);
        }
      }

      /**
       * Advance the charge observer one tick. Decides nothing — it only keeps
       * the energy balance so the model can be judged before it is trusted.
       *
       * A draw is read as a *fast* fall of the probe. The separation is wide:
       * a shower moves it 1.6–4.0 °C between two samples, standing loss moves
       * it 0.22 °C per hour. Anything slower than the threshold is the tank
       * cooling, which the standby term already accounts for.
       */
      function updateModel(s: Snapshot): void {
        tank = learnColdInlet(tank, s.temp);
        const capacity = tankCapacityWh(tankVolumeL, tank);

        if (lastModelAt !== null && capacity > 0) {
          const hours = Math.max(0, s.now - lastModelAt) / 3_600_000;
          if (hours > 0 && hours < 6) {
            let deltaWh = -standbyW * hours;
            if (relayOn) deltaWh += heaterPower() * hours;
            tank = applyEnergy(tank, capacity, deltaWh);
          }

          if (s.temp !== null && lastProbeC !== null) {
            const drop = lastProbeC - s.temp;
            if (drop >= DRAW_TICK_DROP_C) {
              tank = applyEnergy(tank, capacity, -tank.drawWhPerC * drop);
            }
          }
        }

        lastModelAt = s.now;
        if (s.temp !== null) lastProbeC = s.temp;
      }

      function detectCutoff(s: Snapshot): void {
        if (!relayOn || onSince === null) {
          lowPowerSince = null;
          householdLowSince = null;
          cyclePeakPower = 0;
          return;
        }
        if (s.power === null) {
          detectCutoffFromHousehold(s);
          return;
        }
        if (s.power > cyclePeakPower) cyclePeakPower = s.power;
        if (!powerProven && cyclePeakPower >= heaterPower() * CUTOFF_MIN_PEAK_RATIO) {
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
          updateModel(s);
          detectCutoff(s);
          // After cut-off detection, so a tank that just filled releases its
          // reservation on the same tick rather than sitting on watts the next
          // load in the priority list could use (author rule 4).
          syncClaim(s);

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
        ctx.state.set("householdProven", householdProven);
        ctx.state.set("modelStoredWh", Math.round(tank.storedWh));
        ctx.state.set("modelColdC", Math.round(tank.coldC * 10) / 10);
        ctx.state.set("modelFullC", Math.round(tank.fullC * 10) / 10);
        ctx.state.set("modelDrawWhPerC", tank.drawWhPerC);
      }

      function publish(s: Snapshot): void {
        const heat = hcHeatWindow(s.now);
        // Instrumentation: five nights have started exactly 120 min before the
        // computed placement, and nothing in the code explains it. Publish the
        // resolved slot and the placement every tick — the published label was
        // written only on change, so it could not be compared with the values
        // the decision actually used.
        const slot = resolveHcWindow();
        ctx.state.set("hcSlotFrom", slot ? minutesToHm(slot.startMin) : null);
        ctx.state.set("hcSlotTo", slot ? minutesToHm(slot.endMin) : null);
        ctx.state.set("hcHeatFrom", heat ? minutesToHm(heat.startMin) : null);
        ctx.state.set("hcHeatTo", heat ? minutesToHm(heat.endMin) : null);
        ctx.state.set("nowMin", s.nowMin);
        ctx.state.set("householdPower", s.household);
        // The whole point of the observer: a charge figure that means something,
        // next to the probe reading that does not.
        const capacityWh = tankCapacityWh(tankVolumeL, tank);
        ctx.state.set("modelStoredWh", Math.round(tank.storedWh));
        ctx.state.set("modelColdC", round1(tank.coldC));
        ctx.state.set("modelFullC", round1(tank.fullC));
        ctx.state.set("modelDrawWhPerC", tank.drawWhPerC);
        ctx.state.set("modelAnchored", tank.anchored);
        ctx.state.set("tankMeanTemp", round1(modelMeanC(tankVolumeL, tank)));
        // Kept for analysis, deliberately not surfaced: see the summary above.
        ctx.state.set("tankHotLitres", round1(modelHotLitres(tankVolumeL, tank)));
        const charge =
          tank.anchored && capacityWh > 0
            ? Math.round((tank.storedWh / capacityWh) * 100)
            : null;
        ctx.state.set("tankCharge", charge);

        // The card's one free line (state.summary). It is the only place the
        // observer is visible without an API call, so it carries the model and
        // the probe side by side — the whole point being that they disagree.
        const meanC = modelMeanC(tankVolumeL, tank);
        // No equivalent-litres figure. It reads as "four showers left" because
        // it assumes perfect stratification; the tank is mixed enough that a
        // 47 °C mean gave a cold shower while that number said 191 L.
        ctx.state.set(
          "summary",
          charge === null || meanC === null
            ? "Modèle de charge : en attente du premier ancrage"
            : `Charge ${charge} % · modèle ${meanC.toFixed(0)} °C` +
              (s.temp !== null ? ` / sonde ${s.temp.toFixed(0)} °C` : ""),
        );
        ctx.state.set("status", relayOn ? "heating" : manualOn ? "manual" : "off");
        ctx.state.set("reason", reason);
        ctx.state.set("mode", mode);
        ctx.state.set("temp", s.temp);
        ctx.state.set("power", s.power);
        // Where the surplus stands, from the arbiter rather than from a
        // threshold of our own. "Why isn't it heating in full sun?" used to
        // need the two thresholds on screen and some mental arithmetic; now it
        // is one line — what the claim is doing, and how much surplus is free.
        const capacity = readCapacityState();
        ctx.state.set("surplusClaim", claim ? claim.status() : (lastDenial ?? "none"));
        ctx.state.set("availableSurplus", capacity?.availableSurplusW ?? null);
        ctx.state.set("surplusSlack", claimSlack);
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
        householdProven = ctx.state.get("householdProven") === true;
        tank = {
          storedWh: num("modelStoredWh") ?? 0,
          coldC: num("modelColdC") ?? 20,
          fullC: num("modelFullC") ?? 60,
          drawWhPerC: num("modelDrawWhPerC") ?? DEFAULT_DRAW_WH_PER_C,
          anchored: ctx.state.get("modelAnchored") === true,
        };

        const storedMode = ctx.state.get("mode");
        mode = storedMode === "boost" || storedMode === "off" ? storedMode : "auto";
      }

      // ── Start ─────────────────────────────────────────────

      restore();

      const unsubs: Array<() => void> = [];

      // Only the heater is watched now. The grid meter used to be subscribed
      // here too — that subscription *was* the design flaw: a recipe reading
      // the meter to decide whether to consume feeds back into what it reads.
      unsubs.push(
        ctx.eventBus.onType("equipment.data.changed", (event) => {
          // The heater's relay state can be reported under any alias, so take
          // every change on it rather than pinning a set a later binding
          // would miss.
          if (String(event.equipmentId ?? "") !== heaterId) return;
          void evaluate();
        }),
      );

      const ticker = setInterval(() => void evaluate(), TICK_MS);

      const heaterName = nameOf(heaterId);
      const startupWindow = resolveHcWindow();
      announceWindow(startupWindow);
      const profile = heaterEq()?.energyProfile;
      const capacity = readCapacityState();
      const capabilities = [
        tempAlias() ? `sonde ${tempAlias()}` : "sans sonde (chauffe de secours désactivée)",
        powerAlias()
          ? `puissance ${powerAlias()}`
          : gridId
            ? `coupure déduite de la consommation totale (${nameOf(gridId)}${
                productionId ? ` + ${nameOf(productionId)}` : ", sans compteur de production"
              })`
            : "sans mesure de puissance (détection de coupure désactivée)",
        !ctx.helpers.energy
          ? "sans arbitrage du surplus (Sowel 1.39 minimum)"
          : !profile
            ? "surplus indisponible (chauffe-eau non déclaré comme charge pilotable)"
            : capacity?.enabled === false
              ? "surplus indisponible (arbitrage désactivé)"
              : `surplus arbitré par Sowel (${heaterPower()} W, soutirage toléré ${toleratedImportW()} W)`,
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
      if (!powerAlias() && !gridId) {
        warnOnce(
          "no-power",
          "Aucune mesure de puissance : impossible de détecter la coupure du thermostat, les cycles seront bornés par la plage horaire et la durée maximale. Un compteur général renseigné dans les réglages avancés suffirait à la déduire.",
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
          // The core releases an instance's claims on stop anyway; doing it
          // here as well keeps the arbiter's books exact through the window
          // where the instance is gone and its replacement has not claimed yet.
          try {
            claim?.release();
          } catch {
            /* teardown must never throw */
          }
          claim = null;
          granted = false;
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
