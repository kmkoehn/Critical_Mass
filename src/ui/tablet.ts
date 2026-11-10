/**
 * The Director's Tablet (Tab): money, staff, work orders, contracts, the regulator and the log.
 * Management only — reactor controls stay in the control room (or with a shift operator).
 */
import { REPAIR_COST, crewRoleFor, faultStatus, faultTitle, type FaultManager } from '../sim/faults';
import type { Grid } from '../sim/grid';
import {
  INCOME_KEYS, LEDGER_LABELS, MGMT_CONFIG, fmtMoney, fmtTime, ledgerNet, spotPrice, type Ledger, type Management,
} from '../sim/management';
import { reactorStatus, type Reactor } from '../sim/reactor';
import { ROLE_INFO, type Role, type Staff, type StaffMember } from '../sim/staff';
import { UPGRADES, type UpgradeId, type Upgrades } from '../sim/upgrades';
import { UNIT2, type Unit2 } from '../sim/unit2';
import { button, chart, h, meter, readout, section, segmented, setActive, setEnabled, type Tone } from './panels/widgets';
import './tablet.css';

export interface TabletContext {
  mgmt: Management;
  staff: Staff;
  faults: FaultManager;
  grid: Grid;
  upgrades: Upgrades;
  unit2: Unit2;
  act(): number;
  /** Pay for and start an upgrade; returns why not, or null. */
  buyUpgrade(id: UpgradeId): string | null;
  reactor(): Reactor;
  gameSeconds(): number;
  autopilotStatus(): { active: boolean; text: string };
}

type TabId = 'overview' | 'finance' | 'staff' | 'work' | 'contracts' | 'upgrades' | 'regulator' | 'log';
const TABS: Array<[TabId, string]> = [
  ['overview', 'Overview'], ['finance', 'Finances'], ['staff', 'Staff'], ['work', 'Work orders'],
  ['contracts', 'Contracts'], ['upgrades', 'Upgrades'], ['regulator', 'Regulator'], ['log', 'Log'],
];

interface View {
  el: HTMLElement;
  update(): void;
}

const money = (v: number) => `$${fmtMoney(v)}`;
const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

function memberStatus(ctx: TabletContext, m: StaffMember): string {
  if (m.id === ctx.staff.state.dutyOperatorId) return 'On shift';
  if (m.busyWith !== null) {
    const f = ctx.faults.state.faults.find((x) => x.id === m.busyWith);
    return f ? `Busy: ${faultTitle(f)}` : 'Returning';
  }
  return m.fatigue > 0.6 ? 'Resting' : 'Available';
}

function sendCrew(ctx: TabletContext, faultId: number): string | null {
  const f = ctx.faults.state.faults.find((x) => x.id === faultId);
  if (!f) return 'Fault already fixed';
  const role = crewRoleFor(f.kind);
  const crew = ctx.staff.availableCrew(role);
  if (!crew) return `No free ${ROLE_INFO[role].label.toLowerCase()}. Hire one on the Staff tab.`;
  if (!ctx.faults.dispatchCrew(f.id, ctx.gameSeconds(), crew)) return 'A crew is already on it';
  crew.busyWith = f.id;
  return null;
}

// ---------------------------------------------------------------- overview

