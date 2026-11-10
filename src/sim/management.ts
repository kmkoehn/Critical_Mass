/**
 * Running the company: money, supply contracts, the regulator and public opinion.
 * Pure and deterministic (seeded RNG kept in state).
 */
import type { FaultManager, FaultKind } from './faults';
import { REPAIR_COST } from './faults';
import { SUBSTATIONS, type Grid, type SubstationId } from './grid';
import type { Reactor } from './reactor';
import type { Staff } from './staff';
import { rand } from './weather';

export const MGMT_CONFIG = {
  startingCash: 6_000_000,
  /** Fixed site costs (security, admin, insurance), $ per game hour. */
  overheadPerHour: 6_000,
  /** Fuel, $ per MWh of electricity generated. */
  fuelPerMWh: 8,
  /** Spot price paid by uncontracted customers, $/MWh: base + premium at high demand. */
  spotBase: 50,
  spotPeak: 35,
  outfallLimit: 28,
  /** Environmental fine while the outfall is over the limit, $ per game hour. */
  outfallFinePerHour: 100_000,
  loanStep: 5_000_000,
  loanMax: 30_000_000,
  loanRate: 0.09,
  /** Days with a negative balance before bankruptcy. */
  bankruptDays: 7,
  inspection: {
    firstAt: 1 * 86400 + 10 * 3600,
    minGapDays: 2,
    maxGapDays: 4,
    noticeHours: 6,
    passScore: 70,
    fines: [2_000_000, 5_000_000, 10_000_000],
    shutdownHours: 12,
  },
};

export interface Ledger {
  sales: number;
  contracts: number;
  wages: number;
  fuel: number;
  overhead: number;
  repairs: number;
  fines: number;
  penalties: number;
  interest: number;
  capital: number;
}

export const LEDGER_LABELS: Record<keyof Ledger, string> = {
  sales: 'Electricity sales (spot)', contracts: 'Contract sales', wages: 'Staff wages', fuel: 'Fuel', overhead: 'Site overheads',
  repairs: 'Repairs & parts', fines: 'Fines', penalties: 'Contract penalties', interest: 'Loan interest', capital: 'Construction',
};
export const INCOME_KEYS: ReadonlyArray<keyof Ledger> = ['sales', 'contracts'];

export interface Contract {
  id: number;
  sub: SubstationId;
  /** $/MWh. */
  price: number;
  /** Fraction of the customer's demand you must serve. */
  minServed: number;
  /** $ per MWh short. */
  penalty: number;
  days: number;
  bonus: number;
  start: number;
  end: number;
}

export interface InspectionReport {
  t: number;
  score: number;
  passed: boolean;
  findings: string[];
  consequence: string;
}

export interface ManagementState {
  cash: number;
  loan: number;
  day: number;
  daysNegative: number;
  today: Ledger;
  history: Array<{ day: number; ledger: Ledger; closing: number }>;
  /** Cash sampled every game hour. */
  balance: Array<{ t: number; cash: number }>;
  nextBalanceSample: number;
  opinion: number;
  contracts: Contract[];
  offers: Contract[];
  nextContractId: number;
  regulator: {
    nextVisit: number;
    announced: boolean;
    failures: number;
    reports: InspectionReport[];
    shutdownUntil: number;
    licenseRevoked: boolean;
  };
  /** Recent reactor trips and safety-bypass use (game times), for inspections and opinion. */
  trips: number[];
  bypassAt: number;
  wasScram: boolean;
  coreDamageCounted: boolean;
  bankrupt: boolean;
  rng: number;
  // Lifetime stats (final report, achievements).
  totalTrips: number;
  lastTripAt: number;
  repairsByPlayer: number;
  repairsByCrew: number;
  breakersResetByPlayer: number;
  /** The grid has been energised at least once (before that, darkness isn't held against you). */
  everEnergized: boolean;
}

export interface ManagementEvent {
  kind: 'info' | 'good' | 'warn' | 'danger';
  text: string;
}

/** Context the model needs each step. */
export interface CompanyContext {
  reactor: Reactor;
  grid: Grid;
  faults: FaultManager;
  staff: Staff;
  /** Player in the control room or an operator on shift. */
  controlRoomStaffed: boolean;
  unackedAlarms: number;
  playerDoseMSv: number;
}

const emptyLedger = (): Ledger => ({
  sales: 0, contracts: 0, wages: 0, fuel: 0, overhead: 0, repairs: 0, fines: 0, penalties: 0, interest: 0, capital: 0,
});

/** Operating profit (construction spending is shown separately and not counted). */
export function ledgerNet(l: Ledger): number {
  return l.sales + l.contracts - l.wages - l.fuel - l.overhead - l.repairs - l.fines - l.penalties - l.interest;
}

