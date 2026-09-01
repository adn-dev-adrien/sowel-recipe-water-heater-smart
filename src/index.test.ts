import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  tankCapacityWh,
  modelMeanC,
  modelHotLitres,
  applyEnergy,
  anchorOnCutoff,
  learnColdInlet,
  calibrateDrawCoefficient,
  showersFromRise,
  createRecipe,
  resolveBindingAlias,
  computeHcHeatWindow,
  pickMainOffPeakSlot,
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
const FORECAST = "forecast-1";

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
  /** Models a Sowel older than 1.39: `ctx.helpers.energy` does not exist. */
  noEnergyHelper?: boolean;
  /** What the fake arbiter answers to a claim. Default: accepts it (pending). */
  denyClaimWith?: "not-profiled" | "equipment-already-claimed" | "arbiter-disabled" | "override-active";
  /** `getCapacityState().enabled`. */
  arbiterEnabled?: boolean;
  /** `getCapacityState().availableSurplusW` — >0 means the sun is producing. */
  availableSurplusW?: number | null;
  /** Tomorrow's forecast condition on the fake forecast equipment. */
  tomorrow?: string;
  /** Energy profile on the heater, i.e. an admin enrolled it (spec 140). */
  heaterProfile?: {
    class: "comfort" | "deferrable";
    nominalPowerW: number;
    minOnS: number;
    minOffS: number;
    toleratedImportW?: number;
  } | null;
  /** Models a Sowel older than 1.60: the handle has no `reportNeed`. */
  noReportNeed?: boolean;
  /** Makes `reportNeed` throw, to prove a broken core cannot break the tick. */
  reportNeedThrows?: boolean;
}

/**
 * Stand-in for the core capacity arbiter.
 *
 * It deliberately implements no arbitration: the point of spec 140 is that
 * hysteresis, reservation accounting and priority live in core, so the recipe
 * has nothing left to test there. What is worth testing is the *contract* —
 * that a grant heats, a revoke stops, a denial degrades gracefully, and the
 * claim is held and released at the right moments. So the fake just records
 * claims and lets the test pull the strings.
 */
interface FakeClaim {
  equipmentId: string;
  watts?: number;
  toleratedImportW?: number;
  slack?: string;
  status: "pending" | "granted" | "denied" | "released";
  onGranted: () => void;
  onRevoked: (reason: string) => void;
  /** Spec 166 — every value the recipe declared, in order. */
  needs: boolean[];
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

  const heaterProfile =
    opts.heaterProfile === undefined
      ? { class: "deferrable" as const, nominalPowerW: 2200, minOnS: 300, minOffS: 300 }
      : opts.heaterProfile;

