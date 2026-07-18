"""
간호사 듀티표 자동 생성 엔진 v3
================================
Google OR-Tools CP-SAT solver 기반

변경 이력 (v3):
  - New: 2교대 shift 추가 (D6=6D 12h, N6=6N 12h)
  - New: EDU shift 추가 (교육 8h, 인력 미반영)
  - New: CHARGE 그룹 추가 (리더 부분집합, N 금지, 고정 2명)
  - New: is_part_time (주2일제) 지원
  - New: 월 목표 근무시간 기반 오프 계산
         target = (총일수 - 주말 - 공휴일) × 8h
  - New: 주2일제 목표시간 = round(평일수 × 2/5) × 8h
  - New: 6D/6N 쌍 제약 (같은 날 수 일치, 최대 2쌍/일)
  - New: 6D/6N → D+1, E+1, N+1 카운트 반영
  - New: 6D 연속 최대 2개, 6N 연속 최대 2개 (단독 1개 허용)
  - New: 6D→6N 또는 6N→6D 전환 금지 (쌍 내부 전환)
  - New: 차지 제약 (정확히 2명, 같은 shift 중복 금지)
  - New: Soft: NON 패턴(N→O→N), N 7개 초과, 나이트 간격, D/E/N 분배 균등
  - Fix: 공휴일 day_type 반영 (holidays 라이브러리)
"""

from __future__ import annotations

import calendar
import datetime
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

try:
    import holidays as holidays_lib
    HAS_HOLIDAYS = True
except ImportError:
    HAS_HOLIDAYS = False

from ortools.sat.python import cp_model


# ─── 도메인 모델 ──────────────────────────────────────────────────────────────

class Shift(str, Enum):
    D   = "D"    # Day     8h  (3교대)
    E   = "E"    # Evening 8h  (3교대)
    N   = "N"    # Night   8h  (3교대)
    D6  = "6D"   # Day    12h  (2교대)
    N6  = "6N"   # Night  12h  (2교대)
    EDU = "EDU"  # 교육    8h  (D 동일 조건, 인력 미반영)
    O   = "O"    # Off


class Group(str, Enum):
    CHARGE = "charge"  # 차지 (리더 부분집합, N 금지, 고정 2명)
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
    # 2교대 가능 여부 (False면 D/E/N/O만 배정)
    can_two_shift: bool = False
    # 주2일제 여부 (True면 전근무일수×2/5 기준 목표시간 별도 계산)
    is_part_time: bool = False
    fixed_requests: dict[int, Shift] = field(default_factory=dict)
    preferred_requests: list[ShiftRequest] = field(default_factory=list)
    # 프리셉터/프리셉티 매칭
    preceptor_subgroup: Optional[str] = None   # 서브그룹 (A/B/C 등)
    is_preceptee: bool = False                 # True면 staff mix 인원에서 제외
    preceptor_support_days: int = 0            # 월간 프리셉터 지원일 수


@dataclass
class ScheduleConfig:
    year: int
    month: int

    min_staff: dict = field(default_factory=lambda: {
        "weekday":  {Shift.D: 7, Shift.E: 6, Shift.N: 6},
        "saturday": {Shift.D: 6, Shift.E: 5, Shift.N: 5},
        "sunday":   {Shift.D: 5, Shift.E: 5, Shift.N: 5},
    })

    # 2교대 관련
    max_two_shift_pairs_per_day: int = 2
    max_d6_block: int = 2
    max_n6_block: int = 2

    # 3교대 N 블록
    min_night_block: int = 2
    max_night_block: int = 3

    # 기타 Hard
    max_consecutive_work: int = 5
    night_dedicated_count: int = 14
    max_first_year: int = 15

    # 나이트 soft 파라미터
    night_min_gap: int   = 10  # 나이트 블록 간 최소 간격(일)
    night_max_count: int = 7   # N 권장 최대 개수

    # Soft 가중치
    w_request_fulfilled: int = 25   # 희망근무 (올림: 반영률 개선)
    w_request_off: int       = 50   # 오프(O) 희망 — 실무상 가장 중요해 가중치 상향
    w_night_fairness: int    = 20   # 나이트 균등 (올림: 핵심 형평성)
    w_staffmix: int          = 12   # Staff-mix 비율
    w_noe_pattern: int       = 5    # N→O→E 패턴
    w_non_pattern: int       = 7    # N→O→N 패턴
    w_hours_shortage: int    = 0    # unused
    w_hours_target_dev: int  = 0    # unused
    w_hours_spread: int      = 120  # 풀타임 집단 remain spread 기본 억제
    w_hours_spread_hard: int = 2000 # remain 차이 1일 초과 semi-hard
    w_hours_fairness: int    = 80   # 풀타임 remain 형평성
    w_hours_band: int        = 220  # center_rem 1일 초과 이탈 억제
    w_night_over7: int       = 40   # N 7개 초과 억제
    w_night_interval: int    = 9    # 나이트 블록 간격
    w_shift_dist: int        = 8    # D/E/N 분배 균등 (올림: D/E 분포 개선)
    w_two_shift_mix: int     = 15   # 2교대 D/E/N 사용 억제
    w_consec_night4: int     = 200  # 4연속 나이트 억제
    w_staff_short: int       = 300  # 일별 최소인원 미달 (soft 완화 모드에서 최우선)
    w_first_year_over3: int  = 150  # 1년차 미만 한 shift 3명 초과 강력 억제

    time_limit_seconds: int = 90


# ─── 유틸 ────────────────────────────────────────────────────────────────────

def days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def _get_kr_holidays(year: int):
    if HAS_HOLIDAYS:
        return holidays_lib.KR(years=year)
    return {}


def day_type(year: int, month: int, day: int, kr_holidays=None) -> str:
    """'weekday' | 'saturday' | 'sunday'  (공휴일 → sunday)"""
    date = datetime.date(year, month, day)
    if kr_holidays and date in kr_holidays:
        return "sunday"
    wd = calendar.weekday(year, month, day)
    if wd == 5: return "saturday"
    if wd == 6: return "sunday"
    return "weekday"


def _count_work_days(year: int, month: int) -> int:
    kr = _get_kr_holidays(year)
    num_days = days_in_month(year, month)
    count = 0
    for d in range(1, num_days + 1):
        date = datetime.date(year, month, d)
        wd   = calendar.weekday(year, month, d)
        if not (wd >= 5 or date in kr):
            count += 1
    return count


def calc_target_hours(year: int, month: int) -> int:
    """월 목표 근무시간 = (총일수 - 주말 - 공휴일) × 8h"""
    return _count_work_days(year, month) * 8


