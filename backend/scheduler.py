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
    w_request_fulfilled: int = 10   # 희망근무 (낮춤: 형평성보다 우선순위 낮음)
    w_night_fairness: int    = 15   # 나이트 균등 (올림: 핵심 형평성)
    w_staffmix: int          = 12   # Staff-mix 비율 (올림: 매우 중요)
    w_noe_pattern: int       = 5    # N→O→E 패턴
    w_non_pattern: int       = 7    # N→O→N 패턴
    w_hours_fairness: int    = 15   # 리메인 형평성 (올림: 매우 중요)
    w_night_over7: int       = 40   # N 7개 초과 강력 억제
    w_night_interval: int    = 9    # 나이트 블록 간격
    w_shift_dist: int        = 3    # D/E/N 분배 균등 (낮춤: 나이트 균등과 중복)
    w_two_shift_mix: int     = 3    # 2교대 D/E/N 사용 억제 (살짝 낮춤: 3교대 혼용 더 허용)

    time_limit_seconds: int = 180


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
                # 주2일제: 낮/저녁 근무만 (야간 금지)
                self._shifts_for[n.id] = [Shift.D, Shift.E, Shift.O]
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

    def _c_min_staff_per_day(self):
        for d in self.days:
            dtype  = self._dt(d)
            req    = self.cfg.min_staff[dtype]
            pairs  = sum(self.sv[n.id][d][Shift.D6] for n in self.nurses)

            for s, min_cnt in req.items():
                if s == Shift.D:
                    actual = sum(self.sv[n.id][d][Shift.D] for n in self.nurses)
                    total  = actual + pairs
                    # D: 헬프 가능 → [min-1, min]
                    self.model.add(total >= min_cnt - 1)
                    self.model.add(total <= min_cnt)
                elif s == Shift.E:
                    actual = sum(self.sv[n.id][d][Shift.E] for n in self.nurses)
                    total  = actual + pairs
                    # E: 헬프 가능 → [min-1, min]
                    self.model.add(total >= min_cnt - 1)
                    self.model.add(total <= min_cnt)
                elif s == Shift.N:
                    actual = sum(self.sv[n.id][d][Shift.N] for n in self.nurses)
                    total  = actual + pairs
                    # N: 절대 부족 금지, 상한 min+1
                    self.model.add(total >= min_cnt)
                    self.model.add(total <= min_cnt + 1)
                else:
                    continue

    # ── Hard: 월 목표 근무시간 ────────────────────────────────────────────────

    def _c_monthly_work_hours(self):
        """근무시간 상한선만 적용 (하한선 없음 → off_fairness로 균형 유지).
        - 2교대: (평일수 × 8h) 이하 → 12h shift 기준 최대 약 14회
        - 주2일제: 주2일 목표시간 이하
        - 일반/N전담: 상한선 없음 (off_fairness + min_staff 로 자연 조정)"""
        for n in self.nurses:
            if n.is_night_dedicated or (not n.can_two_shift and not n.is_part_time):
                continue
            total_hours = sum(
                SHIFT_HOURS[s] * self.sv[n.id][d][s]
                for d in self.days
                for s in ALL_WORK_WITH_EDU
            )
            if n.can_two_shift:
                # 상한 = 해당 월 평일×8h (일반 목표시간과 동일 = 공휴일·주말 제외)
                self.model.add(total_hours <= self.target_h)
            elif n.is_part_time:
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

    # ── Hard: 최소 오프 보장 ─────────────────────────────────────────────────

    def _c_min_off_guarantee(self):
        """주말 + 법정공휴일 수만큼 오프 최소 보장.
        N전담·2교대·주2일제 제외 (이미 별도 규칙으로 제어)."""
        weekend_holiday_days = sum(
            1 for d in self.days if self._dt(d) != "weekday"
        )
        for n in self.nurses:
            if n.is_night_dedicated or n.can_two_shift or n.is_part_time:
                continue
            off_count = sum(self.sv[n.id][d][Shift.O] for d in self.days)
            self.model.add(off_count >= weekend_holiday_days)

    # ── Hard: 오프 균등 (풀타임만) ────────────────────────────────────────────

    def _c_off_fairness_hard(self):
        """월간 오프 일수 편차 ≤ 1 (주2일제·2교대·N전담 제외).
        N전담(14N+17O) / 2교대(12h×14일) 는 일반 3교대(8h×21일)와 off 일수가 달라 비교 불가."""
        full_time = [n for n in self.nurses
                     if not n.is_part_time and not n.can_two_shift and not n.is_night_dedicated]
        if not full_time:
            return
        off_counts = [
            sum(self.sv[n.id][d][Shift.O] for d in self.days)
            for n in full_time
        ]
        min_off = self.model.new_int_var(0, self.num_days, "min_off_h")
        for oc in off_counts:
            self.model.add(oc >= min_off)
            self.model.add(oc <= min_off + 2)  # ±2일 허용

    # 근무시간 형평성은 soft penalty(⑨)로만 처리 — hard 제약 없음

    # ── Hard: shift 전환 금지 ─────────────────────────────────────────────────

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
        """단독 1일 근무 금지."""
        for n in self.nurses:
            if n.is_night_dedicated:
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
                # 나이트 연속 4개 금지 (N + 6N 합산, 전체 적용)
                window = [d, d+1, d+2, d+3]
                if all(w in self.days for w in window):
                    self.model.add(
                        sum(self.sv[n.id][w][Shift.N] + self.sv[n.id][w][Shift.N6]
                            for w in window) <= 3
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

    # ── Hard: 리더/차지 per shift ─────────────────────────────────────────────

    def _c_leader_per_shift(self):
        """D/E/N 각 shift마다 리더 또는 차지 최소 1명."""
        leaders = [n for n in self.nurses if n.group in (Group.LEADER, Group.CHARGE)]
        for d in self.days:
            pairs = sum(self.sv[n.id][d][Shift.D6] for n in self.nurses)
            for s in WORK_3:
                leader_cnt = sum(self.sv[n.id][d][s] for n in leaders)
                self.model.add(leader_cnt + pairs >= 1)

    def _c_first_year_limit(self):
        first_year = [n for n in self.nurses if n.group == Group.FIRST]
        assert len(first_year) <= self.cfg.max_first_year, (
            f"1년차 수({len(first_year)}) > 허용({self.cfg.max_first_year})"
        )

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

        # ① 희망 근무 보상
        for n in self.nurses:
            for req in n.preferred_requests:
                if req.day not in self.days:
                    continue
                if req.shift in self._shifts_for[n.id]:
                    rewards.append(cfg.w_request_fulfilled * self.sv[n.id][req.day][req.shift])

        # ① -b 2교대 간호사 D/E/N 사용 패널티 (6D/6N 선호, 3교대 혼용 허용)
        for n in self.nurses:
            if not n.can_two_shift:
                continue
            for d in self.days:
                for s in [Shift.D, Shift.E, Shift.N]:
                    penalties.append(cfg.w_two_shift_mix * self.sv[n.id][d][s])

        # ② 나이트 균등 (전담자·주2일제·2교대 제외)
        # 2교대는 6D/6N 우선 → 평균 계산에서 제외
        non_ded = [n for n in self.nurses
                   if not n.is_night_dedicated
                   and not n.is_part_time
                   and not n.can_two_shift]
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

        # ③ Staff-mix 비율 (차지+리더 합산)
        group_ratio = {
            Group.LEADER: 0.20, Group.MID: 0.40,
            Group.JUNIOR: 0.10, Group.FIRST: 0.30,
        }
        total_work_slots = sum(
            self.cfg.min_staff[self._dt(d)][s]
            for d in self.days for s in WORK_3
        )
        for grp, ratio in group_ratio.items():
            if grp == Group.LEADER:
                grp_nurses = [n for n in self.nurses
                              if n.group in (Group.LEADER, Group.CHARGE)]
            else:
                grp_nurses = [n for n in self.nurses if n.group == grp]
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

        # ⑤ N→O→N 패턴 페널티 (나이트 쉬고 바로 나이트)
        for n in self.nurses:
            if n.is_night_dedicated:
                continue
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
            avg_sh = self.model.new_int_var(0, self.num_days, f"avg_{sh.value}")
            self.model.add(sum(sh_counts) == avg_sh * len(regular))
            for i, sc in enumerate(sh_counts):
                diff  = self.model.new_int_var(-self.num_days, self.num_days, f"sdiff_{sh.value}_{i}")
                abs_d = self.model.new_int_var(0, self.num_days, f"sabs_{sh.value}_{i}")
                self.model.add(diff == sc - avg_sh)
                self.model.add_abs_equality(abs_d, diff)
                penalties.append(cfg.w_shift_dist * abs_d)

        # ⑨ 리메인 형평성 (N전담·주2일제 제외, 2교대 포함)
        remain_nurses = [n for n in self.nurses
                         if not n.is_night_dedicated and not n.is_part_time]
        if remain_nurses:
            target_days = self.target_h // 8
            remain_vars = []
            for n in remain_nurses:
                total_h = sum(
                    SHIFT_HOURS[s] * self.sv[n.id][d][s]
                    for d in self.days for s in ALL_WORK_WITH_EDU
                )
                # remain = total_h/8 - target_days  (범위: -31 ~ +31)
                rem = self.model.new_int_var(-self.num_days, self.num_days, f"rem_{n.id}")
                self.model.add(rem * 8 == total_h - target_days * 8)
                remain_vars.append(rem)
            avg_rem = self.model.new_int_var(-self.num_days, self.num_days, "avg_rem")
            self.model.add(sum(remain_vars) == avg_rem * len(remain_nurses))
            for i, rv in enumerate(remain_vars):
                diff  = self.model.new_int_var(-self.num_days * 2, self.num_days * 2, f"rem_d_{i}")
                abs_d = self.model.new_int_var(0, self.num_days * 2, f"rem_a_{i}")
                self.model.add(diff == rv - avg_rem)
                self.model.add_abs_equality(abs_d, diff)
                penalties.append(cfg.w_hours_fairness * abs_d)

        return penalties, rewards

    # ── 메인 ─────────────────────────────────────────────────────────────────

    def _register_hard_constraints(self):
        print("[Scheduler] Hard 제약 등록 중...")
        self._c_exactly_one_shift_per_day()
        self._c_fixed_requests()
        self._c_night_dedicated()
        self._c_charge_constraints()
        self._c_two_shift_pair()
        self._c_monthly_work_hours()
        self._c_min_off_guarantee()
        self._c_forbidden_transitions()
        self._c_night_block_3shift()
        self._c_night_block_2shift()
        self._c_min_consecutive_work()
        self._c_max_consecutive_work()
        self._c_min_staff_per_day()
        self._c_off_fairness_hard()
        self._c_leader_per_shift()
        self._c_first_year_limit()
        self._c_max_night_per_nurse()
        self._c_min_night_per_nurse()
        self._c_min_work_hours_per_nurse()

    def solve(self) -> Optional[dict]:
        print(f"[Scheduler] {self.cfg.year}년 {self.cfg.month}월 "
              f"/ 간호사 {len(self.nurses)}명 / {self.num_days}일")
        print(f"[Scheduler] 월 목표 근무시간: {self.target_h}h "
              f"(주2일제: {self.part_time_target_h}h)")

        self._build_variables()
        self._register_hard_constraints()

        print("[Scheduler] Soft 목적함수 설정 중...")
        penalties, rewards = self._build_objective()
        self.model.minimize(sum(penalties) - sum(rewards))

        # ── Phase 1: 첫 feasible solution 확보 ───────────────────────────────
        print("[Scheduler] [Phase 1] 초기해 탐색 (최대 60초)...")
        p1 = cp_model.CpSolver()
        p1.parameters.max_time_in_seconds = 60
        p1.parameters.num_workers = 8
        p1.parameters.stop_after_first_solution = True
        p1.parameters.log_search_progress = True
        status1 = p1.solve(self.model)

        if status1 == cp_model.INFEASIBLE:
            print("[Scheduler] [FAIL] Phase 1 INFEASIBLE")
            return None

        if status1 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            print(f"[Scheduler] [Phase 1] 초기해 확보 "
                  f"(objective={p1.objective_value:.1f}) → hint 주입")
            for n in self.nurses:
                for d in self.days:
                    for s in ALL_SHIFTS:
                        self.model.add_hint(
                            self.sv[n.id][d][s],
                            p1.value(self.sv[n.id][d][s])
                        )
        else:
            print("[Scheduler] [Phase 1] 초기해 없음 → hint 없이 Phase 2 진행")

        # ── Phase 2: hint 기반 최적화 ─────────────────────────────────────────
        print(f"[Scheduler] [Phase 2] 최적화 (최대 {self.cfg.time_limit_seconds}초)...")
        p2 = cp_model.CpSolver()
        p2.parameters.max_time_in_seconds = self.cfg.time_limit_seconds
        p2.parameters.num_workers = 8
        p2.parameters.log_search_progress = True
        status2 = p2.solve(self.model)

        if status2 == cp_model.INFEASIBLE:
            print("[Scheduler] [FAIL] Phase 2 INFEASIBLE")
            return None

        if status2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            print(f"[Scheduler] [OK] 완료 "
                  f"(status={p2.status_name(status2)}, "
                  f"objective={p2.objective_value:.1f})")
            return self._extract_result(p2)

        # UNKNOWN = 시간초과. 해가 하나라도 있으면 반환.
        try:
            obj = p2.objective_value
            print(f"[Scheduler] [WARN] 시간초과 - 최선의 해 반환 (objective={obj:.1f})")
            return self._extract_result(p2)
        except Exception:
            print(f"[Scheduler] [FAIL] 시간초과 - 해 없음")
            return None

    def _extract_result(self, solver: cp_model.CpSolver) -> dict:
        schedule: dict[str, dict[int, str]] = {}
        for n in self.nurses:
            schedule[n.name] = {}
            for d in self.days:
                for s in ALL_SHIFTS:
                    if solver.value(self.sv[n.id][d][s]):
                        schedule[n.name][d] = s.value
                        break
        return {"schedule": schedule, "stats": self._compute_stats(schedule, solver)}

    def _compute_stats(self, schedule: dict, solver: cp_model.CpSolver) -> dict:
        stats = {}
        for n in self.nurses:
            row = schedule[n.name]
            cnt = {s.value: 0 for s in ALL_SHIFTS}
            total_hours = 0
            for d in self.days:
                sh = row.get(d, "O")
                cnt[sh] += 1
                total_hours += SHIFT_HOURS.get(Shift(sh), 0)

            fulfilled = sum(
                1 for req in n.preferred_requests
                if req.day in self.days
                and solver.value(self.sv[n.id][req.day][req.shift]) == 1
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
                "total_hours": total_hours,
                "target_hours": target,
                "remain": remain,
                "request_rate": f"{fulfilled}/{len(n.preferred_requests)}",
            }
        return stats
