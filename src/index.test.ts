import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createRecipe,
  resolveBindingAlias,
  computeHcHeatWindow,
  pickMainOffPeakSlot,
  computeSurplus,
  findOnOffOrderAlias,
  hmToMinutes,
  isWithinWindow,
  learnEstimate,
  minutesToHm,
  windowLength,
} from "./index.js";

// ============================================================
// Test doubles
// ============================================================

const HEATER = "heater-1";
const METER = "meter-1";
const PRODUCTION = "production-1";

type Binding = {
  alias: string;
  value?: unknown;
  category?: string;
  stale?: boolean;
  enumValues?: string[];
};

interface HarnessOptions {
  /** Bindings on the heater equipment. Defaults to state + temp + power. */
  heaterBindings?: Binding[];
  /** Order bindings on the heater. Defaults to a boolean `state` toggle. */
  heaterOrders?: { alias: string; type?: string; category?: string; enumValues?: string[] }[];
  /** Watts the simulated relay reports once it closes. */
  drawWhenOn?: number;
  /** When false, the simulated device ignores orders (relay state never moves). */
  deviceObeys?: boolean;
  /** Pre-existing recipe state, as if restored from a previous instance. */
  initialState?: Record<string, unknown>;
  /** Tariff snapshot the fake core hands back. Defaults to 22:00-06:00. */
  tariff?: {
    configured: boolean;
    offPeakToday: { start: string; end: string; tariff: string }[];
    isOffPeakNow: boolean | null;
  };
  /** Models a Sowel older than 1.36: `ctx.helpers.getTariff` does not exist. */
  noTariffHelper?: boolean;
  /** Makes getTariff() throw, to prove a broken core cannot break the recipe. */
  tariffThrows?: boolean;
}

/** The instance's off-peak hours, as most tests assume them. */
const DEFAULT_TARIFF = {
  configured: true,
  offPeakToday: [{ start: "22:00", end: "06:00", tariff: "hc" }],
  isOffPeakNow: false,
};

function buildHarness(opts: HarnessOptions = {}) {
  const drawWhenOn = opts.drawWhenOn ?? 2200;
  const deviceObeys = opts.deviceObeys ?? true;

  const heaterBindings: Binding[] = opts.heaterBindings ?? [
    { alias: "state", category: "light_state", value: "OFF" },
    { alias: "water_temperature", category: "temperature", value: 45 },
    { alias: "power", category: "power", value: 0 },
  ];
  const heaterOrders = opts.heaterOrders ?? [
    { alias: "state", type: "boolean", category: "light_toggle" },
  ];

  const meterBindings: Binding[] = [{ alias: "power", category: "power", value: 0 }];

  const equipments: Record<string, Record<string, unknown>> = {
    [HEATER]: {
      id: HEATER,
      name: "Chauffe-eau",
      type: "water_heater",
      status: "online",
      dataBindings: heaterBindings,
      orderBindings: heaterOrders,
    },
    [METER]: {
      id: METER,
      name: "Compteur général",
      type: "main_energy_meter",
      status: "online",
      dataBindings: meterBindings,
      orderBindings: [],
    },
    [PRODUCTION]: {
      id: PRODUCTION,
      name: "Solaire",
      type: "energy_production_meter",
      status: "online",
      dataBindings: [{ alias: "power", category: "power", value: 0 }] as Binding[],
      orderBindings: [],
    },
  };

  const orderCalls: { equipmentId: string; alias: string; value: unknown }[] = [];
  const logLines: string[] = [];
  const state = new Map<string, unknown>(Object.entries(opts.initialState ?? {}));
  const dataHandlers: Array<(e: Record<string, unknown>) => void> = [];

  function setBinding(eqId: string, alias: string, value: unknown): void {
    const eq = equipments[eqId] as { dataBindings: Binding[] };
    const b = eq.dataBindings.find((d) => d.alias === alias);
    if (b) b.value = value;
    else eq.dataBindings.push({ alias, value });
  }

  const ctx = {
    eventBus: {
      onType: (type: string, handler: (e: Record<string, unknown>) => void) => {
        if (type === "equipment.data.changed") dataHandlers.push(handler);
        return () => {
          const i = dataHandlers.indexOf(handler);
          if (i >= 0) dataHandlers.splice(i, 1);
        };
      },
    },
    equipmentManager: {
      getById: (id: string) => (equipments[id] as { id: string; name: string }) ?? null,
      getByIdWithDetails: (id: string) => (equipments[id] as never) ?? null,
    },
    zoneManager: { getById: () => null },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    state: {
      get: (k: string) => (state.has(k) ? state.get(k) : null),
      set: (k: string, v: unknown) => void state.set(k, v),
      delete: (k: string) => void state.delete(k),
      clear: () => state.clear(),
    },
    log: (msg: string) => void logLines.push(msg),
    helpers: {
      parseDuration: (value: unknown) => parseDurationLike(value),
      formatDuration: (ms: number) => `${Math.round(ms / 60000)}min`,
      ...(opts.noTariffHelper
        ? {}
        : {
            getTariff: () => {
              if (opts.tariffThrows) throw new Error("classifier exploded");
              return opts.tariff ?? DEFAULT_TARIFF;
            },
          }),
    },
    dispatchOrder: async (equipmentId: string, alias: string, value: unknown) => {
      orderCalls.push({ equipmentId, alias, value });
      if (deviceObeys && equipmentId === HEATER) {
        const on = value === true || String(value).toUpperCase() === "ON";
        setBinding(HEATER, "state", on ? "ON" : "OFF");
        // Drive whatever metering channel the device actually has — a relay
        // without one must not sprout a `power` binding just by switching.
        const metering = (equipments[HEATER] as { dataBindings: Binding[] }).dataBindings.find(
          (b) => b.category === "power",
        );
        if (metering) metering.value = on ? drawWhenOn : 0;
      }
      return { success: true };
    },
  };

  return {
    ctx,
    orderCalls,
    logLines,
    state,
    setBinding,
    /** Last order sent to the heater, or undefined. */
    lastOrder: () => orderCalls[orderCalls.length - 1],
    fireDataChanged: (equipmentId: string, alias: string) => {
      for (const h of [...dataHandlers]) h({ equipmentId, alias });
    },
  };
}

/** Mirrors the core helper closely enough for the durations this recipe uses. */
function parseDurationLike(value: unknown): number {
  if (typeof value === "number") return value;
  const s = String(value ?? "").trim();
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "h":
      return n * 3600_000;
    case "d":
      return n * 86_400_000;
    default:
      return n * 60_000;
  }
}

