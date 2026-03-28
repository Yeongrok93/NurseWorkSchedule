"""
간호사 듀티표 자동 생성 엔진 v2
================================
Google OR-Tools CP-SAT solver 기반

변경 이력 (v2):
  - Hard: N→E 금지, N→O→D 금지
  - Hard: 근무 최소 2일 연속 (단독 1일 근무 금지)
  - Hard: 나이트 2~3개 연속 블록
  - Soft: N→O→E 패턴 페널티
  - Soft: 주말 형평성 제거
  - New:  희망 근무 리퀘스트 soft 반영
"""

from __future__ import annotations
import calendar
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from ortools.sat.python import cp_model


class Shift(str, Enum):
    D = "D"
    E = "E"
    N = "N"
    O = "O"


class Group(str, Enum):
    LEADER = "leader"
    MID    = "mid"
    JUNIOR = "junior"
    FIRST  = "first"


@dataclass
class ShiftRequest:
    day: int
    shift: Shift


@dataclass
class Nurse:
    id: int
    name: str
    group: Group
    is_night_dedicated: bool = False
    fixed_requests: dict[int, Shift] = field(default_factory=dict)
    preferred_requests: list[ShiftRequest] = field(default_factory=list)


@dataclass
class ScheduleConfig:
    year: int
    month: int

    min_staff: dict = field(default_factory=lambda: {
        "weekday":  {Shift.D: 7, Shift.E: 6, Shift.N: 6},
        "saturday": {Shift.D: 6, Shift.E: 5, Shift.N: 5},
        "sunday":   {Shift.D: 5, Shift.E: 5, Shift.N: 5},
    })

    max_consecutive_work: int = 5
    night_dedicated_count: int = 14
    max_first_year: int = 15
    min_night_block: int = 2
    max_night_block: int = 3

    w_request_fulfilled: int = 20
    w_off_fairness: int      = 8
    w_night_fairness: int    = 6
    w_staffmix: int          = 3
    w_noe_pattern: int       = 5

    time_limit_seconds: int = 90


def days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]

def day_type(year: int, month: int, day: int) -> str:
    wd = calendar.weekday(year, month, day)
    if wd == 5: return "saturday"
    if wd == 6: return "sunday"
    return "weekday"

def is_weekend(year: int, month: int, day: int) -> bool:
    return day_type(year, month, day) in ("saturday", "sunday")