  const equipments: Record<string, Record<string, unknown>> = {
    [HEATER]: {
      id: HEATER,
      name: "Chauffe-eau",
      type: "water_heater",
      status: "online",
      dataBindings: heaterBindings,
      orderBindings: heaterOrders,
      ...(heaterProfile ? { energyProfile: heaterProfile } : {}),
    },
    [METER]: {
      id: METER,
      name: "Compteur général",
      type: "main_energy_meter",
      status: "online",
      dataBindings: meterBindings,
      orderBindings: [],
    },
    [FORECAST]: {
      id: FORECAST,
      name: "Prévision",
      type: "weather_forecast",
      status: "online",
      dataBindings: [
        { alias: "j1_condition", category: "weather_condition", value: opts.tomorrow ?? "sunny" },
      ] as Binding[],
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

  let surplusW: number | null = opts.availableSurplusW === undefined ? 1500 : opts.availableSurplusW;

  const claims: FakeClaim[] = [];
  const energyHelper = {
    claimCapacity: (req: {
      equipmentId: string;
      watts?: number;
      toleratedImportW?: number;
      slack?: string;
      onGranted: () => void;
      onRevoked: (reason: string) => void;
    }) => {
      const record: FakeClaim = {
        equipmentId: req.equipmentId,
        watts: req.watts,
        toleratedImportW: req.toleratedImportW,
        slack: req.slack,
        status: opts.denyClaimWith ? "denied" : "pending",
        onGranted: req.onGranted,
        onRevoked: req.onRevoked,
        needs: [],
      };
      claims.push(record);
      return {
        id: `claim-${claims.length}`,
        status: () => record.status,
        deniedReason: opts.denyClaimWith,
        release: () => {
          if (record.status !== "denied") record.status = "released";
        },
        // Spec 166. Absent on a core older than 1.60 — the recipe must cope.
        ...(opts.noReportNeed
          ? {}
          : {
              reportNeed: (need: boolean) => {
                if (opts.reportNeedThrows) throw new Error("arbiter exploded");
                record.needs.push(need);
              },
            }),
      };
    },
    getCapacityState: () => ({
      enabled: opts.arbiterEnabled ?? true,
      availableSurplusW: surplusW,
      grants: [] as Array<{ equipmentId: string; watts: number; sinceIso: string }>,
    }),
  };

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
      ...(opts.noEnergyHelper ? {} : { energy: energyHelper }),
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
    claims,
    /** Move the arbiter's reported surplus, i.e. the sun coming up. */
    sunUp: (w: number | null) => {
      surplusW = w;
    },
    /** The claim the recipe currently holds, if it holds one. */
    liveClaim: () => claims.find((c) => c.status === "pending" || c.status === "granted"),
    grant: () => {
      const c = claims.find((x) => x.status === "pending");
      if (!c) throw new Error("no pending claim to grant");
      c.status = "granted";
      c.onGranted();
    },
    revoke: (reason = "surplus-deficit") => {
      const c = claims.find((x) => x.status === "granted");
      if (!c) throw new Error("no granted claim to revoke");
      c.status = "pending"; // core leaves a revoked claim queued
      c.onRevoked(reason);
    },
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

/** The form as a user now fills it: no solar anything, and the heater rating
 *  left to the energy profile. */
const BASE_PARAMS: Record<string, unknown> = {
  zone: "zone-1",
  heater: HEATER,
  minTemp: 20,
  rescueTemp: 25,
  hcMode: "late",
  hcEstimate: "3h",
  fullCycleEveryDays: 0,
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

// ============================================================
// Tank charge observer
// ============================================================

describe("tank model", () => {
  const base = () => ({ storedWh: 0, coldC: 23, fullC: 63, drawWhPerC: 120, showerWh: 1500, anchored: false });

  it("prices the tank from its volume and learned span", () => {
    // 280 L raised 40 K = 280 * 1.163 * 40 = 13 026 Wh, the figure the night
    // cycles corroborate (149 min at 2.43 kW on a 46 %-drained tank).
    expect(Math.round(tankCapacityWh(280, base()))).toBe(13026);
  });

  it("reports the mean the probe cannot give", () => {
    const m = { ...base(), storedWh: 6513 }; // half charge
    expect(Math.round(modelMeanC(280, m) ?? 0)).toBe(43);
    expect(Math.round(modelHotLitres(280, m) ?? 0)).toBe(140);
  });

  it("clamps energy at empty and at full", () => {
    const cap = tankCapacityWh(280, base());
    expect(applyEnergy(base(), cap, -5000).storedWh).toBe(0);
    expect(applyEnergy({ ...base(), storedWh: cap }, cap, 5000).storedWh).toBe(cap);
  });

  it("anchors on the thermostat and retrains the full temperature", () => {
    const m = anchorOnCutoff({ ...base(), storedWh: 1000 }, 280, 61.5);
    expect(m.fullC).toBe(61.5);
    expect(m.storedWh).toBe(tankCapacityWh(280, m)); // drift discarded
  });

  it("learns the cold inlet from the coldest reading ever seen", () => {
    expect(learnColdInlet(base(), 21.4).coldC).toBe(21.4);
    expect(learnColdInlet(base(), 30).coldC).toBe(23); // never upwards
  });

  it("raises the draw coefficient when the night had more to put back", () => {
    // Model thought 3000 Wh missing; the cycle actually delivered 6000. The
    // draws were sized at half their true cost.
    const cap = tankCapacityWh(280, base());
    expect(calibrateDrawCoefficient(120, 6000, 3000, cap)).toBe(156); // 120*(0.7+0.3*2)
  });

  it("refuses to learn from a top-up on a nearly full tank", () => {
    // Both numbers small: their ratio is noise, not evidence.
    const cap = tankCapacityWh(280, base());
    expect(calibrateDrawCoefficient(120, 300, 200, cap)).toBe(120);
  });

  it("never lets one night drive the coefficient out of bounds", () => {
    const cap = tankCapacityWh(280, base());
    expect(calibrateDrawCoefficient(500, 13000, 1400, cap)).toBeLessThanOrEqual(600);
    expect(calibrateDrawCoefficient(25, 1400, 13000, cap)).toBeGreaterThanOrEqual(20);
  });
});

describe("showersFromRise", () => {
  it("reads one shower out of a single burst", () => {
    // The sensors report every 30 min, which is also how long one shower keeps
    // the room climbing — so one sample of rise is one shower, no finer.
    expect(showersFromRise(27)).toBe(1);
    expect(showersFromRise(30)).toBe(1);
  });

  it("reads a guest-house morning out of a long climb", () => {
    // Measured: a gîte bathroom climbed for 277 min. That is nine or ten
    // showers, and billing it as one is what let the tank run dry unnoticed.
    expect(showersFromRise(277)).toBe(9);
    expect(showersFromRise(120)).toBe(4);
  });

  it("never returns zero, and caps at a full house", () => {
    expect(showersFromRise(1)).toBe(1);
    expect(showersFromRise(10_000)).toBe(12);
  });
});

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
      /"Energy tariffs" card in Settings/,
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

  it("accepts a heater nobody enrolled under arbitration", () => {
    // The whole class of solar misconfiguration is gone: no meter to pick, no
    // sign convention to get wrong, no pair of thresholds that cancel out. An
    // unprofiled heater is a recipe without surplus heating, which is a
    // complete recipe — so it must not block creating the instance.
    const { ctx } = buildHarness({ heaterProfile: null });
    expect(() => createRecipe().validate(BASE_PARAMS, ctx as never)).not.toThrow();
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
    expect(msg).toContain("Tarifs énergie");
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

  // ── Cut-off inferred from the household total ────────────

  /** A heater with no meter of its own: the whole point of the fallback. */
  const NO_POWER_BINDINGS = [
    { alias: "state", category: "light_state", value: "OFF" },
    { alias: "water_temperature", category: "temperature", value: 45 },
  ];

  it("concludes the tank is full when the household total drops below the declared power", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness({ heaterBindings: NO_POWER_BINDINGS, availableSurplusW: 0 });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, gridEquipment: METER },
      h.ctx as never,
    );
    await advance(1);
    expect(h.lastOrder()).toMatchObject({ value: true });

    h.setBinding(METER, "power", 2400); // resistor + a bit of background
    await advance(30);
    expect(h.state.get("householdProven")).toBe(true);
    expect(h.state.get("tankFull")).toBeFalsy();

    h.setBinding(METER, "power", 250); // thermostat opened
    await advance(6); // > 5 min cut-off delay
    expect(h.state.get("tankFull")).toBe(true);
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("releases the arbiter reservation on the same tick as the cut-off", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness({ heaterBindings: NO_POWER_BINDINGS, availableSurplusW: 0 });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, gridEquipment: METER },
      h.ctx as never,
    );
    await advance(1);
    h.setBinding(METER, "power", 2400);
    await advance(30);
    expect(h.claims.some((c) => c.status === "pending" || c.status === "granted")).toBe(true);

    h.setBinding(METER, "power", 250);
    await advance(6);
    expect(h.state.get("tankFull")).toBe(true);
    expect(h.claims.every((c) => c.status === "released")).toBe(true);
    handle.stop();
  });

  it("never concludes from a meter that has not been seen carrying the heater", async () => {
    // A sub-meter that does not cover the water heater reads low forever. It
    // must leave the recipe alone, not declare a full tank every cycle.
    at("2026-08-10T03:00:00");
    const h = buildHarness({ heaterBindings: NO_POWER_BINDINGS, availableSurplusW: 0 });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, gridEquipment: METER },
      h.ctx as never,
    );
    await advance(1);
    h.setBinding(METER, "power", 300); // never reaches 0.9 * 2200
    await advance(40);

    expect(h.state.get("householdProven")).toBeFalsy();
    expect(h.state.get("tankFull")).toBeFalsy();
    expect(h.state.get("relayOn")).toBe(true);
    handle.stop();
  });

  it("stands down while the sun produces and no production meter is bound", async () => {
    // Grid alone is not the household total under PV: 2.2 kW covered by the
    // panels reads ~0 W at the grid, exactly like a tank that just filled.
    at("2026-08-10T03:00:00");
    const h = buildHarness({ heaterBindings: NO_POWER_BINDINGS, availableSurplusW: 0 });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, gridEquipment: METER },
      h.ctx as never,
    );
    await advance(1);
    h.setBinding(METER, "power", 2400);
    await advance(30);
    expect(h.state.get("householdProven")).toBe(true);

    h.sunUp(1500); // arbiter now reports surplus, production meter still absent
    h.setBinding(METER, "power", 0);
    await advance(10);

    expect(h.state.get("householdPower")).toBeNull();
    expect(h.state.get("tankFull")).toBeFalsy();
    handle.stop();
  });

  it("adds production back in when the production meter is bound", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness({ heaterBindings: NO_POWER_BINDINGS, availableSurplusW: 1500 });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, gridEquipment: METER, productionEquipment: PRODUCTION },
      h.ctx as never,
    );
    await advance(1);

    // Exporting 300 W while producing 2500: the house is drawing 2200.
    h.setBinding(METER, "power", -300);
    h.setBinding(PRODUCTION, "power", 2500);
    await advance(30);
    expect(h.state.get("householdPower")).toBe(2200);
    expect(h.state.get("householdProven")).toBe(true);
    expect(h.state.get("tankFull")).toBeFalsy();

    // Same production, now all of it exported: the resistor stopped.
    h.setBinding(METER, "power", -2400);
    await advance(2); // still inside the 5 min confirmation delay
    expect(h.state.get("householdPower")).toBe(100);
    expect(h.state.get("tankFull")).toBeFalsy();

    await advance(4);
    expect(h.state.get("tankFull")).toBe(true);
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("leaves the fallback idle when the heater has its own channel", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness({ availableSurplusW: 0 });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, gridEquipment: METER },
      h.ctx as never,
    );
    await advance(1);
    h.setBinding(METER, "power", 50); // would scream "full" if it were consulted
    await advance(30);

    expect(h.state.get("householdPower")).toBeNull();
    expect(h.state.get("householdProven")).toBeFalsy();
    expect(h.state.get("tankFull")).toBeFalsy();
    handle.stop();
  });

  it("tracks the charge through a cycle and anchors it on the thermostat", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, tankVolume: 280, standbyPower: 70 },
      h.ctx as never,
    );
    await advance(1);
    expect(h.state.get("relayOn")).toBe(true);

    await advance(60); // one hour of real heating
    // 2200 W in, 70 W of standing loss out, over ~1 h.
    expect(h.state.get("modelStoredWh")).toBeGreaterThan(1900);
    expect(h.state.get("modelStoredWh")).toBeLessThan(2300);
    // No anchor yet, so no percentage is offered: "0 %" on a hot tank would be
    // worse than saying nothing.
    expect(h.state.get("tankCharge")).toBeNull();

    h.setBinding(HEATER, "power", 4); // thermostat opens
    await advance(6); // > 5 min cut-off delay

    expect(h.state.get("tankFull")).toBe(true);
    // The anchor: drift discarded, and the probe retrains the full temperature.
    expect(h.state.get("tankCharge")).toBe(100);
    expect(h.state.get("modelFullC")).toBe(45); // the harness probe reading
    handle.stop();
  });

  it("grows the estimate when the window closes without a cut-off, on household proof", async () => {
    // The ratchet this fixes: the cut-off that SHRINKS the estimate is detected
    // from the household total on installs with no channel of their own, but
    // growth used to demand a dedicated channel. One way only, 240 -> 114 min,
    // until the off-peak cycle no longer reached the thermostat.
    at("2026-08-10T05:00:00"); // inside the window, an hour before it closes
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 30 },
      ],
      availableSurplusW: 0,
    });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, gridEquipment: METER, hcEstimate: "2h" },
      h.ctx as never,
    );
    await advance(1);
    expect(h.state.get("relayOn")).toBe(true);
    h.setBinding(METER, "power", 2400); // proves the household channel
    await advance(30);
    expect(h.state.get("householdProven")).toBe(true);
    const before = h.state.get("hcEstimateMin") as number;

    await advance(35); // 06:00 — the window closes, no cut-off ever seen
    expect(h.state.get("hcEstimateMin")).toBe(before + 45);
    expect(h.logLines.join(" ")).toContain("Fin de plage sans coupure");
    handle.stop();
  });

  it("takes the whole off-peak window when tomorrow brings no sun", async () => {
    // The cycle runs either way; the forecast decides whether it may stop
    // short. No sun tomorrow means nothing will finish the tank, so the cheap
    // window is the last chance and the placement takes all of it.
    at("2026-08-09T21:50:00"); // just before the 22:00 window opens
    const h = buildHarness({ tomorrow: "rainy" });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, forecastEquipment: FORECAST, hcEstimate: "2h" },
      h.ctx as never,
    );
    await advance(15); // 22:05 — inside the window, well before a late placement
    expect(h.state.get("relayOn")).toBe(true);
    expect(h.state.get("hcWindow")).toBe("22:00 → 06:00");
    handle.stop();
  });

  it("keeps the late placement when tomorrow is sunny", async () => {
    at("2026-08-09T21:50:00");
    const h = buildHarness({ tomorrow: "sunny" });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, forecastEquipment: FORECAST, hcEstimate: "2h" },
      h.ctx as never,
    );
    await advance(15); // 22:05 — a late placement does not start until 04:00
    expect(h.state.get("relayOn")).toBeFalsy();
    expect(h.state.get("hcWindow")).toBe("04:00 → 06:00");
    handle.stop();
  });

  it("takes the heater's power from a meter of its own when one is bound", async () => {
    // A metering plug or clamp is its own equipment; powerKey could only ever
    // point inside the heater's own bindings, so such installs were stuck on
    // the household fallback.
    at("2026-08-10T03:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 45 },
      ],
    });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, powerEquipment: METER, tankVolume: 280 },
      h.ctx as never,
    );
    await advance(1);
    expect(h.state.get("relayOn")).toBe(true);

    h.setBinding(METER, "power", 2200); // the heater drawing, seen on the meter
    await advance(30);
    expect(h.state.get("powerProven")).toBe(true); // the household path cannot do this

    h.setBinding(METER, "power", 4); // thermostat opens
    await advance(6);
    expect(h.state.get("tankFull")).toBe(true);
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("refuses to learn the duration from a cycle that started nearly full", async () => {
    // The regression this guards: a 39 min top-up on an almost full tank
    // dragged the estimate 151 -> 114 min, and the next night's cycle then hit
    // the end of the window before the thermostat.
    at("2026-08-10T03:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, tankVolume: 280, standbyPower: 70, hcEstimate: "3h" },
      h.ctx as never,
    );
    // First cycle anchors the observer on a full tank. It still teaches: with
    // no origin yet, the duration floor stands alone, as it did before.
    await advance(1);
    h.setBinding(HEATER, "water_temperature", 60);
    await advance(35);
    h.setBinding(HEATER, "power", 4);
    await advance(6);
    expect(h.state.get("tankCharge")).toBe(100);
    const estimate = h.state.get("hcEstimateMin");

    // A small draw: enough to release the tank-full latch, not enough to empty
    // anything. The next cycle therefore starts on a nearly full tank.
    h.setBinding(HEATER, "water_temperature", 56);
    h.setBinding(HEATER, "power", 2200);
    await advance(15); // clears MIN_OFF and lets the relay close again
    expect(h.state.get("relayOn")).toBe(true);
    expect(h.state.get("tankCharge")).toBeGreaterThan(90);

    await advance(35); // long enough to clear the duration floor
    h.setBinding(HEATER, "power", 4);
    await advance(6);

    expect(h.state.get("hcEstimateMin")).toBe(estimate);
    expect(h.logLines.join(" ")).toContain("déjà chargé");
    handle.stop();
  });

  it("puts the model and the probe side by side on the card", async () => {
    // state.summary is the only place the observer shows without an API call.
    at("2026-08-10T03:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, tankVolume: 280, standbyPower: 70 },
      h.ctx as never,
    );
    await advance(1);
    expect(h.state.get("summary")).toContain("en attente du premier ancrage");

    h.setBinding(HEATER, "water_temperature", 60);
    await advance(30);
    h.setBinding(HEATER, "power", 4);
    await advance(6); // thermostat cut-off → anchor

    const summary = h.state.get("summary") as string;
    expect(summary).toContain("Charge 100 %");
    expect(summary).toContain("modèle 60 °C");
    expect(summary).toContain("sonde 60 °C");
    handle.stop();
  });

  it("reads a probe collapse as a draw, and slow cooling as no draw", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, tankVolume: 280, standbyPower: 70 },
      h.ctx as never,
    );
    // Charge the model the only way it can be charged: relay time, ended on
    // the thermostat so the anchor sets a known full state.
    await advance(1);
    h.setBinding(HEATER, "water_temperature", 60);
    await advance(30);
    h.setBinding(HEATER, "power", 4);
    await advance(6);
    expect(h.state.get("tankCharge")).toBe(100);
    const full = h.state.get("modelStoredWh") as number;

    h.setBinding(HEATER, "water_temperature", 59.5); // 0.5 °C: cooling
    await advance(2);
    const afterCooling = h.state.get("modelStoredWh") as number;
    expect(full - afterCooling).toBeLessThan(200); // standby only

    h.setBinding(HEATER, "water_temperature", 45); // 14.5 °C: a shower
    await advance(2);
    const afterDraw = h.state.get("modelStoredWh") as number;
    expect(afterCooling - afterDraw).toBeGreaterThan(1000);
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

  // ── 4. Solar surplus, via the core arbiter (spec 140) ────
  //
  // The recipe no longer decides anything about the surplus: it opens a claim
  // and obeys the callbacks. So there is nothing here about thresholds,
  // hysteresis or meter signs — all of that moved into core, where it can see
  // every load instead of this one. What is left to pin down is the contract.

  it("heats when the arbiter grants the claim, and stops when it revokes", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.orderCalls).toHaveLength(0); // pending is not granted

    h.grant();
    await advance(1);
    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("solar");

    await advance(6); // clear MIN_ON
    h.revoke();
    await advance(1);
    expect(h.lastOrder()).toMatchObject({ value: false });
    handle.stop();
  });

  it("claims the heater's rating from the profile, and offers a tolerance only when the profile has none", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness({
      heaterProfile: { class: "deferrable", nominalPowerW: 3000, minOnS: 300, minOffS: 300 },
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    // Nothing in the form said 3000 W: the energy profile is the source of
    // truth for the rating, exactly as the tariff page is for off-peak hours.
    // This profile carries no tolerance, so the 10 % default is worth sending.
    expect(h.liveClaim()).toMatchObject({ watts: 3000, toleratedImportW: 300 });
    handle.stop();
  });

  it("stays silent on the tolerated grid draw when the equipment declares one", async () => {
    // Core #550: "Import toléré (W)" on the equipment is the user's setting,
    // and the arbiter reads it for every claim. Sending our own 10 % on top
    // overrode it silently — an admin who typed 500 W still got 220 W.
    at("2026-08-09T13:00:00");
    const h = buildHarness({
      heaterProfile: {
        class: "deferrable",
        nominalPowerW: 2200,
        minOnS: 300,
        minOffS: 300,
        toleratedImportW: 500,
      },
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.liveClaim()?.toleratedImportW).toBeUndefined();
    handle.stop();
  });

  it("lets the form override the tolerated grid draw", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, toleratedImport: 0 },
      h.ctx as never,
    );
    await advance(1);
    expect(h.liveClaim()?.toleratedImportW).toBe(0);
    handle.stop();
  });

  it("keeps the form override ahead of the equipment's own tolerance", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness({
      heaterProfile: {
        class: "deferrable",
        nominalPowerW: 2200,
        minOnS: 300,
        minOffS: 300,
        toleratedImportW: 500,
      },
    });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, toleratedImport: 50 },
      h.ctx as never,
    );
    await advance(1);
    expect(h.liveClaim()?.toleratedImportW).toBe(50);
    handle.stop();
  });

  // ── Declared need (spec 166) ─────────────────────────────

  it("declares the heater drawing while it heats on the grant", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness({ initialState: { powerProven: true } });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    h.grant();
    await advance(3); // past the startup grace, resistor drawing

    const c = h.liveClaim();
    expect(c?.needs.at(-1)).toBe(true);
    expect(h.state.get("surplusDrawing")).toBe(true);
    handle.stop();
  });

  it("declares the heater idle as soon as the thermostat opens, before the cut-off frees the claim", async () => {
    // The whole point on this install: the arbiter reads the *heater's* own
    // power binding and there is none — the meter is a separate equipment.
    // Without the declaration the grant renders solid "accordé" right through
    // the window between the thermostat opening and the release.
    at("2026-08-09T13:00:00");
    const h = buildHarness({
      drawWhenOn: 0, // relay closes, thermostat already open
      initialState: { powerProven: true },
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    h.grant();
    await advance(3); // startup grace done, cut-off delay (5 min) not yet

    const c = h.claims[0];
    expect(c.needs.at(-1)).toBe(false);
    expect(c.status).toBe("granted"); // still holding it — that is the point
    handle.stop();
  });

  it("declares a heater that ignores the order idle, not drawing", async () => {
    // Intent alone would keep saying "drawing" on a load whose breaker is off,
    // which is the exact situation the declaration exists to expose.
    at("2026-08-09T13:00:00");
    const h = buildHarness({ deviceObeys: false, initialState: { powerProven: true } });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    h.grant();
    await advance(1); // inside the own-order grace: our command stands
    expect(h.claims[0].needs.at(-1)).toBe(true);

    await advance(3); // grace over, the relay never moved
    expect(h.claims[0].needs.at(-1)).toBe(false);
    handle.stop();
  });

  it("declares the cut-off from the household total when the heater has no meter of its own", async () => {
    // The reference install: no power binding on the heater, the total is the
    // only witness. It cannot prove a draw, but a total below the declared
    // rating proves the resistor is off — enough to stop claiming the grant is
    // being consumed, four minutes before the cut-off delay releases it.
    at("2026-08-09T13:00:00");
    const h = buildHarness({ heaterBindings: NO_POWER_BINDINGS, availableSurplusW: 1500 });
    const handle = createRecipe().createInstance(
      // The production meter is what keeps the household witness alive under
      // sun — and a grant only ever happens under sun.
      { ...BASE_PARAMS, gridEquipment: METER, productionEquipment: PRODUCTION },
      h.ctx as never,
    );
    await advance(1);
    h.grant();
    await advance(1);
    // Producing 2500, exporting 300: the house draws 2200, i.e. the resistor.
    h.setBinding(PRODUCTION, "power", 2500);
    h.setBinding(METER, "power", -300);
    await advance(30);
    expect(h.state.get("householdProven")).toBe(true);
    expect(h.liveClaim()?.needs.at(-1)).toBe(true);

    h.setBinding(METER, "power", -2400); // thermostat opened, all of it exported
    await advance(2); // past the 1 min declaration confirm, short of cutoffDelay

    expect(h.liveClaim()?.needs.at(-1)).toBe(false);
    expect(h.state.get("tankFull")).toBeFalsy(); // the release has not fired yet
    handle.stop();
  });

  it("restates the declaration on every tick, not only when it changes", async () => {
    // A revoke drops the declaration with the grant, so a recipe reporting on
    // transitions alone goes silent across a revoke/re-grant.
    at("2026-08-09T13:00:00");
    const h = buildHarness({ initialState: { powerProven: true } });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    // Everything before the grant describes a relay that is still open; the
    // core ignores a declaration on a pending claim anyway.
    h.grant();
    const beforeGrant = h.liveClaim()!.needs.length;
    await advance(3);

    const declared = h.liveClaim()!.needs.slice(beforeGrant);
    expect(declared.length).toBeGreaterThan(3); // restated, not edge-triggered
    expect(declared.every((n) => n === true)).toBe(true);
    handle.stop();
  });

  it("heats normally on a core that has no reportNeed", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness({ noReportNeed: true });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    h.grant();
    await advance(1);

    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("solar");
    handle.stop();
  });

  it("survives a core whose reportNeed throws", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness({ reportNeedThrows: true });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    h.grant();
    await advance(2);

    // publish() runs after the declaration: a throw that escaped would abort
    // the tick before this key was written.
    expect(h.state.get("surplusClaim")).toBe("granted");
    expect(h.lastOrder()).toMatchObject({ value: true });
    handle.stop();
  });

  it("yields its place in the priority list when the tank is essentially hot", async () => {
    // High slack is the recipe telling the arbiter "serve the pool pump first".
    // Only this recipe knows the tank's state of charge; the user's static
    // priority list cannot express "unless it is nearly hot".
    at("2026-08-09T13:00:00");
    const h = buildHarness({
      initialState: {
        tankFull: true,
        tankFullAt: new Date("2026-08-09T12:50:00").toISOString(),
        tankFullTemp: 58,
      },
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 57 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    // A full tank wants nothing at all — the watts belong to the next load.
    expect(h.liveClaim()).toBeUndefined();
    handle.stop();
  });

  it("stops yielding when the tank approaches the floor", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 22 }, // floor 20 + margin 5
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.liveClaim()?.slack).toBe("none");
    handle.stop();
  });

  it("keeps its claim open while the floor forces it to run anyway", async () => {
    // Author rule 5: a load running without a grant is a hole in the arbiter's
    // surplus. Holding the claim lets a grant land on it and makes the books
    // exact for every other load in the list.
    at("2026-08-09T13:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 12 }, // below the floor
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(2);

    expect(h.state.get("reason")).toBe("floor");
    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.liveClaim()).toBeDefined();
    expect(h.liveClaim()?.slack).toBe("none");
    handle.stop();
  });

  it("keeps its claim open through the off-peak cycle", async () => {
    at("2026-08-10T03:00:00"); // inside the late placement window
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.state.get("reason")).toBe("hc");
    expect(h.liveClaim()).toBeDefined();
    handle.stop();
  });

  it("releases the claim as soon as the tank is full", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.liveClaim()).toBeDefined();

    await advance(89);
    h.setBinding(HEATER, "power", 4); // thermostat opens
    await advance(6);

    expect(h.state.get("tankFull")).toBe(true);
    expect(h.liveClaim()).toBeUndefined(); // watts handed back to the next load
    handle.stop();
  });

  it("releases the claim when the recipe is paused, and re-claims on resume", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.liveClaim()).toBeDefined();

    handle.onAction?.("set_mode", { mode: "off" });
    await advance(1);
    expect(h.liveClaim()).toBeUndefined();

    handle.onAction?.("set_mode", { mode: "auto" });
    await advance(1);
    expect(h.liveClaim()).toBeDefined();
    handle.stop();
  });

  it("releases the claim when the instance stops", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.liveClaim()).toBeDefined();

    handle.stop();
    expect(h.liveClaim()).toBeUndefined();
  });

  it("does not re-issue a claim just to lower its urgency mid-grant", async () => {
    // Releasing a live grant to announce more slack would hand the watts away
    // in the middle of a cycle — the opposite of what the slack is for.
    at("2026-08-09T13:00:00");
    const h = buildHarness({
      heaterBindings: [
        { alias: "state", category: "light_state", value: "OFF" },
        { alias: "water_temperature", category: "temperature", value: 22 },
        { alias: "power", category: "power", value: 0 },
      ],
    });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.liveClaim()?.slack).toBe("none");

    h.grant();
    await advance(1);
    h.setBinding(HEATER, "water_temperature", 50); // urgency drops while granted
    await advance(2);

    expect(h.claims).toHaveLength(1);
    expect(h.liveClaim()?.status).toBe("granted");
    handle.stop();
  });

  it("carries on without surplus when the heater was never enrolled", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness({ heaterProfile: null, denyClaimWith: "not-profiled" });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    // Off-peak still runs: tariff-only is a complete mode, not a degraded one.
    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("hc");
    // Names the panel and the checkbox as the UI labels them ("Pilotage
    // énergie" / "Charge pilotable"). A message that sends the user to a
    // heading that does not exist is worse than no message.
    expect(h.logLines.some((l) => l.includes("Charge pilotable"))).toBe(true);
    handle.stop();
  });

  it("says once, and only once, why there is no surplus heating", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness({ denyClaimWith: "arbiter-disabled" });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(5); // ten ticks

    const said = h.logLines.filter((l) => l.startsWith("Pas de chauffe sur surplus"));
    expect(said).toHaveLength(1);
    handle.stop();
  });

  it("runs its off-peak and floor duties on a core with no arbiter at all", async () => {
    at("2026-08-10T03:00:00");
    const h = buildHarness({ noEnergyHelper: true });
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);

    expect(h.lastOrder()).toMatchObject({ value: true });
    expect(h.state.get("reason")).toBe("hc");
    handle.stop();
  });

  it("degrades to off-peak only when the grant is revoked mid-cycle", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    h.grant();
    await advance(6);
    expect(h.state.get("relayOn")).toBe(true);

    h.revoke("priority-preempted");
    await advance(1);

    expect(h.state.get("relayOn")).toBe(false);
    expect(h.logLines.some((l) => l.includes("priorité donnée à une autre charge"))).toBe(true);
    // The claim stays queued: core leaves a revoked claim pending, so the
    // recipe never has to re-ask after losing the surplus to a cloud.
    expect(h.liveClaim()).toBeDefined();
    handle.stop();
  });

  it("publishes what the claim is doing instead of thresholds to redo by hand", async () => {
    at("2026-08-09T13:00:00");
    const h = buildHarness();
    const handle = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await advance(1);
    expect(h.state.get("surplusClaim")).toBe("pending");
    expect(h.state.get("availableSurplus")).toBe(1500);

    h.grant();
    await advance(1);
    expect(h.state.get("surplusClaim")).toBe("granted");
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
// Surplus is asked for a real deficit, not for a cleared latch
// ============================================================

describe("surplus demand threshold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The `tankFull` latch is binary and a single draw clears it — one shower, or
   * hot water for the dishes. The recipe then reserved its whole rating to top
   * up a tank at 98 %, closed the relay, and the thermostat opened two minutes
   * later. On a real installation that happened four times in three days:
   * "chargé à 100 % au départ ... thermostat coupé après 2 min".
   *
   * The model already knows how much energy is missing. These pin that the
   * demand now follows it.
   */

  /** Heat a tank to its anchor at 14:00 — outside any off-peak window. */
  async function anchoredFullTank(h: ReturnType<typeof buildHarness>) {
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, tankVolume: 280, standbyPower: 70 },
      h.ctx as never,
    );
    await advance(1);
    // The model is unanchored: the recipe asks, and must ask — a cycle is the
    // only way to anchor it.
    h.grant();
    await advance(1);
    h.setBinding(HEATER, "water_temperature", 60);
    await advance(40);
    h.setBinding(HEATER, "power", 4); // thermostat opened
    await advance(6); // cut-off confirmed → anchor, tank full
    expect(h.state.get("tankCharge")).toBe(100);
    return handle;
  }

  it("stops asking once a small draw leaves the tank nearly full", async () => {
    at("2026-08-10T14:00:00");
    const h = buildHarness({ availableSurplusW: 3000 });
    const handle = await anchoredFullTank(h);

    // 3 °C is exactly what clears the latch, and 360 Wh is a quarter of a
    // shower: the old code asked for 2.2 kW on the strength of it.
    h.setBinding(HEATER, "water_temperature", 57);
    await advance(2);

    expect(h.state.get("tankFull")).toBe(false);
    expect(h.liveClaim()).toBeUndefined();
    expect(h.state.get("deficitWh") as number).toBeLessThan(
      h.state.get("surplusMinDeficitWh") as number,
    );
    handle.stop();
  });

  it("says so once, in the journal, rather than leaving a silent afternoon", async () => {
    at("2026-08-10T14:00:00");
    const h = buildHarness({ availableSurplusW: 3000 });
    const handle = await anchoredFullTank(h);
    h.setBinding(HEATER, "water_temperature", 57);
    await advance(2);

    const held = h.logLines.filter((l) => l.startsWith("Surplus non demandé"));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatch(/il manque \d+ Wh au ballon/);

    // And not again on every tick.
    await advance(10);
    expect(h.logLines.filter((l) => l.startsWith("Surplus non demandé"))).toHaveLength(1);
    handle.stop();
  });

  it("asks again once the showers add up", async () => {
    at("2026-08-10T14:00:00");
    const h = buildHarness({ availableSurplusW: 3000 });
    const handle = await anchoredFullTank(h);

    h.setBinding(HEATER, "water_temperature", 57);
    await advance(2);
    expect(h.liveClaim()).toBeUndefined();

    // A real run of showers: 15 °C off the probe is 1800 Wh on the default
    // coefficient, past the one-shower threshold.
    h.setBinding(HEATER, "water_temperature", 42);
    await advance(2);

    expect(h.liveClaim()).toBeDefined();
    expect(h.logLines.some((l) => l.startsWith("Surplus demandé à nouveau"))).toBe(true);
    handle.stop();
  });

  it("holds a granted cycle to the thermostat, however small the deficit gets", async () => {
    at("2026-08-10T14:00:00");
    const h = buildHarness({ availableSurplusW: 3000 });
    const handle = await anchoredFullTank(h);

    // Draw enough to be asked again, then let the grant land. The wait is the
    // recipe's own anti-short-cycling floor (MIN_OFF_MS, 10 min, stricter than
    // the profile's 300 s): without it the ON is refused and the test would be
    // measuring that instead.
    h.setBinding(HEATER, "water_temperature", 40);
    await advance(11);
    h.grant();
    await advance(1);
    expect(h.lastOrder()).toMatchObject({ value: true });

    // The tank fills back through the threshold while heating. Dropping the
    // grant here would trade the anchor — the one free calibration this recipe
    // gets — for a few watts.
    h.setBinding(HEATER, "water_temperature", 59);
    await advance(20);
    expect(h.liveClaim()).toBeDefined();
    handle.stop();
  });

  it("keeps the old behaviour when the threshold is set to zero", async () => {
    at("2026-08-10T14:00:00");
    const h = buildHarness({ availableSurplusW: 3000 });
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, tankVolume: 280, standbyPower: 70, surplusMinShowers: 0 },
      h.ctx as never,
    );
    await advance(1);
    h.grant();
    await advance(1);
    h.setBinding(HEATER, "water_temperature", 60);
    await advance(40);
    h.setBinding(HEATER, "power", 4);
    await advance(6);
    h.setBinding(HEATER, "water_temperature", 57);
    await advance(2);

    // 0 means "ask whenever the tank is not full", which is what every
    // instance did before this version.
    expect(h.liveClaim()).toBeDefined();
    handle.stop();
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