export function spotPrice(demandMW: number): number {
  const c = MGMT_CONFIG;
  return c.spotBase + c.spotPeak * Math.min(1.2, Math.max(0, (demandMW - 450) / 500));
}

export function createManagementState(seed = 2718): ManagementState {
  return {
    cash: MGMT_CONFIG.startingCash, loan: 0, day: 1, daysNegative: 0, today: emptyLedger(), history: [],
    balance: [], nextBalanceSample: 0, opinion: 55, contracts: [], offers: [], nextContractId: 1,
    regulator: { nextVisit: MGMT_CONFIG.inspection.firstAt, announced: false, failures: 0, reports: [], shutdownUntil: 0, licenseRevoked: false },
    trips: [], bypassAt: -1e9, wasScram: false, coreDamageCounted: false, bankrupt: false, rng: seed >>> 0,
    totalTrips: 0, lastTripAt: -1, repairsByPlayer: 0, repairsByCrew: 0, breakersResetByPlayer: 0, everEnergized: false,
  };
}

const SUB_NAME: Record<SubstationId, string> = {
  town: 'Millbrook Council', industrial: 'Millbrook Industrial Park', farmland: 'Valley Farmers Co-op', city: 'City Grid Authority',
};

export class Management {
  /** Upgrade effects set by the game each step. */
  mods = { opinionBaseline: 50, opinionRecovery: 0.4, inspectionBonus: 0, extraOverheadPerHour: 0, extraGenerationMW: 0 };

  constructor(readonly state: ManagementState = createManagementState()) {
    if (this.state.offers.length === 0) this.refreshOffers(0);
  }

  private random(): number {
    const [v, s] = rand(this.state.rng);
    this.state.rng = s;
    return v;
  }

  customerName(sub: SubstationId): string {
    return SUB_NAME[sub];
  }

  /** One offer for every customer without an active contract. Better terms when opinion is high. */
  refreshOffers(t: number): void {
    const st = this.state;
    const goodwill = 0.85 + 0.3 * (st.opinion / 100);
    st.offers = [];
    for (const d of SUBSTATIONS) {
      if (st.contracts.some((c) => c.sub === d.id)) continue;
      if (d.id === 'town' && st.opinion < 20) continue; // the council won't deal with you
      const base = { town: 66, industrial: 62, farmland: 58, city: 74 }[d.id];
      const days = 5 + Math.floor(this.random() * 6);
      st.offers.push({
        id: st.nextContractId++, sub: d.id,
        price: Math.round(base * goodwill * (0.95 + this.random() * 0.1)),
        minServed: d.id === 'city' ? 0.98 : 0.95,
        penalty: { town: 150, industrial: 200, farmland: 120, city: 250 }[d.id],
        days, bonus: Math.round(days * 40_000 * goodwill), start: t, end: t + days * 86400,
      });
    }
  }

  signContract(offerId: number, t: number): Contract | null {
    const st = this.state;
    const i = st.offers.findIndex((o) => o.id === offerId);
    if (i < 0) return null;
    const [o] = st.offers.splice(i, 1);
    o.start = t;
    o.end = t + o.days * 86400;
    st.contracts.push(o);
    st.cash += o.bonus;
    st.today.contracts += o.bonus;
    return o;
  }

  /** Construction spending (upgrades). */
  spendCapital(amount: number): void {
    this.charge('capital', amount);
  }

  takeLoan(): boolean {
    const st = this.state;
    if (st.loan + MGMT_CONFIG.loanStep > MGMT_CONFIG.loanMax) return false;
    st.loan += MGMT_CONFIG.loanStep;
    st.cash += MGMT_CONFIG.loanStep;
    return true;
  }

  repayLoan(): boolean {
    const st = this.state;
    const amt = Math.min(st.loan, MGMT_CONFIG.loanStep);
    if (amt <= 0 || st.cash < amt) return false;
    st.loan -= amt;
    st.cash -= amt;
    return true;
  }

  private charge(key: keyof Ledger, amount: number): void {
    this.state.today[key] += amount;
    this.state.cash += INCOME_KEYS.includes(key) ? amount : -amount;
  }

  /** Regulator-ordered shutdown in force? */
  lockedOut(t: number): boolean {
    return this.state.regulator.licenseRevoked || t < this.state.regulator.shutdownUntil;
  }