class NurseScheduler:
    WORK_SHIFTS = [Shift.D, Shift.E, Shift.N]
    ALL_SHIFTS  = [Shift.D, Shift.E, Shift.N, Shift.O]

    def __init__(self, nurses: list[Nurse], config: ScheduleConfig):
        self.nurses   = nurses
        self.cfg      = config
        self.num_days = days_in_month(config.year, config.month)
        self.days     = range(1, self.num_days + 1)
        self.model    = cp_model.CpModel()
        self.sv: dict = {}

    def _build_variables(self):
        for n in self.nurses:
            self.sv[n.id] = {}
            for d in self.days:
                self.sv[n.id][d] = {}
                for s in self.ALL_SHIFTS:
                    self.sv[n.id][d][s] = self.model.new_bool_var(
                        f"s_n{n.id}_d{d}_{s.value}"
                    )

    def _c_exactly_one_shift_per_day(self):
        for n in self.nurses:
            for d in self.days:
                self.model.add_exactly_one(
                    self.sv[n.id][d][s] for s in self.ALL_SHIFTS
                )

    def _c_fixed_requests(self):
        for n in self.nurses:
            for d, s in n.fixed_requests.items():
                if d in self.days:
                    self.model.add(self.sv[n.id][d][s] == 1)

    def _c_night_dedicated(self):
        for n in self.nurses:
            if not n.is_night_dedicated:
                continue
            self.model.add(
                sum(self.sv[n.id][d][Shift.N] for d in self.days)
                == self.cfg.night_dedicated_count
            )
            for d in self.days:
                self.model.add(self.sv[n.id][d][Shift.D] == 0)
                self.model.add(self.sv[n.id][d][Shift.E] == 0)

    def _c_forbidden_transitions(self):
        """
        금지 전환:
          N→D, N→E, E→D  (1일 후)
          N→O→D           (2일 후)
        """
        for n in self.nurses:
            for d in self.days:
                d1 = d + 1
                d2 = d + 2
                if d1 in self.days:
                    # N→D 금지
                    self.model.add_implication(
                        self.sv[n.id][d][Shift.N],
                        self.sv[n.id][d1][Shift.D].negated()
                    )
                    # N→E 금지 (신규)
                    self.model.add_implication(
                        self.sv[n.id][d][Shift.N],
                        self.sv[n.id][d1][Shift.E].negated()
                    )
                    # E→D 금지
                    self.model.add_implication(
                        self.sv[n.id][d][Shift.E],
                        self.sv[n.id][d1][Shift.D].negated()
                    )
                # N→O→D 금지 (신규): N[d]=1, O[d+1]=1 → D[d+2]=0
                if d1 in self.days and d2 in self.days:
                    nod_flag = self.model.new_bool_var(f"nod_{n.id}_{d}")
                    # nod_flag = N[d] AND O[d+1]
                    self.model.add_bool_and([
                        self.sv[n.id][d][Shift.N],
                        self.sv[n.id][d1][Shift.O],
                    ]).only_enforce_if(nod_flag)
                    self.model.add_bool_or([
                        self.sv[n.id][d][Shift.N].negated(),
                        self.sv[n.id][d1][Shift.O].negated(),
                    ]).only_enforce_if(nod_flag.negated())
                    self.model.add_implication(
                        nod_flag,
                        self.sv[n.id][d2][Shift.D].negated()
                    )

    def _c_min_consecutive_work(self):
        """
        근무 최소 2일 연속: 단독 1일 근무 금지.
        work[d]=1 → work[d-1]=1 OR work[d+1]=1
        """
        for n in self.nurses:
            if n.is_night_dedicated:
                continue
            for d in self.days:
                # work_d: 이날 근무 여부
                work_d = self.model.new_bool_var(f"work_{n.id}_{d}")
                self.model.add(
                    sum(self.sv[n.id][d][s] for s in self.WORK_SHIFTS) >= 1
                ).only_enforce_if(work_d)
                self.model.add(
                    sum(self.sv[n.id][d][s] for s in self.WORK_SHIFTS) == 0
                ).only_enforce_if(work_d.negated())

                neighbors = [work_d.negated()]  # work_d=0이면 OK
                if d - 1 in self.days:
                    prev_work = self.model.new_bool_var(f"work_{n.id}_{d-1}_p")
                    self.model.add(
                        sum(self.sv[n.id][d-1][s] for s in self.WORK_SHIFTS) >= 1
                    ).only_enforce_if(prev_work)
                    self.model.add(
                        sum(self.sv[n.id][d-1][s] for s in self.WORK_SHIFTS) == 0
                    ).only_enforce_if(prev_work.negated())
                    neighbors.append(prev_work)
                if d + 1 in self.days:
                    next_work = self.model.new_bool_var(f"work_{n.id}_{d}_n")
                    self.model.add(
                        sum(self.sv[n.id][d+1][s] for s in self.WORK_SHIFTS) >= 1
                    ).only_enforce_if(next_work)
                    self.model.add(
                        sum(self.sv[n.id][d+1][s] for s in self.WORK_SHIFTS) == 0
                    ).only_enforce_if(next_work.negated())
                    neighbors.append(next_work)
                # work_d → prev_work OR next_work
                self.model.add_bool_or(neighbors)

    def _c_night_block(self):
        """
        나이트 블록 제약:
          - 단독 N 금지: N[d]=1 → N[d-1]=1 OR N[d+1]=1
          - 4개 이상 연속 N 금지
        """
        for n in self.nurses:
            # 4개 이상 연속 N 금지
            for d in self.days:
                window = [d, d+1, d+2, d+3]
                if all(w in self.days for w in window):
                    self.model.add(
                        sum(self.sv[n.id][w][Shift.N] for w in window) <= 3
                    )
            # 단독 N 금지
            for d in self.days:
                neighbors = [self.sv[n.id][d][Shift.N].negated()]
                if d - 1 in self.days:
                    neighbors.append(self.sv[n.id][d-1][Shift.N])
                if d + 1 in self.days:
                    neighbors.append(self.sv[n.id][d+1][Shift.N])
                self.model.add_bool_or(neighbors)

    def _c_max_consecutive_work(self):
        max_w = self.cfg.max_consecutive_work
        for n in self.nurses:
            for d in self.days:
                window = range(d, min(d + max_w + 1, self.num_days + 1))
                if len(window) == max_w + 1:
                    self.model.add(
                        sum(
                            self.sv[n.id][wd][s]
                            for wd in window
                            for s in self.WORK_SHIFTS
                        ) <= max_w
                    )

    def _c_min_staff_per_day(self):
        """최소 인원 이상, 최소+1 이하 (초과 인원은 O 처리)."""
        for d in self.days:
            dtype = day_type(self.cfg.year, self.cfg.month, d)
            for s, min_cnt in self.cfg.min_staff[dtype].items():
                head = sum(self.sv[n.id][d][s] for n in self.nurses)
                self.model.add(head >= min_cnt)
                self.model.add(head <= min_cnt + 1)

    def _c_off_fairness_hard(self):
        """월간 오프 일수 편차 <= 1 (Hard)."""
        off_counts = [
            sum(self.sv[n.id][d][Shift.O] for d in self.days)
            for n in self.nurses
        ]
        min_off = self.model.new_int_var(0, self.num_days, "min_off_h")
        for oc in off_counts:
            self.model.add(oc >= min_off)
            self.model.add(oc <= min_off + 1)

    def _c_leader_per_shift(self):
        leaders = [n for n in self.nurses if n.group == Group.LEADER]
        for d in self.days:
            for s in self.WORK_SHIFTS:
                self.model.add(
                    sum(self.sv[n.id][d][s] for n in leaders) >= 1
                )

    def _c_first_year_limit(self):
        first_year = [n for n in self.nurses if n.group == Group.FIRST]
        assert len(first_year) <= self.cfg.max_first_year, (
            f"1년차 수({len(first_year)}) > 허용({self.cfg.max_first_year})"
        )

    def _build_objective(self):
        penalties = []
        rewards   = []
        cfg = self.cfg

        # ① 희망 근무 반영 보상
        for n in self.nurses:
            for req in n.preferred_requests:
                if req.day not in self.days:
                    continue
                rewards.append(cfg.w_request_fulfilled * self.sv[n.id][req.day][req.shift])

        # ② 나이트 균등 (전담자 제외) — 오프 균등은 Hard로 이동
        non_ded = [n for n in self.nurses if not n.is_night_dedicated]
        if non_ded:
            night_counts = [
                sum(self.sv[n.id][d][Shift.N] for d in self.days)
                for n in non_ded
            ]
            avg_n = self.model.new_int_var(0, self.num_days, "avg_n")
            self.model.add(sum(night_counts) == avg_n * len(non_ded))
            for i, nc in enumerate(night_counts):
                diff  = self.model.new_int_var(-self.num_days, self.num_days, f"n_d_{i}")
                abs_d = self.model.new_int_var(0, self.num_days, f"n_a_{i}")
                self.model.add(diff == nc - avg_n)
                self.model.add_abs_equality(abs_d, diff)
                penalties.append(cfg.w_night_fairness * abs_d)

        # ④ Staff-mix 비율
        group_ratio = {
            Group.LEADER: 0.20, Group.MID: 0.40,
            Group.JUNIOR: 0.10, Group.FIRST: 0.30,
        }
        total_work_slots = sum(
            self.cfg.min_staff[day_type(cfg.year, cfg.month, d)][s]
            for d in self.days for s in self.WORK_SHIFTS
        )
        for grp, ratio in group_ratio.items():
            grp_nurses = [n for n in self.nurses if n.group == grp]
            if not grp_nurses:
                continue
            actual = sum(
                self.sv[n.id][d][s]
                for n in grp_nurses for d in self.days for s in self.WORK_SHIFTS
            )
            target = int(total_work_slots * ratio)
            diff   = self.model.new_int_var(-total_work_slots, total_work_slots, f"mix_{grp.value}")
            abs_d  = self.model.new_int_var(0, total_work_slots, f"mixa_{grp.value}")
            self.model.add(diff == actual - target)
            self.model.add_abs_equality(abs_d, diff)
            penalties.append(cfg.w_staffmix * abs_d)

        # ⑤ N→O→E 패턴 페널티
        for n in self.nurses:
            for d in self.days:
                if d+1 in self.days and d+2 in self.days:
                    noe = self.model.new_bool_var(f"noe_{n.id}_{d}")
                    self.model.add(
                        self.sv[n.id][d][Shift.N]
                        + self.sv[n.id][d+1][Shift.O]
                        + self.sv[n.id][d+2][Shift.E] >= 3
                    ).only_enforce_if(noe)
                    self.model.add(
                        self.sv[n.id][d][Shift.N]
                        + self.sv[n.id][d+1][Shift.O]
                        + self.sv[n.id][d+2][Shift.E] <= 2
                    ).only_enforce_if(noe.negated())
                    penalties.append(cfg.w_noe_pattern * noe)

        return penalties, rewards

    def solve(self) -> Optional[dict]:
        print(f"[Scheduler] {self.cfg.year}년 {self.cfg.month}월 "
              f"/ 간호사 {len(self.nurses)}명 / {self.num_days}일")

        self._build_variables()

        print("[Scheduler] Hard 제약 등록 중...")
        self._c_exactly_one_shift_per_day()
        self._c_fixed_requests()
        self._c_night_dedicated()
        self._c_forbidden_transitions()
        self._c_night_block()
        self._c_min_consecutive_work()
        self._c_max_consecutive_work()
        self._c_min_staff_per_day()
        self._c_off_fairness_hard()
        self._c_leader_per_shift()
        self._c_first_year_limit()

        print("[Scheduler] Soft 목적함수 설정 중...")
        penalties, rewards = self._build_objective()
        self.model.minimize(sum(penalties) - sum(rewards))

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.cfg.time_limit_seconds
        solver.parameters.num_workers = 8
        solver.parameters.log_search_progress = True

        print(f"[Scheduler] 솔버 실행 (제한: {self.cfg.time_limit_seconds}초)...")
        status = solver.solve(self.model)

        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            print(f"[Scheduler] INFEASIBLE (status={solver.status_name(status)})")
            return None

        print(f"[Scheduler] DONE "
              f"(status={solver.status_name(status)}, "
              f"objective={solver.objective_value:.1f})")
        return self._extract_result(solver)

    def _extract_result(self, solver: cp_model.CpSolver) -> dict:
        schedule: dict[str, dict[int, str]] = {}
        for n in self.nurses:
            schedule[n.name] = {}
            for d in self.days:
                for s in self.ALL_SHIFTS:
                    if solver.value(self.sv[n.id][d][s]):
                        schedule[n.name][d] = s.value
                        break
        return {"schedule": schedule, "stats": self._compute_stats(schedule, solver)}

    def _compute_stats(self, schedule: dict, solver: cp_model.CpSolver) -> dict:
        stats = {}
        for n in self.nurses:
            row = schedule[n.name]
            cnt = {s.value: 0 for s in self.ALL_SHIFTS}
            for d in self.days:
                cnt[row.get(d, "O")] += 1
            fulfilled = sum(
                1 for req in n.preferred_requests
                if req.day in self.days
                and solver.value(self.sv[n.id][req.day][req.shift]) == 1
            )
            stats[n.name] = {
                "group": n.group.value,
                "counts": cnt,
                "total_work": cnt["D"] + cnt["E"] + cnt["N"],
                "request_rate": f"{fulfilled}/{len(n.preferred_requests)}",
            }
        return stats