const BASE_PARAMS: Record<string, unknown> = {
  zone: "zone-1",
  heater: HEATER,
  heaterPower: 2200,
  minTemp: 20,
  rescueTemp: 25,
  hcMode: "late",
  hcEstimate: "3h",
  fullCycleEveryDays: 0,
  solarMode: "off",
  surplusStartPower: 2400,
  maxGridImport: 200,
  surplusStartDelay: "3m",
  surplusStopDelay: "5m",
  cutoffPower: 300,
  cutoffDelay: "5m",
  maxCycle: "5h",
};

/** Advance both the fake clock and the recipe's 30 s reconciliation ticker. */
async function advance(minutes: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(minutes * 60_000);
}

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

// ============================================================
// Pure helpers
// ============================================================

describe("time helpers", () => {
  it("round-trips HH:MM through minutes", () => {
    expect(hmToMinutes("22:00")).toBe(1320);
    expect(minutesToHm(1320)).toBe("22:00");
    expect(minutesToHm(-60)).toBe("23:00");
    expect(minutesToHm(1500)).toBe("01:00");
  });

  it("handles a window that wraps over midnight", () => {
    expect(isWithinWindow(hmToMinutes("23:00"), 1320, 360)).toBe(true);
    expect(isWithinWindow(hmToMinutes("03:00"), 1320, 360)).toBe(true);
    expect(isWithinWindow(hmToMinutes("12:00"), 1320, 360)).toBe(false);
    expect(isWithinWindow(hmToMinutes("06:00"), 1320, 360)).toBe(false); // end excluded
    expect(isWithinWindow(hmToMinutes("22:00"), 1320, 360)).toBe(true); // start included
  });

  it("measures a wrapping window's length", () => {
    expect(windowLength(1320, 360)).toBe(480); // 22:00 → 06:00
    expect(windowLength(360, 1320)).toBe(960);
    expect(windowLength(600, 600)).toBe(1440);
  });
});

describe("computeHcHeatWindow", () => {
  const hcStart = hmToMinutes("22:00");
  const hcEnd = hmToMinutes("06:00");

  it("pushes a late cycle against the end of the window", () => {
    const w = computeHcHeatWindow(hcStart, hcEnd, "late", 180);
    expect(minutesToHm(w.startMin)).toBe("03:00");
    expect(minutesToHm(w.endMin)).toBe("06:00");
  });

  it("anchors an early cycle at the start of the window", () => {
    const w = computeHcHeatWindow(hcStart, hcEnd, "early", 180);
    expect(minutesToHm(w.startMin)).toBe("22:00");
    expect(minutesToHm(w.endMin)).toBe("01:00");
  });

  it("uses the whole window in full mode", () => {
    const w = computeHcHeatWindow(hcStart, hcEnd, "full", 60);
    expect(minutesToHm(w.startMin)).toBe("22:00");
    expect(minutesToHm(w.endMin)).toBe("06:00");
  });

  it("clamps an estimate longer than the window back to the whole window", () => {
    const w = computeHcHeatWindow(hcStart, hcEnd, "late", 900);
    expect(minutesToHm(w.startMin)).toBe("22:00");
    expect(minutesToHm(w.endMin)).toBe("06:00");
  });
});

describe("pickMainOffPeakSlot", () => {
  it("returns null when there is nothing usable", () => {
    expect(pickMainOffPeakSlot([])).toBeNull();
    expect(pickMainOffPeakSlot([{ start: "nope", end: "06:00" }])).toBeNull();
  });

  it("takes the longest slot — the one with room for a full tank", () => {
    expect(
      pickMainOffPeakSlot([
        { start: "13:00", end: "16:00" }, // 3 h midday
        { start: "22:00", end: "06:00" }, // 8 h night
      ]),
    ).toEqual({ startMin: 1320, endMin: 360 });
  });

  it("keeps the first declared on a tie", () => {
    expect(
      pickMainOffPeakSlot([
        { start: "02:00", end: "06:00" },
        { start: "13:00", end: "17:00" },
      ]),
    ).toEqual({ startMin: 120, endMin: 360 });
  });

  it("skips malformed entries rather than failing", () => {
    expect(
      pickMainOffPeakSlot([{ start: "25:00", end: "06:00" }, { start: "23:00", end: "05:00" }]),
    ).toEqual({ startMin: 1380, endMin: 300 });
  });
});

describe("learnEstimate", () => {
  it("smooths a completed cycle towards the measured duration plus a margin", () => {
    // 0.6 * 180 + 0.4 * (90 + 20) = 152
    expect(learnEstimate(180, 90, true, 480)).toBe(152);
  });

  it("converges on the real duration after repeated cycles", () => {
    let est = 180;
    for (let i = 0; i < 12; i++) est = learnEstimate(est, 90, true, 480);
    expect(est).toBeGreaterThanOrEqual(108);
    expect(est).toBeLessThanOrEqual(112);
  });

  it("only ever grows when the cycle never reached the cut-off", () => {
    expect(learnEstimate(180, 0, false, 480)).toBe(225);
  });

  it("never exceeds the window length", () => {
    expect(learnEstimate(470, 0, false, 480)).toBe(480);
    expect(learnEstimate(400, 900, true, 480)).toBe(480);
  });
});

describe("resolveBindingAlias", () => {
  const bindings = [
    { alias: "state", category: "light_state" },
    { alias: "water_temperature", category: "temperature" },
    { alias: "active_power", category: "power" },
  ];

  it("honours an explicit override above everything", () => {
    expect(resolveBindingAlias(bindings, "state", "water_temperature", "temperature")).toBe("state");
  });

  it("prefers the conventional alias", () => {
    expect(resolveBindingAlias(bindings, "", "water_temperature", "temperature")).toBe(
      "water_temperature",
    );
  });

  it("falls back to the category, so a vendor alias still works", () => {
    expect(resolveBindingAlias(bindings, "", "power", "power")).toBe("active_power");
  });

  it("returns null when the reading is simply absent", () => {
    expect(resolveBindingAlias([{ alias: "state", category: "light_state" }], "", "power", "power")).toBeNull();
  });
});