function overview(ctx: TabletContext): View {
  const el = h('div', 'tb-grid');
  const cash = section(el, 'Company');
  const bal = readout(cash, 'Cash', '', true);
  const net = readout(cash, 'Today so far', '');
  const loan = readout(cash, 'Loan outstanding', '');
  const opinion = meter(cash, 'Public opinion', 0, 100, { marks: [{ at: 25, tone: 'bad' }, { at: 50, tone: 'info' }] });
  const opNote = h('div', 'cp-note', cash);

  const ops = section(el, 'Operations');
  const status = readout(ops, 'Reactor', '');
  const grid = readout(ops, 'Grid served / demand', 'MW');
  const price = readout(ops, 'Spot price', '$/MWh');
  const crew = h('div', 'tb-status', ops);
  const apRow = h('div', 'cp-btnrow', ops);
  const apBtn = button(apRow, 'Autopilot', () => {
    const a = ctx.staff.state.autopilot;
    a.enabled = !a.enabled;
  });
  const mode = segmented(ops, 'Operator orders', ['Follow demand', 'Hold setpoint'], (o) => {
    ctx.staff.state.autopilot.mode = o === 'Follow demand' ? 'follow' : 'hold';
  });
  const spRow = h('div', 'cp-btnrow', ops);
  const spLabel = h('span', 'tb-setpoint', spRow);
  const adj = (d: number) => () => {
    const a = ctx.staff.state.autopilot;
    a.setpointMW = Math.min(1000, Math.max(100, a.setpointMW + d));
  };
  button(spRow, '−50', adj(-50));
  button(spRow, '+50', adj(50));

  const agenda = section(el, 'Agenda');
  const next = readout(agenda, 'Next inspection', '');
  const fails = readout(agenda, 'Failed inspections', '/ 3');
  const work = readout(agenda, 'Open work orders', '');
  const contracts = h('div', 'cp-note', agenda);

  return {
    el,
    update() {
      const m = ctx.mgmt.state;
      const t = ctx.gameSeconds();
      bal.set(money(m.cash), m.cash < 0 ? 'bad' : 'ok');
      const n = ledgerNet(m.today);
      net.set(`${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`, n >= 0 ? 'ok' : 'warn');
      loan.set(money(m.loan), m.loan > 0 ? 'warn' : 'dim');
      const tone: Tone = m.opinion < 25 ? 'bad' : m.opinion < 45 ? 'warn' : 'ok';
      opinion.set(m.opinion, `${m.opinion.toFixed(0)} / 100`, tone);
      opNote.textContent = m.opinion < 20 ? 'The council refuses to deal with you. Protesters at the gate.'
        : m.opinion < 25 ? 'Protesters at the gate. Keep the lights on to win them back.'
          : 'Blackouts, trips, leaks and hot outfall water hurt opinion. Reliable supply slowly wins it back.';
      const rs = ctx.reactor().state;
      const st = reactorStatus(rs);
      status.set(st, st === 'AT POWER' ? 'ok' : st === 'ALARM' || st === 'MELTDOWN' ? 'bad' : 'dim');
      const g = ctx.grid.state;
      grid.set(`${g.servedMW.toFixed(0)} / ${g.demandMW.toFixed(0)}`, g.shedFraction > 0 ? 'bad' : 'ok');
      price.set(spotPrice(g.demandMW).toFixed(0), 'info');
      const ap = ctx.autopilotStatus();
      crew.textContent = ap.text;
      crew.dataset.tone = ap.active ? 'ok' : 'warn';
      const a = ctx.staff.state.autopilot;
      apBtn.textContent = a.enabled ? 'Autopilot: ON' : 'Autopilot: OFF';
      setActive(apBtn, a.enabled);
      mode.set(a.mode === 'follow' ? 'Follow demand' : 'Hold setpoint');
      spLabel.textContent = `Setpoint ${a.setpointMW} MW`;
      const r = m.regulator;
      next.set(r.licenseRevoked ? 'LICENCE REVOKED' : fmtTime(r.nextVisit), r.announced ? 'warn' : 'dim');
      fails.set(String(r.failures), r.failures ? 'bad' : 'ok');
      work.set(String(ctx.faults.state.faults.length), ctx.faults.state.faults.length ? 'warn' : 'ok');
      contracts.textContent = m.contracts.length
        ? `Contracts: ${m.contracts.map((c) => `${ctx.mgmt.customerName(c.sub)} until ${fmtTime(c.end)}`).join(' · ')}`
        : 'No supply contracts. Everyone pays the spot price.';
      if (t < r.shutdownUntil) contracts.textContent += ` · Regulator shutdown until ${fmtTime(r.shutdownUntil)}.`;
    },
  };
}

// ---------------------------------------------------------------- finances