def calc_part_time_target_hours(year: int, month: int) -> int:
    """주2일제 목표 근무시간 = round(평일수 × 2/5) × 8h"""
    work_days = _count_work_days(year, month)
    return round(work_days * 2 / 5) * 8


# shift별 근무시간
SHIFT_HOURS = {
    Shift.D:   8,
    Shift.E:   8,
    Shift.N:   8,
    Shift.D6:  12,
    Shift.N6:  12,
    Shift.EDU: 8,
    Shift.O:   0,
}

WORK_3        = [Shift.D, Shift.E, Shift.N]
WORK_2        = [Shift.D6, Shift.N6]
EDU_SHIFTS    = [Shift.EDU]
ALL_WORK      = WORK_3 + WORK_2                    # 인력 카운트 기준
ALL_WORK_WITH_EDU = ALL_WORK + EDU_SHIFTS          # 연속근무/시간 계산 기준
ALL_SHIFTS    = ALL_WORK + EDU_SHIFTS + [Shift.O]


# ─── 솔버 ────────────────────────────────────────────────────────────────────

class NurseScheduler:

    def __init__(self, nurses: list[Nurse], config: ScheduleConfig):
        self.nurses     = nurses
        self.cfg        = config
        self.num_days   = days_in_month(config.year, config.month)
        self.days       = range(1, self.num_days + 1)
        self.kr_hols    = _get_kr_holidays(config.year)
        self.model      = cp_model.CpModel()
        self.sv: dict   = {}
        self.target_h          = calc_target_hours(config.year, config.month)
        self.part_time_target_h = calc_part_time_target_hours(config.year, config.month)

        # 그룹/속성별 허용 shift
        self._shifts_for: dict[int, list[Shift]] = {}
        for n in nurses:
            if n.group == Group.CHARGE:
                # 차지: D/E/EDU/O만 (N, 2교대 금지)
                self._shifts_for[n.id] = [Shift.D, Shift.E, Shift.EDU, Shift.O]
            elif n.is_night_dedicated:
                self._shifts_for[n.id] = [Shift.N, Shift.O]
            elif n.can_two_shift:
                # 2교대: 6D/6N 우선, 불가능 시 D/E/N도 허용 (soft penalty로 유도)
                self._shifts_for[n.id] = [Shift.D6, Shift.N6, Shift.D, Shift.E, Shift.N, Shift.O]
            elif n.is_part_time:
                # 주2일제: 낮/저녁/교육만 (야간 금지)
                self._shifts_for[n.id] = [Shift.D, Shift.E, Shift.EDU, Shift.O]
            else:
                self._shifts_for[n.id] = WORK_3 + EDU_SHIFTS + [Shift.O]

    def _dt(self, d: int) -> str:
        return day_type(self.cfg.year, self.cfg.month, d, self.kr_hols)

    # ── 변수 생성 ─────────────────────────────────────────────────────────────

    def _build_variables(self):
        # EDU 고정 리퀘스트가 있는 날만 모아둠
        edu_days: dict = {n.id: {d for d, s in n.fixed_requests.items() if s == Shift.EDU}
                          for n in self.nurses}
        for n in self.nurses:
            self.sv[n.id] = {}
            allowed = self._shifts_for[n.id]
            for d in self.days:
                self.sv[n.id][d] = {}
                for s in ALL_SHIFTS:
                    self.sv[n.id][d][s] = self.model.new_bool_var(
                        f"s_n{n.id}_d{d}_{s.value}"
                    )
                for s in ALL_SHIFTS:
                    if s not in allowed:
                        self.model.add(self.sv[n.id][d][s] == 0)
                # EDU는 고정 리퀘스트가 있는 날에만 허용 (solver 자유 배정 금지)
                if Shift.EDU in allowed and d not in edu_days[n.id]:
                    self.model.add(self.sv[n.id][d][Shift.EDU] == 0)

    # ── Hard: 기본 ────────────────────────────────────────────────────────────

    def _c_exactly_one_shift_per_day(self):
        for n in self.nurses:
            for d in self.days:
                self.model.add_exactly_one(
                    self.sv[n.id][d][s] for s in ALL_SHIFTS
                )

    def _c_fixed_requests(self):
        for n in self.nurses:
            for d, s in n.fixed_requests.items():
                if d in self.days and s in self._shifts_for[n.id]:
                    self.model.add(self.sv[n.id][d][s] == 1)

    # ── Hard: 나이트 전담 ──────────────────────────────────────────────────────

    def _c_night_dedicated(self):
        for n in self.nurses:
            if not n.is_night_dedicated:
                continue
            self.model.add(
                sum(self.sv[n.id][d][Shift.N] for d in self.days)
                == self.cfg.night_dedicated_count
            )

    def _c_night_dedicated_block_gap(self):
        for n in self.nurses:
            if not n.is_night_dedicated:
                continue
            for d in self.days:
                if d + 2 not in self.days:
                    continue
                block_end = self.model.new_bool_var(f"nd_block_end_{n.id}_{d}")
                self.model.add_bool_and([
                    self.sv[n.id][d][Shift.N],
                    self.sv[n.id][d + 1][Shift.O],
                ]).only_enforce_if(block_end)
                self.model.add_bool_or([
                    self.sv[n.id][d][Shift.N].negated(),
                    self.sv[n.id][d + 1][Shift.O].negated(),
                ]).only_enforce_if(block_end.negated())
                self.model.add_implication(block_end, self.sv[n.id][d + 2][Shift.N].negated())

    # ── Hard: 차지 제약 ───────────────────────────────────────────────────────

    def _c_charge_constraints(self):
        """
        차지 그룹:
          1. 반드시 정확히 2명이어야 함 (입력 검증)
          2. 같은 날 같은 shift(D or E)에 2명 동시 배정 금지
        """
        charges = [n for n in self.nurses if n.group == Group.CHARGE]
        if len(charges) == 0:
            return
        assert len(charges) == 2, (
            f"차지그룹은 정확히 2명이어야 합니다 (현재: {len(charges)}명)"
        )
        c1, c2 = charges
        for d in self.days:
            for s in [Shift.D, Shift.E]:
                self.model.add(
                    self.sv[c1.id][d][s] + self.sv[c2.id][d][s] <= 1
                )

    # ── Hard: 6D/6N 쌍 제약 ──────────────────────────────────────────────────

    def _c_two_shift_pair(self):
        for d in self.days:
            d6_cnt = sum(self.sv[n.id][d][Shift.D6] for n in self.nurses)
            n6_cnt = sum(self.sv[n.id][d][Shift.N6] for n in self.nurses)
            self.model.add(d6_cnt == n6_cnt)
            self.model.add(d6_cnt <= self.cfg.max_two_shift_pairs_per_day)

    # ── Hard: 최소 인원 (6D/6N 카운트 포함) ──────────────────────────────────

    def _c_min_staff_per_day(self, hard_min: bool = True):
        """일별 인원 상한(min+1) hard.
        하한은 hard_min=True면 hard, False면 soft(_build_objective ⑪)만으로 처리.
        프리셉티는 인력 카운트에서 제외. 6D→D, 6N→N으로 카운트."""
        countable = [n for n in self.nurses if not n.is_preceptee]
        for d in self.days:
            dtype = self._dt(d)
            req   = self.cfg.min_staff[dtype]
            d6 = sum(self.sv[n.id][d][Shift.D6] for n in countable)
            n6 = sum(self.sv[n.id][d][Shift.N6] for n in countable)
            for s, min_cnt in req.items():
                if s == Shift.D:
                    total = sum(self.sv[n.id][d][Shift.D] for n in countable) + d6
                elif s == Shift.E:
                    total = sum(self.sv[n.id][d][Shift.E] for n in countable)
                elif s == Shift.N:
                    total = sum(self.sv[n.id][d][Shift.N] for n in countable) + n6
                else:
                    continue
                self.model.add(total <= min_cnt + 1)
                if hard_min:
                    self.model.add(total >= min_cnt)

    # ── Hard: 월 목표 근무시간 ────────────────────────────────────────────────

    def _c_monthly_work_hours(self):
        """주2일제 인력에만 월 근무시간 상한 적용."""
        for n in self.nurses:
            if n.is_night_dedicated or (not n.can_two_shift and not n.is_part_time):
                continue
            total_hours = sum(
                SHIFT_HOURS[s] * self.sv[n.id][d][s]
                for d in self.days
                for s in ALL_WORK_WITH_EDU
            )
            if n.is_part_time:
                # 주2일제: weekly 조건이 하한 보장, 상한은 넉넉하게 target+24h
                self.model.add(total_hours <= self.part_time_target_h + 24)
                # 주 단위(월~일) 최소 2일 근무
                self._c_part_time_weekly(n)

    # ── Hard: 주2일제 주 단위 최소 근무 ──────────────────────────────────────────

    def _c_part_time_weekly(self, n: "Nurse"):
        """주2일제: ISO 주(월~일) 단위로 최소 2일 근무.
        월내 날짜가 5일 미만인 부분 주(월 초/말 짤린 주)는 건너뜀."""
        import datetime
        # ISO 주번호별로 월내 날짜 수집
        week_map: dict[int, list[int]] = {}
        for d in self.days:
            iso_week = datetime.date(self.cfg.year, self.cfg.month, d).isocalendar()[1]
            week_map.setdefault(iso_week, []).append(d)

        for week_days in week_map.values():
            if len(week_days) < 5:   # 부분 주 건너뜀
                continue
            work_count = sum(
                self.sv[n.id][d][s]
                for d in week_days for s in ALL_WORK_WITH_EDU
            )
            self.model.add(work_count >= 2)

    # ── Hard: 오프 균등 (풀타임만) ────────────────────────────────────────────

    def _c_off_fairness_hard(self):
        """월간 오프 일수 편차 ≤ 5 (주2일제·2교대·N전담·프리셉티 제외)."""
        full_time = [n for n in self.nurses
                     if not n.is_part_time and not n.can_two_shift
                     and not n.is_night_dedicated and not n.is_preceptee]
        if not full_time:
            return
        off_counts = [
            sum(self.sv[n.id][d][Shift.O] for d in self.days)
            for n in full_time
        ]
        min_off = self.model.new_int_var(0, self.num_days, "min_off_h")
        for oc in off_counts:
            self.model.add(oc >= min_off)
            self.model.add(oc <= min_off + 5)

    # 근무시간 형평성은 soft penalty(⑨)로만 처리 — hard 제약 없음

    # ── Hard: shift 전환 금지 ─────────────────────────────────────────────────

    def _c_remain_spread_hard(self):
        """remain spread ≤ 5 (N전담·주2일·프리셉티 제외). 느슨하게 검색 가이드."""
        full_time = [n for n in self.nurses
                     if not n.is_night_dedicated and not n.is_part_time
                     and not n.is_preceptee]
        if not full_time:
            return
        rem_min = -self.num_days
        rem_max = self.num_days
        remain_vars = []
        for n in full_time:
            total_h = self.model.new_int_var(0, self.num_days * 12, f"hard_total_h_{n.id}")
            self.model.add(total_h == sum(
                SHIFT_HOURS[s] * self.sv[n.id][d][s]
                for d in self.days for s in ALL_WORK_WITH_EDU
            ))
            rem = self.model.new_int_var(rem_min, rem_max, f"hard_rem_{n.id}")
            self.model.add(rem * 8 == total_h - self.target_h)
            remain_vars.append(rem)
        min_rem = self.model.new_int_var(rem_min, rem_max, "hard_min_rem")
        max_rem = self.model.new_int_var(rem_min, rem_max, "hard_max_rem")
        for rem in remain_vars:
            self.model.add(rem >= min_rem)
            self.model.add(rem <= max_rem)
        self.model.add(max_rem - min_rem <= 5)

    def _c_forbidden_transitions(self):
        for n in self.nurses:
            for d in self.days:
                d1 = d + 1
                d2 = d + 2
                if d1 not in self.days:
                    continue

                sv = self.sv[n.id]

                # 3교대
                self.model.add_implication(sv[d][Shift.N], sv[d1][Shift.D].negated())
                self.model.add_implication(sv[d][Shift.N], sv[d1][Shift.E].negated())
                self.model.add_implication(sv[d][Shift.E], sv[d1][Shift.D].negated())
                # N/E 다음날 EDU 금지 (D와 동일 조건)
                self.model.add_implication(sv[d][Shift.N], sv[d1][Shift.EDU].negated())
                self.model.add_implication(sv[d][Shift.E], sv[d1][Shift.EDU].negated())

                # 2교대
                self.model.add_implication(sv[d][Shift.E],  sv[d1][Shift.D6].negated())  # E→6D 금지
                self.model.add_implication(sv[d][Shift.N6], sv[d1][Shift.D6].negated())
                self.model.add_implication(sv[d][Shift.N6], sv[d1][Shift.D].negated())
                self.model.add_implication(sv[d][Shift.N6], sv[d1][Shift.E].negated())
                self.model.add_implication(sv[d][Shift.N6], sv[d1][Shift.EDU].negated())
                # 6N→N 허용 (나이트 4연속은 N+6N 합산 윈도우로 처리)
                self.model.add_implication(sv[d][Shift.N],  sv[d1][Shift.D6].negated())
                self.model.add_implication(sv[d][Shift.D6], sv[d1][Shift.N].negated())

                # N→O→D/6D 금지, 6N→O→6D 금지
                if d2 in self.days:
                    # N→O→* 패턴
                    nod = self.model.new_bool_var(f"nod_{n.id}_{d}")
                    self.model.add_bool_and([sv[d][Shift.N], sv[d1][Shift.O]]).only_enforce_if(nod)
                    self.model.add_bool_or([sv[d][Shift.N].negated(), sv[d1][Shift.O].negated()]).only_enforce_if(nod.negated())
                    self.model.add_implication(nod, sv[d2][Shift.D].negated())
                    self.model.add_implication(nod, sv[d2][Shift.D6].negated())
                    self.model.add_implication(nod, sv[d2][Shift.EDU].negated())
                    # 6N→O→6D 금지
                    n6od = self.model.new_bool_var(f"n6od_{n.id}_{d}")
                    self.model.add_bool_and([sv[d][Shift.N6], sv[d1][Shift.O]]).only_enforce_if(n6od)
                    self.model.add_bool_or([sv[d][Shift.N6].negated(), sv[d1][Shift.O].negated()]).only_enforce_if(n6od.negated())
                    self.model.add_implication(n6od, sv[d2][Shift.D6].negated())

    # ── Hard: 연속 근무 ───────────────────────────────────────────────────────

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
                            for s in ALL_WORK_WITH_EDU
                        ) <= max_w
                    )

    def _c_min_consecutive_work(self):
        """단독 1일 근무 금지 (N전담·주2일제 제외)."""
        for n in self.nurses:
            if n.is_night_dedicated or n.is_part_time:
                continue
            for d in self.days:
                work_d = self.model.new_bool_var(f"work_{n.id}_{d}")
                self.model.add(sum(self.sv[n.id][d][s] for s in ALL_WORK_WITH_EDU) >= 1).only_enforce_if(work_d)
                self.model.add(sum(self.sv[n.id][d][s] for s in ALL_WORK_WITH_EDU) == 0).only_enforce_if(work_d.negated())

                neighbors = [work_d.negated()]
                for dd, suffix in [(d-1, "p"), (d+1, "n")]:
                    if dd in self.days:
                        nb = self.model.new_bool_var(f"work_{n.id}_{d}_{suffix}")
                        self.model.add(sum(self.sv[n.id][dd][s] for s in ALL_WORK_WITH_EDU) >= 1).only_enforce_if(nb)
                        self.model.add(sum(self.sv[n.id][dd][s] for s in ALL_WORK_WITH_EDU) == 0).only_enforce_if(nb.negated())
                        neighbors.append(nb)
                self.model.add_bool_or(neighbors)

    # ── Hard: N 블록 (3교대) ──────────────────────────────────────────────────

    def _c_night_block_3shift(self):
        for n in self.nurses:
            for d in self.days:
                # N 연속 4개 금지
                window = [d, d+1, d+2, d+3]
                if all(w in self.days for w in window):
                    self.model.add(
                        sum(self.sv[n.id][w][Shift.N] for w in window) <= 3
                    )

                # N 단독 근무 금지 (인접 N 또는 6N 있어야 함)
                neighbors = [self.sv[n.id][d][Shift.N].negated()]
                if d-1 in self.days:
                    neighbors.append(self.sv[n.id][d-1][Shift.N])
                    neighbors.append(self.sv[n.id][d-1][Shift.N6])
                if d+1 in self.days:
                    neighbors.append(self.sv[n.id][d+1][Shift.N])
                    neighbors.append(self.sv[n.id][d+1][Shift.N6])
                self.model.add_bool_or(neighbors)

    def _c_night_block_2shift(self):
        for n in self.nurses:
            if not n.can_two_shift:
                continue
            for s2 in [Shift.D6, Shift.N6]:
                for d in self.days:
                    window = [d, d+1, d+2]
                    if all(w in self.days for w in window):
                        self.model.add(sum(self.sv[n.id][w][s2] for w in window) <= 2)

    # ── Hard: 프리셉터 지원일 ────────────────────────────────────────────────

    def _c_preceptor_support(self):
        """프리셉터 지원일 제약:
        1. 서브그룹별 총 지원일 수 = preceptor_support_days
        2. 지원일에 프리셉터는 반드시 근무 (D/E/N)
        3. 지원일에 프리셉티는 프리셉터와 동일 shift
        """
        # 서브그룹별 프리셉터-프리셉티 쌍 수집
        subgroups: dict[str, list[Nurse]] = {}
        for n in self.nurses:
            if n.preceptor_subgroup:
                subgroups.setdefault(n.preceptor_subgroup, []).append(n)

        self._preceptor_pairs: dict[str, tuple[Nurse, Nurse]] = {}
        self._support_day_vars: dict[str, dict[int, any]] = {}

        for sg, members in subgroups.items():
            preceptors = [n for n in members if not n.is_preceptee]
            preceptees = [n for n in members if n.is_preceptee]
            if not preceptors or not preceptees:
                continue

            pr = preceptors[0]
            pe = preceptees[0]
            required = pr.preceptor_support_days
            if not required or required <= 0:
                self._preceptor_pairs[sg] = (pr, pe)
                continue

            self._preceptor_pairs[sg] = (pr, pe)

            # 지원일 결정 변수
            day_vars: dict[int, any] = {}
            for d in self.days:
                day_vars[d] = self.model.new_bool_var(f"support_{sg}_{d}")
            self._support_day_vars[sg] = day_vars

            # 총 지원일 == required
            self.model.add(
                sum(day_vars[d] for d in self.days) == required
            )

            for d in self.days:
                sup = day_vars[d]

                # 지원일 → 프리셉터 반드시 근무 (D/E/N 중 하나)
                pr_works = sum(self.sv[pr.id][d][s] for s in WORK_3)
                self.model.add(pr_works >= 1).only_enforce_if(sup)

                # 지원일 → 프리셉티는 프리셉터와 동일 shift
                for s in WORK_3:
                    pr_on_s_and_sup = self.model.new_bool_var(
                        f"sup_match_{sg}_{d}_{s.value}")
                    self.model.add_bool_and([
                        sup, self.sv[pr.id][d][s]
                    ]).only_enforce_if(pr_on_s_and_sup)
                    self.model.add_bool_or([
                        sup.negated(), self.sv[pr.id][d][s].negated()
                    ]).only_enforce_if(pr_on_s_and_sup.negated())
                    self.model.add_implication(
                        pr_on_s_and_sup, self.sv[pe.id][d][s])

    # ── Hard: 리더/차지 per shift ─────────────────────────────────────────────

    def _c_leader_per_shift(self):
        """D/E/N 각 shift마다 리더 또는 차지 최소 1명."""
        leaders = [n for n in self.nurses if n.group in (Group.LEADER, Group.CHARGE)]
        for d in self.days:
            pairs = sum(self.sv[n.id][d][Shift.D6] for n in self.nurses)
            for s in WORK_3:
                leader_cnt = sum(self.sv[n.id][d][s] for n in leaders)
                self.model.add(leader_cnt + pairs >= 1)

    # ── Hard: 일반 간호사 월간 N 최대 8개 ────────────────────────────────────────

    def _c_max_night_per_nurse(self):
        """N전담·2교대·주2일제 제외한 일반 간호사 월간 N ≤ 8."""
        for n in self.nurses:
            if n.is_night_dedicated or n.can_two_shift or n.is_part_time:
                continue
            night_total = sum(self.sv[n.id][d][Shift.N] for d in self.days)
            self.model.add(night_total <= 8)

    # ── Hard: 일반 간호사 월간 N 최소 2개 ────────────────────────────────────────

    def _c_min_night_per_nurse(self):
        """N전담·2교대·주2일제·charge 제외한 일반 간호사 월간 N ≥ 2.
        charge는 N 금지이므로 제외."""
        for n in self.nurses:
            if (n.is_night_dedicated or n.can_two_shift
                    or n.is_part_time or n.group == Group.CHARGE):
                continue
            night_total = sum(self.sv[n.id][d][Shift.N] for d in self.days)
            self.model.add(night_total >= 2)

    # ── Hard: 최소 근무시간 (remain >= -3) ───────────────────────────────────────

    def _c_min_work_hours_per_nurse(self):
        """일반 간호사 + 2교대 월 최소 근무 = target - 24h (remain >= -3).
        N전담·주2일제 제외."""
        for n in self.nurses:
            if n.is_night_dedicated or n.is_part_time:
                continue
            total_hours = sum(
                SHIFT_HOURS[s] * self.sv[n.id][d][s]
                for d in self.days for s in ALL_WORK_WITH_EDU
            )
            self.model.add(total_hours >= self.target_h - 24)

    # ── Soft 목적함수 ─────────────────────────────────────────────────────────

    def _build_objective(self):
        penalties = []
        rewards   = []
        cfg       = self.cfg

        # ① 희망 근무 보상 (오프 희망은 가중치 상향)
        for n in self.nurses:
            for req in n.preferred_requests:
                if req.day not in self.days:
                    continue
                if req.shift in self._shifts_for[n.id]:
                    w = cfg.w_request_off if req.shift == Shift.O else cfg.w_request_fulfilled
                    rewards.append(w * self.sv[n.id][req.day][req.shift])

        # ① -b 2교대 간호사 D/E/N 사용 패널티 (6D/6N 선호, 3교대 혼용 허용)
        for n in self.nurses:
            if not n.can_two_shift:
                continue
            for d in self.days:
                for s in [Shift.D, Shift.E, Shift.N]:
                    penalties.append(cfg.w_two_shift_mix * self.sv[n.id][d][s])

        # ② 나이트 균등 — 그룹별 분리 (리더급 / 나머지)
        #    전담·주2일제·2교대·charge 제외
        _n_eligible = [n for n in self.nurses
                       if not n.is_night_dedicated
                       and not n.is_part_time
                       and not n.can_two_shift
                       and n.group != Group.CHARGE]
        leader_grp  = [n for n in _n_eligible if n.group == Group.LEADER]
        other_grp   = [n for n in _n_eligible if n.group != Group.LEADER]

        for gi, grp_list in enumerate([leader_grp, other_grp]):
            if len(grp_list) < 2:
                continue
            night_counts = [
                sum(self.sv[n.id][d][Shift.N] for d in self.days)
                for n in grp_list
            ]
            # avg_n = floor(총합 / 인원수) — 등식으로 걸면 총합이 인원수의
            # 배수여야 하는 하드 제약이 되어 해 공간을 붕괴시킴
            avg_n = self.model.new_int_var(0, self.num_days, f"avg_n_g{gi}")
            _L = len(grp_list)
            self.model.add(sum(night_counts) - avg_n * _L >= 0)
            self.model.add(sum(night_counts) - avg_n * _L <= _L - 1)
            for i, nc in enumerate(night_counts):
                diff  = self.model.new_int_var(-self.num_days, self.num_days, f"n_d_g{gi}_{i}")
                abs_d = self.model.new_int_var(0, self.num_days, f"n_a_g{gi}_{i}")
                self.model.add(diff == nc - avg_n)
                self.model.add_abs_equality(abs_d, diff)
                penalties.append(cfg.w_night_fairness * abs_d)

        # ③ Staff-mix 비율 (차지+리더 합산, 프리셉티 제외)
        group_ratio = {
            Group.LEADER: 0.20, Group.MID: 0.40,
            Group.JUNIOR: 0.10, Group.FIRST: 0.30,
        }
        total_work_slots = sum(
            self.cfg.min_staff[self._dt(d)][s]
            for d in self.days for s in WORK_3
        )
        countable_nurses = [n for n in self.nurses if not n.is_preceptee]
        for grp, ratio in group_ratio.items():
            if grp == Group.LEADER:
                grp_nurses = [n for n in countable_nurses
                              if n.group in (Group.LEADER, Group.CHARGE)]
            else:
                grp_nurses = [n for n in countable_nurses if n.group == grp]
            if not grp_nurses:
                continue
            actual = sum(
                self.sv[n.id][d][s]
                for n in grp_nurses for d in self.days for s in ALL_WORK
            )
            target  = int(total_work_slots * ratio)
            diff    = self.model.new_int_var(-total_work_slots, total_work_slots, f"mix_{grp.value}")
            abs_d   = self.model.new_int_var(0, total_work_slots, f"mixa_{grp.value}")
            self.model.add(diff == actual - target)
            self.model.add_abs_equality(abs_d, diff)
            penalties.append(cfg.w_staffmix * abs_d)

        # ④ N→O→E 패턴 페널티
        for n in self.nurses:
            for d in self.days:
                if d+1 in self.days and d+2 in self.days:
                    noe = self.model.new_bool_var(f"noe_{n.id}_{d}")
                    expr = (self.sv[n.id][d][Shift.N]
                            + self.sv[n.id][d+1][Shift.O]
                            + self.sv[n.id][d+2][Shift.E])
                    self.model.add(expr >= 3).only_enforce_if(noe)
                    self.model.add(expr <= 2).only_enforce_if(noe.negated())
                    penalties.append(cfg.w_noe_pattern * noe)

        # ⑤ N→O→N 패턴 페널티 (나이트 쉬고 바로 나이트, 전체 간호사)
        for n in self.nurses:
            for d in self.days:
                if d+1 in self.days and d+2 in self.days:
                    non_flag = self.model.new_bool_var(f"non_{n.id}_{d}")
                    expr = (self.sv[n.id][d][Shift.N]
                            + self.sv[n.id][d+1][Shift.O]
                            + self.sv[n.id][d+2][Shift.N])
                    self.model.add(expr >= 3).only_enforce_if(non_flag)
                    self.model.add(expr <= 2).only_enforce_if(non_flag.negated())
                    penalties.append(cfg.w_non_pattern * non_flag)

        # ⑥ N 7개 초과 페널티 (전담자·2교대 제외)
        for n in self.nurses:
            if n.is_night_dedicated or n.can_two_shift:
                continue
            night_total = sum(self.sv[n.id][d][Shift.N] for d in self.days)
            over7 = self.model.new_int_var(0, self.num_days, f"nover7_{n.id}")
            self.model.add(over7 >= night_total - cfg.night_max_count)
            self.model.add(over7 >= 0)
            penalties.append(cfg.w_night_over7 * over7)

        # ⑦ 나이트 블록 간격 10일 미만 페널티 (전담자·2교대 제외)
        gap = cfg.night_min_gap
        for n in self.nurses:
            if n.is_night_dedicated or n.can_two_shift:
                continue
            for d in self.days:
                if d+1 not in self.days:
                    continue
                block_end = self.model.new_bool_var(f"nend_{n.id}_{d}")
                self.model.add_bool_and([
                    self.sv[n.id][d][Shift.N],
                    self.sv[n.id][d+1][Shift.N].negated(),
                ]).only_enforce_if(block_end)
                self.model.add_bool_or([
                    self.sv[n.id][d][Shift.N].negated(),
                    self.sv[n.id][d+1][Shift.N],
                ]).only_enforce_if(block_end.negated())

                for k in range(2, gap + 1):
                    if d + k not in self.days:
                        break
                    close_n = self.model.new_bool_var(f"ngap_{n.id}_{d}_{k}")
                    self.model.add_bool_and([
                        block_end,
                        self.sv[n.id][d+k][Shift.N],
                    ]).only_enforce_if(close_n)
                    self.model.add_bool_or([
                        block_end.negated(),
                        self.sv[n.id][d+k][Shift.N].negated(),
                    ]).only_enforce_if(close_n.negated())
                    penalties.append(cfg.w_night_interval * (gap - k + 1) * close_n)

        # ⑧ D/E/N 분배 균등 (전담·2교대·주2일제 제외)
        regular = [n for n in self.nurses
                   if not n.is_night_dedicated
                   and not n.can_two_shift
                   and not n.is_part_time]
        for sh in [Shift.D, Shift.E, Shift.N]:
            if not regular:
                break
            sh_counts = [
                sum(self.sv[n.id][d][sh] for d in self.days)
                for n in regular
            ]
            # floor 평균 (등식 사용 시 배수 하드 제약이 되어버림 — ② 참조)
            avg_sh = self.model.new_int_var(0, self.num_days, f"avg_{sh.value}")
            _R = len(regular)
            self.model.add(sum(sh_counts) - avg_sh * _R >= 0)
            self.model.add(sum(sh_counts) - avg_sh * _R <= _R - 1)
            for i, sc in enumerate(sh_counts):
                diff  = self.model.new_int_var(-self.num_days, self.num_days, f"sdiff_{sh.value}_{i}")
                abs_d = self.model.new_int_var(0, self.num_days, f"sabs_{sh.value}_{i}")
                self.model.add(diff == sc - avg_sh)
                self.model.add_abs_equality(abs_d, diff)
                penalties.append(cfg.w_shift_dist * abs_d)

        # ⑨ 4연속 나이트 억제 (N+6N 합산, 전체 간호사)
        # over3 = max(0, sum(N+6N in window) - 3) → 초과량만큼 패널티
        for n in self.nurses:
            for d in self.days:
                window = [d, d+1, d+2, d+3]
                if not all(w in self.days for w in window):
                    continue
                total_n = sum(
                    self.sv[n.id][w][Shift.N] + self.sv[n.id][w][Shift.N6]
                    for w in window
                )
                over3 = self.model.new_int_var(0, 4, f"n4_{n.id}_{d}")
                self.model.add(over3 >= total_n - 3)
                penalties.append(cfg.w_consec_night4 * over3)

        # ⑪ 일별 최소인원 미달 패널티 (D/E/N 공통, 프리셉티 제외)
        countable_for_staff = [n for n in self.nurses if not n.is_preceptee]
        for d in self.days:
            dtype = self._dt(d)
            req   = self.cfg.min_staff[dtype]
            d6_s = sum(self.sv[n.id][d][Shift.D6] for n in countable_for_staff)
            n6_s = sum(self.sv[n.id][d][Shift.N6] for n in countable_for_staff)
            for s, min_cnt in req.items():
                if s not in (Shift.D, Shift.E, Shift.N):
                    continue
                actual = sum(self.sv[n.id][d][s] for n in countable_for_staff)
                if s == Shift.D:
                    actual = actual + d6_s
                elif s == Shift.N:
                    actual = actual + n6_s
                short  = self.model.new_int_var(0, 2, f"short_{s.value}_{d}")
                self.model.add(short >= min_cnt - actual)
                penalties.append(cfg.w_staff_short * short)

        # ⑩ 풀타임(3교대+2교대) remain 형평성
        full_time = [n for n in self.nurses
                     if not n.is_night_dedicated and not n.is_part_time]
        if full_time:
            target_h = self.target_h
            rem_min = -self.num_days
            rem_max = self.num_days
            remain_vars = []

            for n in full_time:
                total_h = self.model.new_int_var(0, self.num_days * 12, f"total_h_{n.id}")
                self.model.add(total_h == sum(
                    SHIFT_HOURS[s] * self.sv[n.id][d][s]
                    for d in self.days for s in ALL_WORK_WITH_EDU
                ))

                rem = self.model.new_int_var(-self.num_days, self.num_days, f"rem_{n.id}")
                self.model.add(rem * 8 == total_h - target_h)
                remain_vars.append(rem)

            min_rem = self.model.new_int_var(rem_min, rem_max, "min_rem")
            max_rem = self.model.new_int_var(rem_min, rem_max, "max_rem")
            for rem in remain_vars:
                self.model.add(rem >= min_rem)
                self.model.add(rem <= max_rem)
            spread_over = self.model.new_int_var(0, self.num_days * 2, "rem_spread_over")
            spread_hard_over = self.model.new_int_var(0, self.num_days * 2, "rem_spread_hard_over")
            spread_gap = self.model.new_int_var(0, self.num_days * 2, "rem_spread_gap")
            self.model.add(spread_gap == max_rem - min_rem)
            # spread 자체는 완만하게 누르고, 1일 초과분은 사실상 semi-hard로 강하게 억제
            self.model.add(spread_over >= spread_gap - 1)
            self.model.add(spread_hard_over >= spread_gap - 1)
            penalties.append(cfg.w_hours_spread * spread_over)
            penalties.append(cfg.w_hours_spread_hard * spread_hard_over)

            center_rem = self.model.new_int_var(rem_min, rem_max, "center_rem")
            for i, rv in enumerate(remain_vars):
                diff  = self.model.new_int_var(-self.num_days * 2, self.num_days * 2, f"rem_d_{i}")
                abs_d = self.model.new_int_var(0, self.num_days * 2, f"rem_a_{i}")
                band_over = self.model.new_int_var(0, self.num_days * 2, f"rem_band_{i}")
                self.model.add(diff == rv - center_rem)
                self.model.add_abs_equality(abs_d, diff)
                self.model.add(band_over >= abs_d - 1)
                penalties.append(cfg.w_hours_fairness * abs_d)
                penalties.append(cfg.w_hours_band * band_over)

        # ⑫ 프리셉터-프리셉티 같은 근무 매칭 보상
        #    지원일은 hard로 강제되므로 자연스럽게 보상 획득,
        #    비지원일에도 매칭 유도
        for sg, pair in self._preceptor_pairs.items():
            pr, pe = pair
            for d in self.days:
                for s in WORK_3:
                    both = self.model.new_bool_var(
                        f"pmatch_{pr.id}_{pe.id}_{d}_{s.value}")
                    self.model.add_bool_and([
                        self.sv[pr.id][d][s],
                        self.sv[pe.id][d][s],
                    ]).only_enforce_if(both)
                    self.model.add_bool_or([
                        self.sv[pr.id][d][s].negated(),
                        self.sv[pe.id][d][s].negated(),
                    ]).only_enforce_if(both.negated())
                    rewards.append(cfg.w_request_fulfilled * both)

        # ⑬ 프리셉터 지원일 인력 부족 패널티
        #    지원일에 프리셉터가 배정된 shift의 최소인원이 +1 필요
        if self._support_day_vars:
            countable_s = [n for n in self.nurses if not n.is_preceptee]
            for d in self.days:
                dtype = self._dt(d)
                req = self.cfg.min_staff[dtype]
                pairs_s = sum(self.sv[n.id][d][Shift.D6] for n in countable_s)
                for s in [Shift.D, Shift.E, Shift.N]:
                    if s not in req:
                        continue
                    min_cnt = req[s]
                    actual_s = sum(self.sv[n.id][d][s] for n in countable_s)
                    for sg, day_vars in self._support_day_vars.items():
                        pr = self._preceptor_pairs[sg][0]
                        # 지원일 AND 프리셉터가 이 shift에 있는 경우
                        sup_here = self.model.new_bool_var(f"suph_{sg}_{d}_{s.value}")
                        self.model.add_bool_and([
                            day_vars[d], self.sv[pr.id][d][s]
                        ]).only_enforce_if(sup_here)
                        self.model.add_bool_or([
                            day_vars[d].negated(), self.sv[pr.id][d][s].negated()
                        ]).only_enforce_if(sup_here.negated())
                        # 부족분 패널티 (지원일에만 활성)
                        short = self.model.new_int_var(
                            0, 3, f"sup_short_{sg}_{d}_{s.value}")
                        self.model.add(
                            short >= min_cnt + 1 - actual_s - pairs_s
                        ).only_enforce_if(sup_here)
                        penalties.append(cfg.w_staff_short * 2 * short)

        # ⑭ 1년차 미만(FIRST) 한 shift에 3명 초과 강력 억제
        first_nurses = [n for n in self.nurses
                        if n.group == Group.FIRST and not n.is_preceptee]
        if first_nurses:
            for d in self.days:
                for s in WORK_3:
                    first_cnt = sum(self.sv[n.id][d][s] for n in first_nurses)
                    over3 = self.model.new_int_var(0, len(first_nurses),
                                                   f"first_over3_{d}_{s.value}")
                    self.model.add(over3 >= first_cnt - 3)
                    penalties.append(cfg.w_first_year_over3 * over3)

        return penalties, rewards

    # ── 메인 ─────────────────────────────────────────────────────────────────

    def _register_hard_constraints(self, hard_min_staff: bool = True):
        print("[Scheduler] Hard 제약 등록 중...")
        self._c_exactly_one_shift_per_day()
        self._c_fixed_requests()
        self._c_night_dedicated()
        self._c_night_dedicated_block_gap()
        self._c_charge_constraints()
        self._c_two_shift_pair()
        self._c_monthly_work_hours()
        self._c_forbidden_transitions()
        self._c_night_block_3shift()
        self._c_night_block_2shift()
        self._c_min_consecutive_work()
        self._c_max_consecutive_work()
        self._c_min_staff_per_day(hard_min=hard_min_staff)
        self._c_remain_spread_hard()
        self._c_leader_per_shift()
        self._c_preceptor_support()
        self._c_max_night_per_nurse()
        self._c_min_night_per_nurse()

    def solve(self) -> Optional[dict]:
        """1차: 최소인원 hard로 시도.
        하드 제약 충돌(INFEASIBLE) 시에만 최소인원을 soft로 완화해 재시도."""
        result = self._solve_attempt(hard_min_staff=True)
        if result is not None or self._last_status != cp_model.INFEASIBLE:
            return result
        print("[Scheduler] [RELAX] 최소인원 hard 불가 → soft로 완화 후 재시도...")
        fresh = NurseScheduler(self.nurses, self.cfg)
        return fresh._solve_attempt(hard_min_staff=False)

    def _solve_attempt(self, hard_min_staff: bool) -> Optional[dict]:
        print(f"[Scheduler] {self.cfg.year}년 {self.cfg.month}월 "
              f"/ 간호사 {len(self.nurses)}명 / {self.num_days}일")
        print(f"[Scheduler] 월 목표 근무시간: {self.target_h}h "
              f"(주2일제: {self.part_time_target_h}h)")
        self._last_status = cp_model.UNKNOWN

        self._build_variables()
        self._register_hard_constraints(hard_min_staff=hard_min_staff)

        # Phase 1: feasibility 확보 (목적함수 없이 — 정상 데이터면 수 초 내 완료)
        print("[Scheduler] Phase 1: feasibility 확보 중...")
        feas_solver = cp_model.CpSolver()
        feas_solver.parameters.max_time_in_seconds = 15
        feas_solver.parameters.num_workers = 0        # 0 = 모든 코어 사용
        feas_status = feas_solver.solve(self.model)

        feas_sol = None
        if feas_status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            feas_sol = feas_solver.response_proto.solution
            print(f"[Scheduler] Phase 1: feasible 해 확보 완료")
        elif feas_status == cp_model.INFEASIBLE:
            # 하드 제약끼리 이미 충돌 — 더 돌려봐야 소용없음
            print("[Scheduler] [FAIL] 하드 제약 충돌 (INFEASIBLE)")
            self._last_status = cp_model.INFEASIBLE
            return None
        else:
            print(f"[Scheduler] Phase 1: {feas_solver.status_name(feas_status)}")

        # Phase 2: 목적함수 최적화 (Phase 1 해를 hint로 warm start)
        print("[Scheduler] Phase 2: Soft 목적함수 최적화 중...")
        penalties, rewards = self._build_objective()
        self.model.minimize(sum(penalties) - sum(rewards))

        if feas_sol is not None:
            for n in self.nurses:
                for d in self.days:
                    for s in ALL_SHIFTS:
                        idx = self.sv[n.id][d][s].index
                        if idx < len(feas_sol):
                            self.model.add_hint(self.sv[n.id][d][s], feas_sol[idx])

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.cfg.time_limit_seconds
        solver.parameters.num_workers = 0             # 0 = 모든 코어 사용
        solver.parameters.log_search_progress = False

        print(f"[Scheduler] 솔버 실행 (제한: {self.cfg.time_limit_seconds}초)...")
        status = solver.solve(self.model)

        # 결과 추출: response_proto.solution 사용
        sol = solver.response_proto.solution

        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) and len(sol) > 0:
            print(f"[Scheduler] [OK] 완료 "
                  f"(status={solver.status_name(status)}, "
                  f"objective={solver.objective_value:.1f})")
            return self._extract_result(solver)

        # UNKNOWN이지만 solution이 있으면 사용
        if len(sol) > 0:
            try:
                obj = solver.objective_value
                print(f"[Scheduler] [WARN] 시간초과 - 최선의 해 반환 (objective={obj:.1f})")
                return self._extract_result(solver)
            except Exception:
                pass

        # Phase 2 실패 시 Phase 1 feasibility 해로 폴백
        if feas_sol is not None:
            print("[Scheduler] [WARN] 최적화 실패 - feasibility 해로 폴백")
            return self._extract_result_from_solution(feas_sol)

        if status == cp_model.INFEASIBLE:
            print("[Scheduler] [FAIL] INFEASIBLE")
            self._last_status = cp_model.INFEASIBLE
        else:
            print("[Scheduler] [FAIL] 해 없음")
        return None

    def _extract_result_from_solution(self, sol) -> dict:
        """raw solution 벡터에서 직접 결과를 추출한다."""
        schedule: dict[str, dict[str, str]] = {}
        for n in self.nurses:
            schedule[n.name] = {}
            for d in self.days:
                for s in ALL_SHIFTS:
                    idx = self.sv[n.id][d][s].index
                    if idx < len(sol) and sol[idx] == 1:
                        schedule[n.name][str(d)] = s.value
                        break
                else:
                    schedule[n.name][str(d)] = Shift.O.value

        support_days: dict[str, list[int]] = {}
        for sg, day_vars in self._support_day_vars.items():
            support_days[sg] = [
                d for d in self.days
                if day_vars[d].index < len(sol) and sol[day_vars[d].index] == 1
            ]

        return {
            "schedule": schedule,
            "stats": self._compute_stats(schedule),
            "support_days": support_days,
        }

    def _extract_result(self, solver: cp_model.CpSolver) -> dict:
        # response_proto.solution을 사용하여 UNKNOWN 상태에서도 안전하게 값 추출
        sol = solver.response_proto.solution

        schedule: dict[str, dict[str, str]] = {}
        for n in self.nurses:
            schedule[n.name] = {}
            for d in self.days:
                for s in ALL_SHIFTS:
                    idx = self.sv[n.id][d][s].index
                    if idx < len(sol) and sol[idx] == 1:
                        schedule[n.name][str(d)] = s.value
                        break
                else:
                    schedule[n.name][str(d)] = Shift.O.value

        # 프리셉터 지원일 추출: {서브그룹: [day, ...]}
        support_days: dict[str, list[int]] = {}
        for sg, day_vars in self._support_day_vars.items():
            support_days[sg] = [
                d for d in self.days
                if day_vars[d].index < len(sol) and sol[day_vars[d].index] == 1
            ]

        return {
            "schedule": schedule,
            "stats": self._compute_stats(schedule),
            "support_days": support_days,
        }

    def _compute_stats(self, schedule: dict) -> dict:
        stats = {}
        for n in self.nurses:
            row = schedule[n.name]
            cnt = {s.value: 0 for s in ALL_SHIFTS}
            total_hours = 0
            for d in self.days:
                sh = row.get(str(d), "O")
                cnt[sh] += 1
                total_hours += SHIFT_HOURS.get(Shift(sh), 0)

            fulfilled = sum(
                1 for req in n.preferred_requests
                if req.day in self.days
                and row.get(str(req.day)) == req.shift.value
            )
            target = self.part_time_target_h if n.is_part_time else self.target_h
            # remain = 실제근무일수환산 - 표준근무일수
            # (양수: 초과 근무, 음수: 오프 초과)
            remain = (total_hours // 8) - (target // 8)
            stats[n.name] = {
                "group": n.group.value,
                "can_two_shift": n.can_two_shift,
                "is_part_time": n.is_part_time,
                "counts": cnt,
                "total_work": sum(cnt[s.value] for s in ALL_WORK_WITH_EDU),
                "total_nights": cnt[Shift.N.value] + cnt[Shift.N6.value],
                "total_hours": total_hours,
                "target_hours": target,
                "remain": remain,
                "request_rate": f"{fulfilled}/{len(n.preferred_requests)}",
            }
        return stats