describe("computeSurplus", () => {
  it("is null when solar is disabled or the reading is missing", () => {
    expect(computeSurplus("off", 1000, "import_positive", 0)).toBeNull();
    expect(computeSurplus("grid_injection", null, "import_positive", 0)).toBeNull();
  });

  it("reads export off a grid meter, honouring the sign convention", () => {
    expect(computeSurplus("grid_injection", -3000, "import_positive", 0)).toBe(3000);
    expect(computeSurplus("grid_injection", 3000, "import_negative", 0)).toBe(3000);
    expect(computeSurplus("grid_injection", 1500, "import_positive", 0)).toBe(-1500);
  });

  it("adds the heater's own draw back so it doesn't cut itself off", () => {
    // Exporting 3 kW, relay closes and eats 2.2 kW: raw export collapses to
    // 800 W but the *available* surplus is still 3 kW.
    expect(computeSurplus("grid_injection", -800, "import_positive", 2200)).toBe(3000);
  });

  it("ignores the self-draw term in production-only mode", () => {
    expect(computeSurplus("production_only", 2500, "import_positive", 2200)).toBe(2500);
  });

  it("caps the surplus at production — a house cannot export what it never made", () => {
    // Sign convention inverted: the meter says "exporting 3 kW" at night.
    expect(computeSurplus("grid_injection", -3000, "import_positive", 0, 0)).toBe(0);
    // Genuine surplus, below production: left untouched.
    expect(computeSurplus("grid_injection", -1500, "import_positive", 0, 4000)).toBe(1500);
    // Claimed export above production: clamped to what the panels deliver.
    expect(computeSurplus("grid_injection", -5000, "import_positive", 0, 3000)).toBe(3000);
  });

  it("leaves a negative surplus negative when capping", () => {
    expect(computeSurplus("grid_injection", 1200, "import_positive", 0, 0)).toBe(-1200);
  });
});

describe("findOnOffOrderAlias", () => {
  const eq = (orders: { alias: string; type?: string; category?: string; enumValues?: string[] }[]) =>
    ({ id: "x", name: "x", type: "switch", dataBindings: [], orderBindings: orders }) as never;

  it("prefers the conventional `state` alias", () => {
    expect(findOnOffOrderAlias(eq([{ alias: "power1" }, { alias: "state" }]))).toBe("state");
  });

  it("falls back to the toggle category, then to an ON/OFF enum", () => {
    expect(findOnOffOrderAlias(eq([{ alias: "relay", category: "light_toggle" }]))).toBe("relay");
    expect(findOnOffOrderAlias(eq([{ alias: "power1", enumValues: ["ON", "OFF"] }]))).toBe("power1");
  });

  it("returns null when the equipment has no on/off channel", () => {
    expect(findOnOffOrderAlias(eq([{ alias: "child_lock", category: "toggle_lock" }]))).toBeNull();
    expect(findOnOffOrderAlias(null)).toBeNull();
  });
});

// ============================================================
// validate()
// ============================================================

describe("validate", () => {
  it("accepts a well-formed configuration", () => {
    const { ctx } = buildHarness();
    expect(() => createRecipe().validate(BASE_PARAMS, ctx as never)).not.toThrow();
  });

  it("rejects a heater with no on/off order binding", () => {
    const { ctx } = buildHarness({ heaterOrders: [{ alias: "child_lock", category: "toggle_lock" }] });
    expect(() => createRecipe().validate(BASE_PARAMS, ctx as never)).toThrow(/on\/off order/);
  });

  it("rejects a recovery temperature at or below the minimum", () => {
    const { ctx } = buildHarness();
    expect(() =>
      createRecipe().validate({ ...BASE_PARAMS, minTemp: 30, rescueTemp: 30 }, ctx as never),
    ).toThrow(/above the minimum/);
  });

  it("refuses to run on a core that cannot serve the tariff", () => {
    const { ctx } = buildHarness({ noTariffHelper: true });
    expect(() => createRecipe().validate(BASE_PARAMS, ctx as never)).toThrow(
      /1\.36 or later is required/,
    );
  });

  it("refuses to run when no tariff is configured, and says where to fix it", () => {
    const { ctx } = buildHarness({
      tariff: { configured: false, offPeakToday: [], isOffPeakNow: null },
    });
    expect(() => createRecipe().validate(BASE_PARAMS, ctx as never)).toThrow(
      /Settings → Administration → Energy tariff/,
    );
  });

  it("accepts a configured tariff", () => {
    const { ctx } = buildHarness();
    expect(() => createRecipe().validate(BASE_PARAMS, ctx as never)).not.toThrow();
  });

  it("exposes no way to enter off-peak hours in the recipe", () => {
    // The instance owns the hours. A second place to type them is a second
    // place for them to be wrong, silently.
    const ids = createRecipe().slots.map((slot) => slot.id);
    expect(ids).not.toContain("hcStart");
    expect(ids).not.toContain("hcEnd");
    expect(ids).not.toContain("hcSource");
  });

  it("rejects a data key the heater does not expose", () => {
    const { ctx } = buildHarness();
    expect(() =>
      createRecipe().validate({ ...BASE_PARAMS, tempKey: "nope" }, ctx as never),
    ).toThrow(/no data binding/);
  });

  it("accepts a heater with no metering channel yet", () => {
    // The real case: the relay is in place, the power sensor is not fitted
    // yet. That must not block creating the instance.
    const { ctx } = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 60 },
      ],
    });
    expect(() => createRecipe().validate(BASE_PARAMS, ctx as never)).not.toThrow();
  });

  it("still rejects an override the user typed wrong", () => {
    const { ctx } = buildHarness();
    expect(() => createRecipe().validate({ ...BASE_PARAMS, powerKey: "nope" }, ctx as never)).toThrow(
      /no data binding with alias "nope"/,
    );
  });

  it("rejects a solar mode with no meter behind it", () => {
    const { ctx } = buildHarness();
    expect(() =>
      createRecipe().validate({ ...BASE_PARAMS, solarMode: "grid_injection" }, ctx as never),
    ).toThrow(/grid meter/);
  });

  it("rejects thresholds that would stop the heater as soon as it starts", () => {
    // 2200 W heater started at 2000 W exported draws 200 W from the grid, which
    // already meets a 200 W stop threshold: the relay would chatter.
    const { ctx } = buildHarness();
    expect(() =>
      createRecipe().validate(
        {
          ...BASE_PARAMS,
          solarMode: "grid_injection",
          gridEquipment: METER,
          heaterPower: 2200,
          surplusStartPower: 2000,
          maxGridImport: 200,
        },
        ctx as never,
      ),
    ).toThrow(/stop as soon as it starts/);
  });

  it("accepts the same thresholds once the tolerated draw clears the shortfall", () => {
    const { ctx } = buildHarness();
    expect(() =>
      createRecipe().validate(
        {
          ...BASE_PARAMS,
          solarMode: "grid_injection",
          gridEquipment: METER,
          heaterPower: 2200,
          surplusStartPower: 2000,
          maxGridImport: 201,
        },
        ctx as never,
      ),
    ).not.toThrow();
  });

  it("does not police the thresholds when solar is disabled", () => {
    // They are hidden in the form, so a stale pair must not block saving.
    const { ctx } = buildHarness();
    expect(() =>
      createRecipe().validate(
        { ...BASE_PARAMS, solarMode: "off", surplusStartPower: 0, maxGridImport: 0 },
        ctx as never,
      ),
    ).not.toThrow();
  });
});