function finance(ctx: TabletContext): View {
  const el = h('div', 'tb-grid');
  const left = section(el, 'Balance');
  const bal = chart(left, 'Cash, last 3 days ($M)', 140);
  const loanRow = h('div', 'cp-btnrow', left);
  const loanTxt = h('span', 'tb-setpoint', loanRow);
  const take = button(loanRow, `Borrow ${money(MGMT_CONFIG.loanStep)}`, () => ctx.mgmt.takeLoan());
  const repay = button(loanRow, `Repay ${money(MGMT_CONFIG.loanStep)}`, () => ctx.mgmt.repayLoan());
  const warn = h('div', 'cp-note', left);

  const right = section(el, 'Profit & loss');
  const table = h('table', 'tb-table', right);
  const head = h('tr', '', h('thead', '', table));
  for (const c of ['', 'Today', 'Yesterday']) h('th', '', head, c);
  const body = h('tbody', '', table);
  const keys = Object.keys(LEDGER_LABELS) as Array<keyof Ledger>;
  const rows = keys.map((k) => {
    const tr = h('tr', '', body);
    h('td', '', tr, LEDGER_LABELS[k]);
    return { k, today: h('td', 'num', tr), yday: h('td', 'num', tr) };
  });
  const tot = h('tr', 'total', body);
  h('td', '', tot, 'Operating profit');
  const totT = h('td', 'num', tot);
  const totY = h('td', 'num', tot);
  let tick = 0;
  return {
    el,
    update() {
      const m = ctx.mgmt.state;
      const y = m.history[m.history.length - 1]?.ledger;
      for (const r of rows) {
        const sign = INCOME_KEYS.includes(r.k) ? '' : '−';
        r.today.textContent = m.today[r.k] ? `${sign}${money(m.today[r.k])}` : '—';
        r.yday.textContent = y && y[r.k] ? `${sign}${money(y[r.k])}` : '—';
      }
      totT.textContent = money(ledgerNet(m.today));
      totY.textContent = y ? money(ledgerNet(y)) : '—';
      loanTxt.textContent = `Loan ${money(m.loan)} at ${(MGMT_CONFIG.loanRate * 100).toFixed(0)}%`;
      setEnabled(take, m.loan + MGMT_CONFIG.loanStep <= MGMT_CONFIG.loanMax);
      setEnabled(repay, m.loan > 0 && m.cash >= Math.min(m.loan, MGMT_CONFIG.loanStep));
      warn.textContent = m.bankrupt ? 'BANKRUPT.'
        : m.daysNegative ? `Overdrawn for ${m.daysNegative} day(s): bankruptcy after ${MGMT_CONFIG.bankruptDays}.`
          : `Running costs: site overheads ${money(MGMT_CONFIG.overheadPerHour)}/h, wages ${money(ctx.staff.wagesPerHour)}/h, fuel $${MGMT_CONFIG.fuelPerMWh}/MWh.`;
      if (tick++ % 4 === 0) {
        const pts = m.balance.filter((b) => b.t > ctx.gameSeconds() - 3 * 86400);
        const vals = pts.map((b) => b.cash / 1e6);
        const vmin = Math.min(...vals);
        const vmax = Math.max(...vals);
        const pad = Math.max(0.2, (vmax - vmin) * 0.15);
        const lo = vmin - pad;
        const hi = vmax + pad;
        bal.draw([{ values: vals, color: '#6cc6ff', min: lo, max: hi, label: 'cash' }], pts.map((b) => b.t));
      }
    },
  };
}

// ---------------------------------------------------------------- staff

function staffView(ctx: TabletContext): View {
  const el = h('div', 'tb-col');
  const roster = section(el, 'Your staff');
  const rosterBody = h('div', 'tb-list', roster);
  const hire = section(el, 'Applicants (refreshed daily)');
  const hireBody = h('div', 'tb-list', hire);
  const help = h('div', 'cp-note', hire);
  help.innerHTML = (Object.keys(ROLE_INFO) as Role[]).map((r) => `<b>${ROLE_INFO[r].label}:</b> ${ROLE_INFO[r].blurb}`).join('<br>');
  let key = '';
  const fatigueBars = new Map<number, HTMLElement>();
  const statusCells = new Map<number, HTMLElement>();

  const row = (parent: HTMLElement, m: StaffMember, action: HTMLButtonElement | null) => {
    const r = h('div', 'tb-row', parent);
    const who = h('div', 'tb-who', r);
    h('div', 'tb-name', who, m.name);
    h('div', 'tb-sub', who, `${ROLE_INFO[m.role].label} · ${stars(m.skill)} · $${m.wage}/h`);
    const fat = h('div', 'tb-fatigue', r);
    const bar = h('div', 'tb-fatigue-fill', fat);
    const st = h('div', 'tb-state', r);
    if (action) r.appendChild(action);
    return { bar, st };
  };

  return {
    el,
    update() {
      const s = ctx.staff.state;
      const k = `${s.members.map((m) => m.id).join(',')}|${s.candidates.map((m) => m.id).join(',')}`;
      if (k !== key) {
        key = k;
        rosterBody.replaceChildren();
        hireBody.replaceChildren();
        fatigueBars.clear();
        statusCells.clear();
        if (!s.members.length) h('div', 'cp-note', rosterBody, 'Nobody on the payroll yet. Hire a shift operator so the plant is minded while you are out.');
        for (const m of s.members) {
          const fire = button(document.createElement('div'), 'Let go', () => ctx.staff.fire(m.id));
          const { bar, st } = row(rosterBody, m, fire);
          fatigueBars.set(m.id, bar);
          statusCells.set(m.id, st);
        }
        for (const c of s.candidates) {
          const b = button(document.createElement('div'), 'Hire', () => ctx.staff.hire(c.id), 'hire');
          const { st } = row(hireBody, c, b);
          st.textContent = 'Applicant';
        }
      }
      for (const m of s.members) {
        const bar = fatigueBars.get(m.id);
        if (bar) {
          bar.style.width = `${Math.round(m.fatigue * 100)}%`;
          bar.dataset.tone = m.fatigue > 0.85 ? 'bad' : m.fatigue > 0.6 ? 'warn' : 'ok';
        }
        const st = statusCells.get(m.id);
        if (st) st.textContent = memberStatus(ctx, m);
      }
    },
  };
}

