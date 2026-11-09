/**
 * Plant staff: shift operators, maintenance crews, line crews and security.
 * Pure and deterministic (seeded RNG kept in state).
 */
import { rand } from './weather';

export type Role = 'operator' | 'maintenance' | 'lineCrew' | 'security';

export const ROLE_INFO: Record<Role, { label: string; plural: string; baseWage: number; blurb: string }> = {
  operator: {
    label: 'Shift operator', plural: 'Shift operators', baseWage: 120,
    blurb: 'Runs the reactor on autopilot while you are out of the control room. Higher skill holds the plant more tightly.',
  },
  maintenance: {
    label: 'Maintenance crew', plural: 'Maintenance crews', baseWage: 300,
    blurb: 'Can be sent to fix plant faults (they travel there first). Faster with more skill.',
  },
  lineCrew: {
    label: 'Line crew', plural: 'Line crews', baseWage: 350,
    blurb: 'Repairs downed transmission lines and substations.',
  },
  security: {
    label: 'Security officer', plural: 'Security', baseWage: 60,
    blurb: 'Keeps protests at the gate in check and counts towards regulator inspections.',
  },
};

export type AutopilotMode = 'follow' | 'hold';

export interface StaffMember {
  id: number;
  name: string;
  role: Role;
  /** 1..5 */
  skill: number;
  /** $ per game hour. */
  wage: number;
  /** 0 (fresh) .. 1 (exhausted). */
  fatigue: number;
  /** Fault id this person (or crew) is working on. */
  busyWith: number | null;
}

export interface StaffState {
  members: StaffMember[];
  candidates: StaffMember[];
  nextId: number;
  rng: number;
  nextRefresh: number;
  dutyOperatorId: number | null;
  autopilot: { enabled: boolean; mode: AutopilotMode; setpointMW: number };
}

const FIRST = ['Ada', 'Bram', 'Celia', 'Dev', 'Elena', 'Farid', 'Greta', 'Hollis', 'Ines', 'Jonah', 'Kira', 'Lars', 'Mae',
  'Nico', 'Odette', 'Pavel', 'Quinn', 'Rosa', 'Sami', 'Tova', 'Ugo', 'Vera', 'Wes', 'Yara', 'Zane'];
const LAST = ['Abernathy', 'Brandt', 'Castillo', 'Dunmore', 'Eklund', 'Fairweather', 'Galloway', 'Hartigan', 'Ivers',
  'Juarez', 'Kowalski', 'Lindqvist', 'Mbeki', 'Novak', 'Okafor', 'Pruitt', 'Quayle', 'Rasmussen', 'Sato', 'Trevino', 'Ueda', 'Vance', 'Whitlock'];
const CREW_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];

/** Fatigue change per game hour. */
const FATIGUE = { onDuty: 0.09, busy: 0.05, resting: -0.15 };
const SHIFT = { swapAt: 0.85, freshEnough: 0.45 };

export function createStaffState(seed = 31337): StaffState {
  const s: StaffState = {
    members: [], candidates: [], nextId: 1, rng: seed >>> 0, nextRefresh: 0, dutyOperatorId: null,
    autopilot: { enabled: true, mode: 'follow', setpointMW: 600 },
  };
  return s;
}

export class Staff {
  constructor(readonly state: StaffState = createStaffState()) {
    if (this.state.candidates.length === 0) this.refreshCandidates(0);
  }

  private random(): number {
    const [v, s] = rand(this.state.rng);
    this.state.rng = s;
    return v;
  }

  private makePerson(role: Role): StaffMember {
    const skill = 1 + Math.floor(this.random() * 5);
    const crew = role === 'maintenance' || role === 'lineCrew';
    const name = crew
      ? `${CREW_NAMES[Math.floor(this.random() * CREW_NAMES.length)]} ${role === 'lineCrew' ? 'Line' : 'Maintenance'} Crew`
      : `${FIRST[Math.floor(this.random() * FIRST.length)]} ${LAST[Math.floor(this.random() * LAST.length)]}`;
    const wage = Math.round(ROLE_INFO[role].baseWage * (0.7 + 0.15 * skill));
    return { id: this.state.nextId++, name, role, skill, wage, fatigue: 0, busyWith: null };
  }

  /** New job applicants: two per role, refreshed every game day. */
  refreshCandidates(t: number): void {
    this.state.candidates = [];
    for (const role of Object.keys(ROLE_INFO) as Role[]) {
      this.state.candidates.push(this.makePerson(role), this.makePerson(role));
    }
    this.state.nextRefresh = t + 86400;
  }

  hire(candidateId: number): StaffMember | null {
    const i = this.state.candidates.findIndex((c) => c.id === candidateId);
    if (i < 0) return null;
    const [m] = this.state.candidates.splice(i, 1);
    this.state.members.push(m);
    return m;
  }

  fire(id: number): StaffMember | null {
    const i = this.state.members.findIndex((m) => m.id === id);
    if (i < 0) return null;
    const [m] = this.state.members.splice(i, 1);
    if (this.state.dutyOperatorId === id) this.state.dutyOperatorId = null;
    return m;
  }

  byRole(role: Role): StaffMember[] {
    return this.state.members.filter((m) => m.role === role);
  }

  get dutyOperator(): StaffMember | null {
    return this.state.members.find((m) => m.id === this.state.dutyOperatorId) ?? null;
  }

  /** A free crew of a role (most skilled first). */
  availableCrew(role: 'maintenance' | 'lineCrew'): StaffMember | null {
    return this.byRole(role).filter((m) => m.busyWith === null && m.fatigue < 0.95).sort((a, b) => b.skill - a.skill)[0] ?? null;
  }

  get wagesPerHour(): number {
    return this.state.members.reduce((sum, m) => sum + m.wage, 0);
  }

  /** Advance fatigue and shift rotation. `activeFaultIds` frees crews whose job is done. */
  step(t: number, dtGame: number, activeFaultIds: ReadonlySet<number>): string[] {
    const st = this.state;
    const events: string[] = [];
    const h = dtGame / 3600;
    if (t >= st.nextRefresh) this.refreshCandidates(t);

    for (const m of st.members) {
      if (m.busyWith !== null && !activeFaultIds.has(m.busyWith)) {
        m.busyWith = null;
        events.push(`${m.name} is back at base`);
      }
      const rate = m.id === st.dutyOperatorId ? FATIGUE.onDuty : m.busyWith !== null ? FATIGUE.busy : FATIGUE.resting;
      m.fatigue = Math.min(1, Math.max(0, m.fatigue + rate * h));
    }

    // Shift rotation among operators.
    const ops = this.byRole('operator');
    const duty = this.dutyOperator;
    const freshest = ops.filter((o) => o.id !== st.dutyOperatorId).sort((a, b) => a.fatigue - b.fatigue)[0];
    if (!duty) {
      if (freshest && freshest.fatigue < SHIFT.freshEnough) {
        st.dutyOperatorId = freshest.id;
        events.push(`${freshest.name} is on shift in the control room`);
      }
    } else if (duty.fatigue >= SHIFT.swapAt) {
      if (freshest && freshest.fatigue < SHIFT.freshEnough) {
        st.dutyOperatorId = freshest.id;
        events.push(`Shift change: ${freshest.name} relieves ${duty.name}`);
      } else if (duty.fatigue >= 1) {
        st.dutyOperatorId = null;
        events.push(`${duty.name} is exhausted and has gone home. Nobody is minding the reactor.`);
      }
    }
    return events;
  }
}