// ============================================================
// Runtime behaviour
// ============================================================

describe("createInstance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing at midday with a warm tank, no solar", async () => {
    at("2026-08-09T14:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(5);
    expect(h.orderCalls).toHaveLength(0);
    expect(h.state.get("status")).toBe("off");
    handle.stop();
  });

  // ── 1. Hot-water floor ───────────────────────────────────

  it("rescues a cold tank at peak price, outside any off-peak window", async () => {
    at("2026-08-09T16:00:00"); // full peak tariff, gîte showers all afternoon
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 18 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.lastOrder()).toMatchObject({ equipmentId: HEATER, alias: "state", value: true });
    expect(h.state.get("reason")).toBe("floor");
    handle.stop();
  });

  it("keeps the rescue running past the minimum and stops at the recovery temperature", async () => {
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 18 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.orderCalls).toHaveLength(1);

    // Past the floor but short of recovery — the hysteresis must hold it on.
    h.setBinding(HEATER, "water_temperature", 22);
    await advance(6);
    expect(h.orderCalls).toHaveLength(1);
    expect(h.state.get("relayOn")).toBe(true);

    h.setBinding(HEATER, "water_temperature", 26);
    await advance(1);
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("does not chase the floor while the tank thermostat is already open", async () => {
    // Stratified tank: probe reads cold at the bottom, top is already hot.
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 18 },
        { alias: "power", category: "power", value: 0 },
      ],
      drawWhenOn: 0, // relay closes but the thermostat is open → no draw
      // An established install: the channel has already been seen carrying the
      // heater, so a collapse to zero is trustworthy from the first cycle.
      initialState: { powerProven: true },
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.orderCalls).toHaveLength(1); // it tries

    await advance(8); // startup grace + 5 min cut-off delay
    expect(h.state.get("tankFull")).toBe(true);
    expect(h.lastOrder()).toMatchObject({ value: false });

    const afterCutoff = h.orderCalls.length;
    await advance(30); // must not re-arm while the latch holds
    expect(h.orderCalls).toHaveLength(afterCutoff);
    handle.stop();
  });

  // ── 2. Off-peak placement ────────────────────────────────

  it("waits inside the off-peak window until the late cycle is due", async () => {
    at("2026-08-09T22:05:00"); // inside HC, but the 3 h cycle only starts at 03:00
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(5);

    expect(h.orderCalls).toHaveLength(0);
    expect(h.state.get("hcWindow")).toBe("03:00 → 06:00");
    handle.stop();
  });

  it("defaults to a 4 h heat-up, so an unlearned cycle still fills the tank", async () => {
    // Without a power channel the estimate never learns, so the shipped
    // default is what actually runs every night. 22:00→06:00 with 4 h puts
    // the cycle at 02:00→06:00.
    at("2026-08-09T22:05:00");
    const h = buildHarness();
    const { hcEstimate, maxCycle, ...defaults } = BASE_PARAMS;
    void hcEstimate;
    void maxCycle;
    const handle = createRecipe().createInstance(defaults, h.ctx as never);
    await advance(1);

    expect(h.state.get("hcWindow")).toBe("02:00 → 06:00");
    expect(h.orderCalls).toHaveLength(0); // not due yet at 22:05
    handle.stop();
  });

  it("starts the off-peak cycle once inside the computed heat window", async () => {
    at("2026-08-10T03:05:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("hc");
    handle.stop();
  });

  it("stops when the off-peak window closes and grows the estimate", async () => {
    at("2026-08-10T05:50:00");
    const h = buildHarness({ initialState: { powerProven: true } });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.lastOrder()).toMatchObject({ value: true });

    await advance(15); // crosses 06:00 — window closed, still drawing power
    expect(h.lastOrder()).toMatchObject({ value: false });
    expect(h.state.get("hcEstimateMin")).toBe(225); // 180 + 45
    handle.stop();
  });

  it("leaves the estimate alone when the power channel is unproven", async () => {
    // The window closed without a cut-off, but with an unproven channel that
    // says nothing: growing here would creep towards heating all night.
    at("2026-08-10T05:50:00");
    const h = buildHarness({ drawWhenOn: 0 });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.state.get("relayOn")).toBe(true);

    await advance(15); // past 06:00
    expect(h.lastOrder()).toMatchObject({ value: false });
    expect(h.state.get("hcEstimateMin")).toBe(180); // untouched
    handle.stop();
  });

  it("stops forcing a full window every night when there is no metering", async () => {
    // Without metering the cut-off is unobservable, so the periodic full cycle
    // would be permanently "due" and the late placement would never apply.
    at("2026-08-10T05:50:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 45 },
      ],
    });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, fullCycleEveryDays: 7 },
      h.ctx as never,
    );
    await advance(1);
    expect(h.state.get("hcWindow")).toBe("22:00 → 06:00"); // first night: forced full
    expect(h.state.get("relayOn")).toBe(true);

    await advance(15); // window closes at 06:00
    expect(h.state.get("lastFullCycleAt")).not.toBeNull();
    expect(h.state.get("hcWindow")).toBe("03:00 → 06:00"); // late placement resumes
    handle.stop();
  });

  it("uses the whole window when a periodic full cycle is due", async () => {
    at("2026-08-09T22:05:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, fullCycleEveryDays: 7 },
      h.ctx as never,
    );
    await advance(1);

    // Never had a full cycle → forced to "full", so heating starts right away.
    expect(h.state.get("hcWindow")).toBe("22:00 → 06:00");
    expect(h.lastOrder()).toMatchObject({ value: true });
    handle.stop();
  });

  // ── 2b. Off-peak hours read from the instance tariff ─────

  const NIGHT_TARIFF = {
    configured: true,
    offPeakToday: [{ start: "23:00", end: "07:00", tariff: "hc" }],
    isOffPeakNow: false,
  };

  it("follows the instance tariff when it changes", async () => {
    // The instance says 23:00→07:00 tonight. With a 3 h estimate and `late`
    // placement the cycle lands at 04:00→07:00 — no recipe-side copy involved.
    at("2026-08-09T22:30:00");
    const h = buildHarness({ tariff: NIGHT_TARIFF });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.state.get("hcWindow")).toBe("04:00 → 07:00");
    expect(h.state.get("hcWindowToday")).toBe("23:00→07:00");
    handle.stop();
  });

  it("heats on the tariff window, not on the stale slot values", async () => {
    // 06:30 is outside the recipe's own 22:00→06:00 slots but inside the
    // tariff's 23:00→07:00 heat window.
    at("2026-08-10T06:30:00");
    const h = buildHarness({ tariff: NIGHT_TARIFF });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("hc");
    handle.stop();
  });

  it("disables off-peak heating on a core with no tariff helper", async () => {
    // Nothing to fall back to: in automatic mode the recipe's own time fields
    // are hidden, so using them would drive the heater from invisible values.
    at("2026-08-09T22:30:00");
    const h = buildHarness({ noTariffHelper: true }); // Sowel < 1.36
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(10);

    expect(h.state.get("hcWindow")).toBeNull();
    expect(h.orderCalls).toHaveLength(0);
    expect(h.logLines.some((l) => l.includes("n'expose pas le tarif"))).toBe(true);
    handle.stop();
  });

  it("disables off-peak heating when no tariff is configured, and says how to fix it", async () => {
    at("2026-08-09T22:30:00");
    const h = buildHarness({
      tariff: { configured: false, offPeakToday: [], isOffPeakNow: null },
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(10);

    expect(h.state.get("hcWindow")).toBeNull();
    expect(h.orderCalls).toHaveLength(0);
    const msg = h.logLines.find((l) => l.includes("Aucun tarif configuré"));
    expect(msg).toContain("Tarif d'énergie");
    handle.stop();
  });

  it("keeps the floor working while off-peak heating is disabled", async () => {
    // Losing the tariff must not leave the house without hot water.
    at("2026-08-09T22:30:00");
    const h = buildHarness({
      tariff: { configured: false, offPeakToday: [], isOffPeakNow: null },
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 15 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("floor");
    handle.stop();
  });

  it("skips the night on a day the schedule does not cover", async () => {
    at("2026-08-09T22:30:00");
    const h = buildHarness({
      tariff: { configured: true, offPeakToday: [], isOffPeakNow: false },
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(10);

    expect(h.state.get("hcWindow")).toBeNull();
    expect(h.orderCalls).toHaveLength(0);
    expect(h.logLines.some((l) => l.includes("aucune heure creuse aujourd'hui"))).toBe(true);
    handle.stop();
  });

  it("disables off-peak heating when the tariff read throws", async () => {
    at("2026-08-09T22:30:00");
    const h = buildHarness({ tariffThrows: true });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(2);

    expect(h.state.get("hcWindow")).toBeNull();
    expect(h.logLines.some((l) => l.includes("Lecture du tarif Sowel impossible"))).toBe(true);
    handle.stop();
  });

  it("picks the night slot when the tariff declares several", async () => {
    at("2026-08-09T22:30:00");
    const h = buildHarness({
      tariff: {
        configured: true,
        offPeakToday: [
          { start: "13:00", end: "16:00", tariff: "hc" },
          { start: "23:00", end: "07:00", tariff: "hc" },
        ],
        isOffPeakNow: false,
      },
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.state.get("hcWindow")).toBe("04:00 → 07:00");
    expect(h.logLines.some((l) => l.includes("2 plages"))).toBe(true);
    handle.stop();
  });

  // ── 3. Cut-off detection and learning ────────────────────

  it("detects the thermostat cut-off from the power collapse and learns the duration", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.lastOrder()).toMatchObject({ value: true });

    await advance(89); // 90 min of real heating
    expect(h.state.get("relayOn")).toBe(true);

    h.setBinding(HEATER, "power", 4); // thermostat opens
    await advance(6); // > 5 min cut-off delay

    expect(h.state.get("tankFull")).toBe(true);
    expect(h.lastOrder()).toMatchObject({ value: false });
    // 0.6 * 180 + 0.4 * (90 + 20) = 152
    expect(h.state.get("hcEstimateMin")).toBe(152);
    handle.stop();
  });

  it("ignores the power reading during the start-up grace period", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness({ drawWhenOn: 0 });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.state.get("relayOn")).toBe(true);

    await advance(1); // still inside the 90 s grace
    expect(h.state.get("tankFull")).toBeFalsy();
    handle.stop();
  });

  it("refuses to learn from a top-up cycle on an already-hot tank", async () => {
    // Same shape as the cut-off test above, but the thermostat opens after ten
    // minutes instead of ninety. Smoothing that in would drag a 3 h estimate
    // to 2 h, and two sunny days would leave the off-peak placement too short
    // to ever fill a drawn tank again.
    at("2026-08-10T03:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.lastOrder()).toMatchObject({ value: true });

    await advance(9);
    h.setBinding(HEATER, "power", 4); // thermostat opens after ~10 min
    await advance(6);

    expect(h.state.get("tankFull")).toBe(true);
    expect(h.state.get("hcEstimateMin")).toBe(180); // untouched
    handle.stop();
  });

  it("remembers a probe-backed hot tank long enough to skip the night cycle", async () => {
    // Filled by the sun at 15:00; the off-peak cycle would otherwise close the
    // relay again at 03:00 on a tank that is still at temperature.
    at("2026-08-10T03:10:00");
    const h = buildHarness({
      initialState: {
        tankFull: true,
        tankFullAt: new Date("2026-08-09T15:00:00").toISOString(), // 12 h 10 ago
        tankFullTemp: 58,
        hcEstimateMin: 180,
      },
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 56 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, tankFullMemory: "14h" },
      h.ctx as never,
    );
    await advance(2);

    expect(h.state.get("tankFull")).toBe(true);
    expect(h.orderCalls).toHaveLength(0);
    handle.stop();
  });

  it("keeps the blind two-hour ceiling when no probe can corroborate it", async () => {
    at("2026-08-10T03:10:00");
    const h = buildHarness({
      initialState: {
        tankFull: true,
        tankFullAt: new Date("2026-08-09T15:00:00").toISOString(),
        tankFullTemp: null,
      },
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, tankFullMemory: "14h" },
      h.ctx as never,
    );
    await advance(2);

    expect(h.state.get("tankFull")).toBe(false);
    expect(h.lastOrder()).toMatchObject({ value: true }); // off-peak cycle runs
    handle.stop();
  });

  it("releases the tank-full latch when the probe shows a real draw-off", async () => {
    at("2026-08-09T14:00:00");
    const h = buildHarness({
      initialState: {
        tankFull: true,
        tankFullAt: new Date("2026-08-09T13:45:00").toISOString(),
        tankFullTemp: 50,
      },
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 50 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.state.get("tankFull")).toBe(true);

    h.setBinding(HEATER, "water_temperature", 15); // showers: -35 °C, well past the floor
    await advance(1);

    expect(h.state.get("tankFull")).toBe(false);
    expect(h.state.get("reason")).toBe("floor");
    expect(h.lastOrder()).toMatchObject({ value: true });
    handle.stop();
  });

  // ── 4. Solar surplus ─────────────────────────────────────

  const SOLAR_PARAMS = {
    ...BASE_PARAMS,
    solarMode: "grid_injection",
    gridEquipment: METER,
    gridSign: "import_positive",
  };

  it("waits for the surplus to be confirmed before closing the relay", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(SOLAR_PARAMS, h.ctx as never);

    h.setBinding(METER, "power", -2500); // exporting 2.5 kW > 2200 + 200
    await advance(2); // under the 3 min confirmation
    expect(h.orderCalls).toHaveLength(0);

    await advance(2);
    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("solar");
    handle.stop();
  });

  it("does not cut itself off when its own draw eats the export", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(SOLAR_PARAMS, h.ctx as never);

    h.setBinding(METER, "power", -2500);
    await advance(4);
    expect(h.lastOrder()).toMatchObject({ value: true });

    // Relay closed: export collapses to 300 W, but the heater is the one
    // eating it. Effective surplus is still 2500 W → keep heating.
    h.setBinding(METER, "power", -300);
    await advance(10);
    expect(h.state.get("relayOn")).toBe(true);
    handle.stop();
  });

  it("rides out a passing cloud, then stops when the surplus is really gone", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(SOLAR_PARAMS, h.ctx as never);

    h.setBinding(METER, "power", -2500);
    await advance(4);
    expect(h.state.get("relayOn")).toBe(true);

    h.setBinding(METER, "power", 1500); // importing: effective surplus 700 W
    await advance(3); // under the 5 min loss delay
    expect(h.state.get("relayOn")).toBe(true);

    await advance(3);
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("refuses to heat on a mis-signed meter when production contradicts it", async () => {
    // Evening: the grid clamp claims a 3 kW export while the panels make
    // nothing. The production cap turns a costly mistake into a no-op.
    at("2026-08-09T20:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...SOLAR_PARAMS, productionEquipment: PRODUCTION },
      h.ctx as never,
    );

    h.setBinding(METER, "power", -3000);
    h.setBinding(PRODUCTION, "power", 0);
    await advance(10);

    expect(h.orderCalls).toHaveLength(0);
    expect(h.state.get("surplus")).toBe(0);
    expect(h.logLines.some((l) => l.includes("signe"))).toBe(true);
    handle.stop();
  });

  it("heats normally when production backs the announced export", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...SOLAR_PARAMS, productionEquipment: PRODUCTION },
      h.ctx as never,
    );

    h.setBinding(METER, "power", -2500);
    h.setBinding(PRODUCTION, "power", 4000);
    await advance(4);

    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("solar");
    handle.stop();
  });

  it("stops as soon as the grid supplies more than tolerated", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(SOLAR_PARAMS, h.ctx as never);

    h.setBinding(METER, "power", -2500);
    await advance(4);
    expect(h.state.get("relayOn")).toBe(true);

    // Importing 500 W — above the 200 W tolerance, so this is a purchase, not
    // a surplus. Effective surplus 2200-500 = 1700 < stop threshold 2000.
    h.setBinding(METER, "power", 500);
    await advance(6);
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("keeps heating through a grid draw within tolerance", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(SOLAR_PARAMS, h.ctx as never);

    h.setBinding(METER, "power", -2500);
    await advance(4);
    expect(h.state.get("relayOn")).toBe(true);

    h.setBinding(METER, "power", 100); // under the 200 W tolerance
    await advance(10);
    expect(h.state.get("relayOn")).toBe(true);
    handle.stop();
  });

  it("a picky start threshold does not licence buying power to keep going", async () => {
    // The regression a single symmetric margin caused: widening it to be
    // selective about starting also dragged the stop threshold down, so the
    // recipe kept heating while importing ~2 kW at peak price. The two
    // thresholds are independent precisely so that cannot happen again.
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...SOLAR_PARAMS, surplusStartPower: 4200 },
      h.ctx as never,
    );

    h.setBinding(METER, "power", -4500); // exporting 4500 >= 4200, starts
    await advance(4);
    expect(h.state.get("relayOn")).toBe(true);

    h.setBinding(METER, "power", 1800); // importing 1.8 kW
    await advance(6);
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("holds out for a comfortable export when the start threshold is high", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...SOLAR_PARAMS, surplusStartPower: 4200 },
      h.ctx as never,
    );

    h.setBinding(METER, "power", -3000); // exporting 3000 < 4200 — not enough
    await advance(10);
    expect(h.orderCalls).toHaveLength(0);
    handle.stop();
  });

  it("reads the start threshold as raw exported watts, not a margin", async () => {
    // The whole point of the parameter: 2500 means "the meter shows 2500 W
    // going out", with no arithmetic against the heater power.
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...SOLAR_PARAMS, heaterPower: 2200, surplusStartPower: 2500 },
      h.ctx as never,
    );

    h.setBinding(METER, "power", -2400); // 2400 < 2500 — just short
    await advance(10);
    expect(h.orderCalls).toHaveLength(0);

    h.setBinding(METER, "power", -2500); // exactly on the threshold
    await advance(4);
    expect(h.lastOrder()).toMatchObject({ value: true });
    handle.stop();
  });

  it("starts below the heater power when the tolerated grid draw covers it", async () => {
    // 2200 W heater started at 2000 W exported puts 200 W on the grid, which a
    // 400 W tolerance absorbs — so it starts AND keeps running.
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...SOLAR_PARAMS, heaterPower: 2200, surplusStartPower: 2000, maxGridImport: 400 },
      h.ctx as never,
    );

    h.setBinding(METER, "power", -2000);
    await advance(4);
    expect(h.lastOrder()).toMatchObject({ value: true });

    // Export collapsed to the 200 W draw the heater itself created: surplus is
    // back to 2000, above the 1800 stop threshold, so it must hold.
    h.setBinding(METER, "power", 200);
    await advance(10);
    expect(h.lastOrder()).toMatchObject({ value: true });
    handle.stop();
  });

  it("publishes the thresholds it is actually comparing against", async () => {
    // "Why didn't it start?" must be answerable from the instance state alone.
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...SOLAR_PARAMS, heaterPower: 2200, surplusStartPower: 4000, maxGridImport: 200 },
      h.ctx as never,
    );

    h.setBinding(METER, "power", -1989); // exactly the reported situation
    await advance(10);

    expect(h.state.get("surplus")).toBe(1989);
    expect(h.state.get("solarStartAt")).toBe(4000);
    expect(h.state.get("solarStopAt")).toBe(2000);
    expect(h.orderCalls).toHaveLength(0);
    handle.stop();
  });

  it("starts on a modest export once the threshold is sized sensibly", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...SOLAR_PARAMS, heaterPower: 2200, surplusStartPower: 2500 },
      h.ctx as never,
    );

    h.setBinding(METER, "power", -2600); // exporting 2600 >= 2500
    await advance(4);
    expect(h.lastOrder()).toMatchObject({ value: true });
    handle.stop();
  });

  /**
   * Solar used to be switched off across the whole off-peak window. That is
   * invisible on a night window — nothing is exporting at 23:00 — and wrong on
   * a daytime one: the Enedis afternoon HC slots sit in full production, and
   * declining free watts there to wait for cheap ones inverts the point.
   */
  it("heats on solar inside the off-peak window, outside the placement cycle", async () => {
    at("2026-08-09T12:30:00"); // inside a midday HC slot, before the late cycle
    const h = buildHarness({
      tariff: {
        configured: true,
        offPeakToday: [{ start: "11:00", end: "16:00", tariff: "hc" }],
        isOffPeakNow: true,
      },
    });
    const handle = createRecipe().createInstance(
      { ...SOLAR_PARAMS, hcEstimate: "1h" }, // placement = 15:00 → 16:00
      h.ctx as never,
    );

    h.setBinding(METER, "power", -4000);
    await advance(10);
    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("solar");
    handle.stop();
  });

  it("lets the placement cycle own the relay when both reasons apply", async () => {
    at("2026-08-09T15:30:00"); // inside the placement sub-window
    const h = buildHarness({
      tariff: {
        configured: true,
        offPeakToday: [{ start: "11:00", end: "16:00", tariff: "hc" }],
        isOffPeakNow: true,
      },
    });
    const handle = createRecipe().createInstance(
      { ...SOLAR_PARAMS, hcEstimate: "1h" },
      h.ctx as never,
    );

    h.setBinding(METER, "power", -4000);
    await advance(10);
    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("hc");
    handle.stop();
  });

  // ── 5. Relay protection, manual override, restarts ───────

  it("holds the relay closed for the minimum on-time", async () => {
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 18 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.orderCalls).toHaveLength(1);

    h.setBinding(HEATER, "water_temperature", 40); // instantly satisfied
    await advance(2);
    expect(h.orderCalls).toHaveLength(1); // still held

    await advance(4);
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("stands down when a human switches the heater on", async () => {
    at("2026-08-09T14:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    h.setBinding(HEATER, "state", "ON"); // somebody hit the switch
    h.setBinding(HEATER, "power", 2200);
    await advance(3); // past the 60 s confirmation

    expect(h.state.get("status")).toBe("manual");
    expect(h.orderCalls).toHaveLength(0); // no counter-order
    expect(h.logLines.some((l) => l.includes("manuellement"))).toBe(true);
    handle.stop();
  });

  it("resynchronises when the relay is switched off behind its back", async () => {
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 18 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.state.get("relayOn")).toBe(true);

    h.setBinding(HEATER, "state", "OFF");
    h.setBinding(HEATER, "power", 0);
    await advance(3);

    expect(h.state.get("relayOn")).toBe(false);
    expect(h.logLines.some((l) => l.includes("resynchronisé"))).toBe(true);
    handle.stop();
  });

  it("resumes an in-flight cycle after a restart instead of restarting it", async () => {
    at("2026-08-10T04:00:00");
    const h = buildHarness({
      initialState: {
        relayOn: true,
        reason: "hc",
        onSince: new Date("2026-08-10T03:00:00").toISOString(),
        hcEstimateMin: 150,
      },
      heaterBindings: [
        { alias: "state", category: "light_state", value: "ON" },
        { alias: "water_temperature", category: "temperature", value: 45 },
        { alias: "power", category: "power", value: 2200 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.orderCalls).toHaveLength(0); // no redundant ON
    expect(h.state.get("relayOn")).toBe(true);

    // The cycle keeps its original start time, so the learned duration counts
    // the full 60 min already elapsed, not just the time since the restart.
    h.setBinding(HEATER, "power", 0);
    await advance(7);
    // The power collapsed 62 min after the *original* start, not 2 min after
    // the restart: 0.6 * 150 + 0.4 * (62 + 20) = 122.8 → 123. Had the restart
    // reset the clock, the estimate would have collapsed towards ~90.
    expect(h.state.get("hcEstimateMin")).toBe(123);
    handle.stop();
  });

  it("enforces the maximum continuous run", async () => {
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 10 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, maxCycle: "30m", cutoffDelay: "10h" },
      h.ctx as never,
    );
    await advance(1);
    expect(h.state.get("relayOn")).toBe(true);

    await advance(31); // temperature never recovers — only the cap can stop it
    expect(h.lastOrder()).toMatchObject({ value: false });
    expect(h.logLines.some((l) => l.includes("Garde-fou"))).toBe(true);
    handle.stop();
  });

  // ── 6. Modes ─────────────────────────────────────────────

  it("boosts on demand and returns to auto once the tank is full", async () => {
    at("2026-08-09T14:00:00");
    const h = buildHarness({ drawWhenOn: 2200 });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.orderCalls).toHaveLength(0);

    handle.onAction?.("set_mode", { mode: "boost" });
    await advance(1);
    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("boost");

    h.setBinding(HEATER, "power", 0);
    await advance(7);
    expect(h.state.get("mode")).toBe("auto");
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("sends no order at all while paused", async () => {
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 12 },
        { alias: "power", category: "power", value: 0 },
      ],
      initialState: { mode: "off" },
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(10);

    expect(h.orderCalls).toHaveLength(0);
    handle.stop();
  });

  // ── 7. Degraded configurations ───────────────────────────

  it("runs off-peak only when the heater carries no probe", async () => {
    at("2026-08-10T03:05:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("hc");
    expect(h.logLines.some((l) => l.includes("chauffe de secours est inactive"))).toBe(true);
    handle.stop();
  });

  it("bounds the cycle by the window when the heater has no metering", async () => {
    at("2026-08-10T05:50:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 45 },
      ],
      drawWhenOn: 0,
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.lastOrder()).toMatchObject({ value: true });

    await advance(15); // 06:00 passed
    expect(h.lastOrder()).toMatchObject({ value: false });
    expect(h.state.get("tankFull")).toBe(false);
    handle.stop();
  });

  it("suspends the floor when the probe has gone quiet for too long", async () => {
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        {
          alias: "water_temperature",
          category: "temperature",
          value: 5,
          stale: true,
          lastUpdated: "2026-08-09 02:50:29Z", // 13 h old, like the real probe
        },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(5);

    expect(h.orderCalls).toHaveLength(0); // a 13 h old 5 °C must not trigger a rescue
    expect(h.logLines.some((l) => l.includes("muette"))).toBe(true);
    handle.stop();
  });

  it("still trusts a sparse probe that core flags stale but is recent enough", async () => {
    // Core marks `temperature` stale after 15 min. A tank does not cool in
    // 20 min, so the reading is still actionable.
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        {
          alias: "water_temperature",
          category: "temperature",
          value: 12,
          stale: true,
          lastUpdated: "2026-08-09 15:40:00Z",
        },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("floor");
    handle.stop();
  });

  it("refuses to declare the tank full while the power channel is unproven", async () => {
    // Relay closes, nothing ever draws: could be a hot tank, could be a sensor
    // watching the wrong circuit. Without proof, never conclude "full".
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 18 },
        { alias: "power", category: "power", value: 0 },
      ],
      drawWhenOn: 0,
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(20);

    expect(h.state.get("tankFull")).toBe(false);
    expect(h.state.get("relayOn")).toBe(true); // keeps trying rather than latching off
    handle.stop();
  });

  it("proves the power channel on the first real draw, then trusts it", async () => {
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 18 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(3); // relay closes, harness reports 2200 W
    expect(h.state.get("powerProven")).toBe(true);

    h.setBinding(HEATER, "power", 0);
    await advance(6);
    expect(h.state.get("tankFull")).toBe(true);
    handle.stop();
  });

  it("picks up a metering channel bound after the instance was created", async () => {
    // The relay is installed before the power sensor. When the sensor is
    // added later, cut-off detection must start working on its own — no
    // param edit, no restart.
    at("2026-08-10T03:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 45 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.state.get("relayOn")).toBe(true);
    expect(h.state.get("power")).toBeNull();

    // Sensor fitted and bound: it reports the resistor pulling.
    h.setBinding(HEATER, "power", 2200);
    await advance(2);
    expect(h.state.get("powerProven")).toBe(true);

    h.setBinding(HEATER, "power", 0); // thermostat opens
    await advance(6);
    expect(h.state.get("tankFull")).toBe(true);
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("finds a vendor-named metering channel by category", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 45 },
        { alias: "active_power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    h.setBinding(HEATER, "active_power", 2200);
    await advance(2);
    expect(h.state.get("powerProven")).toBe(true);
    expect(h.logLines.some((l) => l.includes('"active_power" validée'))).toBe(true);
    handle.stop();
  });

  // ── 8. Teardown ──────────────────────────────────────────

  it("stops cleanly and leaves the relay untouched", async () => {
    at("2026-08-09T16:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 18 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    const ordersBefore = h.orderCalls.length;

    handle.stop();
    handle.stop(); // idempotent

    await advance(30);
    expect(h.orderCalls).toHaveLength(ordersBefore); // no OFF, no further ticks
    expect(h.state.get("relayOn")).toBe(true); // persisted for the next instance
    h.fireDataChanged(HEATER, "water_temperature"); // no listener left
    expect(h.orderCalls).toHaveLength(ordersBefore);
  });
});

// ============================================================
// Form shape — what the recipe promises the UI
// ============================================================

describe("form shape", () => {
  /**
   * The recipe form lays a group out as `n <= 3 ? n : 2` columns, so a cell is
   * ~120 px wide in a group of three and ~180 px in one of two. A label or a
   * help line longer than its cell wraps, pushing its field below its
   * neighbours' — which is exactly how the off-peak row came out crooked.
   */
  const THREE_COLUMN_GROUPS = new Set(["floor", "hc", "solar", "advanced"]);

  const fields = () =>
    createRecipe()
      .slots // the form drops the zone slot and renders list slots full width
      .filter((s) => s.group && s.id !== "zone");

  it("keeps every label on one line", () => {
    const fr = createRecipe().i18n?.fr?.slots ?? {};
    for (const slot of fields()) {
      const budget = THREE_COLUMN_GROUPS.has(slot.group!) ? 14 : 20;
      expect(slot.name.length, `${slot.id} EN "${slot.name}"`).toBeLessThanOrEqual(budget);
      const name = fr[slot.id]?.name ?? "";
      expect(name.length, `${slot.id} FR "${name}"`).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps every help line on one line", () => {
    const fr = createRecipe().i18n?.fr?.slots ?? {};
    for (const slot of fields()) {
      const budget = slot.list ? 40 : THREE_COLUMN_GROUPS.has(slot.group!) ? 20 : 30;
      expect(slot.description.length, `${slot.id} EN "${slot.description}"`).toBeLessThanOrEqual(
        budget,
      );
      const desc = fr[slot.id]?.description ?? "";
      expect(desc.length, `${slot.id} FR "${desc}"`).toBeLessThanOrEqual(budget);
    }
  });

  it("fills every grid row — no group of five", () => {
    const counts = new Map<string, number>();
    for (const slot of fields()) {
      if (slot.list) continue;
      counts.set(slot.group!, (counts.get(slot.group!) ?? 0) + 1);
    }
    for (const [group, n] of counts) {
      expect([1, 2, 3, 4, 6, 8], `${group} has ${n} fields`).toContain(n);
    }
  });

  it("translates every slot into French", () => {
    const fr = createRecipe().i18n?.fr?.slots ?? {};
    for (const slot of createRecipe().slots) {
      expect(fr[slot.id], `missing fr i18n for ${slot.id}`).toBeTruthy();
    }
  });
});