// ---------------------------------------------------------------- work orders

function workOrders(ctx: TabletContext): View {
  const el = h('div', 'tb-col');
  const sec = section(el, 'Open work orders');
  const list = h('div', 'tb-list', sec);
  const msg = h('div', 'cp-note', sec);
  h('div', 'cp-note', el,
    'Fix faults yourself (walk up, look, hold E), or send a crew: they drive out from the plant, so far-off jobs take longer. ' +
    'Line crews handle substations and transmission lines; maintenance crews handle plant equipment.');
  let key = '';
  return {
    el,
    update() {
      const faults = ctx.faults.state.faults;
      const k = faults.map((f) => `${f.id}:${f.crew?.phase ?? '-'}:${ctx.staff.availableCrew(crewRoleFor(f.kind))?.id ?? 0}`).join(',');
      if (k === key) return;
      key = k;
      list.replaceChildren();
      if (!faults.length) h('div', 'cp-note', list, 'Nothing broken. Enjoy it while it lasts.');
      for (const f of faults) {
        const r = h('div', 'tb-row', list);
        const who = h('div', 'tb-who', r);
        h('div', 'tb-name', who, faultTitle(f));
        const age = Math.max(0, (ctx.gameSeconds() - f.started) / 3600);
        h('div', 'tb-sub', who, `${faultStatus(f)} · open ${age.toFixed(1)} h · parts ${money(REPAIR_COST[f.kind])}`);
        if (!f.crew) {
          const role = crewRoleFor(f.kind);
          const b = button(r, `Send ${role === 'lineCrew' ? 'line' : 'maintenance'} crew`, () => {
            msg.textContent = sendCrew(ctx, f.id) ?? '';
            key = '';
          });
          setEnabled(b, ctx.staff.availableCrew(role) !== null);
        }
      }
    },
  };
}

// ---------------------------------------------------------------- contracts

function contracts(ctx: TabletContext): View {
  const el = h('div', 'tb-col');
  const active = section(el, 'Active contracts');
  const activeList = h('div', 'tb-list', active);
  const offers = section(el, 'Offers');
  const offerList = h('div', 'tb-list', offers);
  h('div', 'cp-note', el,
    'A contract pays a fixed price for everything you deliver to that customer, plus a signing bonus, ' +
    'but every MWh below the promised share of their demand costs a penalty. Uncontracted customers pay the spot price.');
  let key = '';
  return {
    el,
    update() {
      const m = ctx.mgmt.state;
      const g = ctx.grid.state;
      const k = `${m.contracts.map((c) => c.id).join(',')}|${m.offers.map((c) => c.id).join(',')}|${Math.floor(ctx.gameSeconds() / 60)}`;
      if (k === key) return;
      key = k;
      activeList.replaceChildren();
      offerList.replaceChildren();
      if (!m.contracts.length) h('div', 'cp-note', activeList, 'None.');
      for (const c of m.contracts) {
        const r = h('div', 'tb-row', activeList);
        const who = h('div', 'tb-who', r);
        h('div', 'tb-name', who, ctx.mgmt.customerName(c.sub));
        const sub = g.subs[c.sub];
        const share = sub.demandMW > 0 ? (sub.servedMW / sub.demandMW) * 100 : 100;
        h('div', 'tb-sub', who,
          `$${c.price}/MWh · deliver ≥${(c.minServed * 100).toFixed(0)}% · penalty $${c.penalty}/MWh short · ends ${fmtTime(c.end)}`);
        const st = h('div', 'tb-state', r, `${share.toFixed(0)}% now`);
        st.dataset.tone = share / 100 >= c.minServed ? 'ok' : 'bad';
      }
      if (!m.offers.length) h('div', 'cp-note', offerList, 'No offers right now. New ones arrive each day.');
      for (const o of m.offers) {
        const r = h('div', 'tb-row', offerList);
        const who = h('div', 'tb-who', r);
        h('div', 'tb-name', who, ctx.mgmt.customerName(o.sub));
        h('div', 'tb-sub', who,
          `${o.days} days · $${o.price}/MWh · deliver ≥${(o.minServed * 100).toFixed(0)}% · penalty $${o.penalty}/MWh short · bonus ${money(o.bonus)}`);
        button(r, 'Sign', () => {
          ctx.mgmt.signContract(o.id, ctx.gameSeconds());
          key = '';
        }, 'hire');
      }
    },
  };
}