  step(t: number, dtGame: number, ctx: CompanyContext): ManagementEvent[] {
    const st = this.state;
    const events: ManagementEvent[] = [];
    const h = dtGame / 3600;
    const rs = ctx.reactor.state;
    const g = ctx.grid.state;

    // ---------------- money
    const spot = spotPrice(g.demandMW);
    for (const d of SUBSTATIONS) {
      const sub = g.subs[d.id];
      const mwh = sub.servedMW * h;
      const contract = st.contracts.find((c) => c.sub === d.id);
      if (contract) {
        this.charge('contracts', mwh * contract.price);
        const short = Math.max(0, sub.demandMW * contract.minServed - sub.servedMW) * h;
        if (short > 0) this.charge('penalties', short * contract.penalty);
      } else {
        this.charge('sales', mwh * spot);
      }
    }
    this.charge('wages', ctx.staff.wagesPerHour * h);
    this.charge('fuel', (rs.electricalOutputMW + this.mods.extraGenerationMW) * h * MGMT_CONFIG.fuelPerMWh);
    this.charge('overhead', (MGMT_CONFIG.overheadPerHour + this.mods.extraOverheadPerHour) * h);
    this.charge('interest', st.loan * MGMT_CONFIG.loanRate * (h / 8760));
    if (rs.outfallTemp > MGMT_CONFIG.outfallLimit) this.charge('fines', MGMT_CONFIG.outfallFinePerHour * h);
    for (const rep of ctx.faults.drainRepairs()) {
      this.charge('repairs', REPAIR_COST[rep.kind as FaultKind]);
      if (rep.by === 'player') st.repairsByPlayer++;
      else st.repairsByCrew++;
      if (rep.by === 'player' && rep.kind === 'substationTrip') st.breakersResetByPlayer++;
    }

    if (t >= st.nextBalanceSample) {
      st.balance.push({ t, cash: st.cash });
      if (st.balance.length > 24 * 14) st.balance.shift();
      st.nextBalanceSample = t + 3600;
    }

    // ---------------- day rollover
    const day = Math.floor(t / 86400) + 1;
    if (day !== st.day) {
      st.history.push({ day: st.day, ledger: st.today, closing: st.cash });
      if (st.history.length > 30) st.history.shift();
      const net = ledgerNet(st.today);
      events.push({ kind: net >= 0 ? 'good' : 'warn', text: `Day ${st.day} closed: ${net >= 0 ? 'profit' : 'loss'} of $${fmtMoney(Math.abs(net))}` });
      st.today = emptyLedger();
      st.day = day;
      st.daysNegative = st.cash < 0 ? st.daysNegative + 1 : 0;
      if (st.daysNegative > 0 && !st.bankrupt) {
        const left = MGMT_CONFIG.bankruptDays - st.daysNegative;
        if (left <= 0) {
          st.bankrupt = true;
          events.push({ kind: 'danger', text: 'BANKRUPT: the board has shut Riverbend down.' });
        } else {
          events.push({ kind: 'danger', text: `Overdrawn for ${st.daysNegative} day(s). ${left} day(s) until bankruptcy.` });
        }
      }
      for (const c of [...st.contracts]) {
        if (t >= c.end) {
          st.contracts = st.contracts.filter((x) => x !== c);
          events.push({ kind: 'info', text: `Contract with ${SUB_NAME[c.sub]} completed` });
        }
      }
      this.refreshOffers(t);
    }

    // ---------------- incidents seen by the public and the regulator
    if (rs.scram.active && !st.wasScram) {
      st.trips.push(t);
      st.totalTrips++;
      st.lastTripAt = t;
      st.opinion -= 3;
    }
    st.wasScram = rs.scram.active;
    st.trips = st.trips.filter((x) => t - x < 86400);
    if (rs.safetyBypass) st.bypassAt = t;
    if (rs.coreDamage > 0 && !st.coreDamageCounted) {
      st.coreDamageCounted = true;
      st.opinion -= 50;
      events.push({ kind: 'danger', text: 'News of fuel damage at Riverbend spreads. Public trust collapses.' });
    }

    // ---------------- public opinion
    const before = st.opinion;
    const town = g.subs.town;
    // Millbrook has been dark for years; it only resents blackouts once Riverbend has powered it.
    if (!g.dead) st.everEnergized = true;
    const darkFrac = !st.everEnergized ? 0 : g.dead ? 1 : town.feedersOff.length / 8;
    st.opinion -= darkFrac * 6 * h;
    if (rs.plantFaults.radLeak > 0) st.opinion -= 1 * h;
    if (rs.outfallTemp > MGMT_CONFIG.outfallLimit) st.opinion -= 0.5 * h;
    const base = this.mods.opinionBaseline;
    if (!g.dead && darkFrac === 0 && g.supplyMW > 0) st.opinion += (st.opinion < base + 25 ? this.mods.opinionRecovery : 0) * h;
    st.opinion += (base - st.opinion) * 0.004 * h; // slow drift back towards neutral
    if (rs.meltdown) st.opinion = 0;
    st.opinion = Math.min(100, Math.max(0, st.opinion));
    if (before >= 25 && st.opinion < 25) events.push({ kind: 'danger', text: 'Protesters are gathering at the plant gate.' });
    if (before < 25 && st.opinion >= 25) events.push({ kind: 'good', text: 'The protest at the gate has broken up.' });
    if (before >= 20 && st.opinion < 20) {
      const c = st.contracts.find((x) => x.sub === 'town');
      if (c) {
        st.contracts = st.contracts.filter((x) => x !== c);
        events.push({ kind: 'danger', text: 'Millbrook Council has cancelled its supply contract.' });
      }
    }

    // ---------------- the regulator
    const reg = st.regulator;
    const ins = MGMT_CONFIG.inspection;
    if (!reg.announced && t >= reg.nextVisit - ins.noticeHours * 3600) {
      reg.announced = true;
      events.push({ kind: 'warn', text: `Regulator inspection announced for ${fmtTime(reg.nextVisit)}` });
    }
    if (t >= reg.nextVisit) {
      const report = this.inspect(t, ctx);
      reg.reports.push(report);
      events.push({ kind: report.passed ? 'good' : 'danger', text: `Inspection ${report.passed ? 'passed' : 'FAILED'} (${report.score}/100). ${report.consequence}` });
      reg.announced = false;
      reg.nextVisit = t + 86400 * (ins.minGapDays + this.random() * (ins.maxGapDays - ins.minGapDays));
    }
    return events;
  }

  /** Score the plant as it stands now (and over the last game day). */
  inspect(t: number, ctx: CompanyContext): InspectionReport {
    const st = this.state;
    const rs = ctx.reactor.state;
    const findings: string[] = [];
    let score = 100;
    const ded = (n: number, why: string) => {
      score -= n;
      findings.push(`−${n} ${why}`);
    };
    if (rs.safetyBypass || t - st.bypassAt < 86400) ded(30, 'safety systems bypassed in the last 24 h');
    if (st.trips.length) ded(Math.min(30, 10 * st.trips.length), `${st.trips.length} reactor trip(s) in the last 24 h`);
    if (ctx.unackedAlarms > 0) ded(Math.min(15, 3 * ctx.unackedAlarms), `${ctx.unackedAlarms} unacknowledged alarm(s)`);
    const old = ctx.faults.state.faults.filter((f) => t - f.started > 6 * 3600);
    if (old.length) ded(Math.min(24, 8 * old.length), `${old.length} fault(s) left unrepaired over 6 h`);
    if (rs.plantFaults.radLeak > 0) ded(15, 'active radiation leak at the fuel pad');
    if (rs.generatorSynced && !ctx.controlRoomStaffed) ded(20, 'reactor at power with nobody in the control room');
    if (rs.outfallTemp > MGMT_CONFIG.outfallLimit) ded(10, 'outfall over the environmental limit');
    const duty = ctx.staff.dutyOperator;
    if (duty && duty.fatigue > 0.9) ded(10, `${duty.name} on shift while exhausted`);
    if (ctx.playerDoseMSv > 30) ded(10, `director's dose today ${ctx.playerDoseMSv.toFixed(0)} mSv`);
    if (ctx.staff.byRole('security').length === 0) ded(5, 'no security staff on site');
    if (this.mods.inspectionBonus) {
      score += this.mods.inspectionBonus;
      findings.push(`+${this.mods.inspectionBonus} emergency diesel generators`);
    }
    score = Math.max(0, Math.min(100, score));
    const passed = score >= MGMT_CONFIG.inspection.passScore;
    let consequence = 'No action.';
    if (passed) {
      st.opinion = Math.min(100, st.opinion + 3);
      if (!findings.length) findings.push('No findings. Exemplary.');
    } else {
      const reg = st.regulator;
      const fine = MGMT_CONFIG.inspection.fines[Math.min(reg.failures, 2)];
      reg.failures++;
      this.charge('fines', fine);
      st.opinion = Math.max(0, st.opinion - 8);
      consequence = `Fined $${fmtMoney(fine)}.`;
      if (reg.failures === 2) {
        reg.shutdownUntil = t + MGMT_CONFIG.inspection.shutdownHours * 3600;
        ctx.reactor.scram('regulator');
        consequence += ` Shutdown ordered for ${MGMT_CONFIG.inspection.shutdownHours} hours.`;
      } else if (reg.failures >= 3) {
        reg.licenseRevoked = true;
        ctx.reactor.scram('regulator');
        consequence += ' Operating licence REVOKED.';
      } else {
        consequence += ' Another failure means a forced shutdown.';
      }
    }
    return { t, score, passed, findings, consequence };
  }
}

export function fmtMoney(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0);
  return v < 0 ? `-${s}` : s;
}

export function fmtTime(t: number): string {
  const day = Math.floor(t / 86400) + 1;
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `Day ${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