// ---------------------------------------------------------------- upgrades

function upgradesView(ctx: TabletContext): View {
  const el = h('div', 'tb-col');
  const u2 = section(el, 'Unit 2');
  const u2Status = readout(u2, 'Status', '');
  const u2Out = readout(u2, 'Output', 'MWe');
  const u2Row = h('div', 'cp-btnrow', u2);
  const u2Set = h('span', 'tb-setpoint', u2Row);
  const adj = (d: number) => () => {
    const s = ctx.unit2.state;
    s.setpointMW = Math.min(UNIT2.maxMW, Math.max(0, s.setpointMW + d));
  };
  button(u2Row, '−100', adj(-100));
  button(u2Row, '+100', adj(100));
  h('div', 'cp-note', u2, 'Unit 2 runs at this base-load setpoint with its own crew; Unit 1 (you or your shift operator) follows the rest of the demand. With Unit 1 off-line, Unit 2 follows demand on its own.');

  const list = section(el, 'Plant upgrades');
  const rows = UPGRADES.map((u) => {
    const r = h('div', 'tb-row tb-upgrade', list);
    const who = h('div', 'tb-who', r);
    h('div', 'tb-name', who, u.name);
    h('div', 'tb-sub', who, `${u.effect}`);
    h('div', 'tb-sub', who, `${money(u.cost)} · ${u.hours} game hours to build`);
    const bar = h('div', 'tb-fatigue', r);
    const fill = h('div', 'tb-fatigue-fill', bar);
    const st = h('div', 'tb-state', r);
    const msg = { text: '' };
    const buy = button(r, 'Build', () => {
      msg.text = ctx.buyUpgrade(u.id) ?? '';
    }, 'hire');
    return { u, fill, st, buy, msg };
  });
  return {
    el,
    update() {
      const t = ctx.gameSeconds();
      const s = ctx.unit2.state;
      const p = ctx.upgrades.progress('unit2', t);
      u2Status.set(!s.built ? (p > 0 ? `Under construction (${(p * 100).toFixed(0)}%)` : 'Not built')
        : t < s.availableAt ? (s.tripped ? 'Tripped — restarting' : 'Commissioning') : 'Running', s.built ? 'ok' : 'dim');
      u2Out.set(s.outputMW.toFixed(0), s.outputMW > 0 ? 'ok' : 'dim');
      u2Set.textContent = `Setpoint ${s.setpointMW} MW`;
      for (const r of rows) {
        const prog = ctx.upgrades.progress(r.u.id, t);
        r.fill.style.width = `${Math.round(prog * 100)}%`;
        r.fill.dataset.tone = prog >= 1 ? 'ok' : 'warn';
        const block = ctx.upgrades.blocker(r.u.id, ctx.mgmt.state.cash, ctx.act());
        r.st.textContent = prog >= 1 ? 'Built' : prog > 0 ? `${(prog * 100).toFixed(0)}% built` : r.msg.text || block || 'Ready to build';
        r.st.dataset.tone = prog >= 1 ? 'ok' : block && prog === 0 ? 'bad' : '';
        setEnabled(r.buy, block === null);
        r.buy.hidden = prog > 0;
      }
    },
  };
}

// ---------------------------------------------------------------- regulator

function regulator(ctx: TabletContext): View {
  const el = h('div', 'tb-col');
  const top = section(el, 'Office of Nuclear Safety');
  const next = readout(top, 'Next inspection', '');
  const fails = readout(top, 'Failed inspections', '/ 3');
  h('div', 'cp-note', top,
    `Inspectors visit every ${MGMT_CONFIG.inspection.minGapDays}–${MGMT_CONFIG.inspection.maxGapDays} days, with ${MGMT_CONFIG.inspection.noticeHours} hours' notice. ` +
    `Pass mark ${MGMT_CONFIG.inspection.passScore}/100. They mark you down for safety bypasses, recent trips, unacknowledged alarms, ` +
    'faults left open over 6 hours, radiation leaks, an unstaffed control room at power, a hot outfall, exhausted operators, high personal dose and no security. ' +
    '1st failure: fine. 2nd: fine and a 12-hour forced shutdown. 3rd: licence revoked.');
  const reports = section(el, 'Reports');
  const list = h('div', 'tb-list', reports);
  let n = -1;
  return {
    el,
    update() {
      const r = ctx.mgmt.state.regulator;
      next.set(r.licenseRevoked ? 'LICENCE REVOKED' : fmtTime(r.nextVisit), r.announced ? 'warn' : 'dim');
      fails.set(String(r.failures), r.failures ? 'bad' : 'ok');
      if (r.reports.length === n) return;
      n = r.reports.length;
      list.replaceChildren();
      if (!r.reports.length) h('div', 'cp-note', list, 'No inspections yet.');
      for (const rep of [...r.reports].reverse()) {
        const row = h('div', 'tb-report', list);
        const head = h('div', 'tb-name', row, `${fmtTime(rep.t)} · ${rep.score}/100 · ${rep.passed ? 'PASSED' : 'FAILED'}`);
        head.dataset.tone = rep.passed ? 'ok' : 'bad';
        h('div', 'tb-sub', row, rep.findings.join(' · '));
        h('div', 'tb-sub', row, rep.consequence);
      }
    },
  };
}

// ---------------------------------------------------------------- log

function logView(ctx: TabletContext): View {
  const el = h('div', 'tb-col');
  const sec = section(el, 'Event log');
  const list = h('div', 'cp-log tb-log', sec);
  let n = -1;
  return {
    el,
    update() {
      const log = ctx.faults.state.log;
      if (log.length === n) return;
      n = log.length;
      list.replaceChildren();
      for (const e of log.slice(-60).reverse()) {
        const row = h('div', `cp-log-row ${e.kind}`, list);
        h('span', 'cp-log-t', row, fmtTime(e.t));
        h('span', '', row, e.text);
      }
    },
  };
}

const BUILDERS: Record<TabId, (ctx: TabletContext) => View> = {
  overview, finance, staff: staffView, work: workOrders, contracts, upgrades: upgradesView, regulator, log: logView,
};

export class Tablet {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs = new Map<TabId, HTMLButtonElement>();
  private readonly views = new Map<TabId, View>();
  private current: TabId = 'overview';
  private timer = 0;
  isOpen = false;
  onClose: () => void = () => {};

  constructor(parent: HTMLElement, private readonly ctx: TabletContext) {
    this.root = h('div', 'tablet-overlay', parent);
    this.root.hidden = true;
    const device = h('div', 'tablet', this.root);
    const head = h('header', 'tablet-head', device);
    h('div', 'tablet-brand', head, "Director's Tablet");
    const nav = h('nav', 'tablet-tabs', head);
    for (const [id, label] of TABS) this.tabs.set(id, button(nav, label, () => this.show(id), 'tablet-tab'));
    button(head, 'Close  [Tab]', () => this.close(), 'tablet-close');
    this.body = h('div', 'tablet-body', device);
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  show(id: TabId): void {
    let v = this.views.get(id);
    if (!v) {
      v = BUILDERS[id](this.ctx);
      this.views.set(id, v);
    }
    this.current = id;
    this.body.replaceChildren(v.el);
    for (const [t, b] of this.tabs) b.classList.toggle('active', t === id);
    v.update();
  }

  open(): void {
    this.isOpen = true;
    this.root.hidden = false;
    this.show(this.current);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.onClose();
  }

  update(dt: number): void {
    if (!this.isOpen) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    this.views.get(this.current)?.update();
  }
}
