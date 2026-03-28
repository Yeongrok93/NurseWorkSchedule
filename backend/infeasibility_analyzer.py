"""
INFEASIBLE 원인 분석기
========================
INFEASIBLE 시 제약 그룹을 하나씩 제거해가며
어떤 제약이 문제인지 찾아낸다.

사용:
    from infeasibility_analyzer import analyze
    result = analyze(nurses, config)
    print(result["summary"])
"""

from __future__ import annotations
import time
from dataclasses import dataclass
from typing import Optional

from ortools.sat.python import cp_model

from scheduler import (
    Nurse, ScheduleConfig, NurseScheduler,
    Shift, Group, ALL_SHIFTS, ALL_WORK, ALL_WORK_WITH_EDU,
    EDU_SHIFTS, WORK_3, WORK_2,
    day_type, days_in_month, SHIFT_HOURS,
    calc_target_hours, calc_part_time_target_hours,
    _get_kr_holidays,
)


# ─── 제약 그룹 정의 ───────────────────────────────────────────────────────────

@dataclass
class ConstraintGroup:
    key: str
    label: str
    description: str


CONSTRAINT_GROUPS = [
    ConstraintGroup("min_staff",       "일별 최소인원",    "평일/토/일 D·E·N 최소 인원 충족"),
    ConstraintGroup("max_staff",       "일별 최대인원",    "최소+1 초과 배정 금지"),
    ConstraintGroup("leader",          "리더/차지 배치",   "각 shift 리더 최소 1명, 차지 중복 금지"),
    ConstraintGroup("transitions",     "금지 전환 패턴",   "N→D, N→E, E→D, 6N→D 등"),
    ConstraintGroup("night_block",     "나이트 블록",      "N 2~3개 연속, 단독 금지, 4개 이상 금지"),
    ConstraintGroup("consecutive",     "연속 근무",        "최대 5일, 최소 2일 연속"),
    ConstraintGroup("work_hours",      "월 목표 근무시간", "전일제/주2일제 목표시간 ±8h"),
    ConstraintGroup("off_fairness",    "오프 편차",        "전일제 간 오프 일수 ±1일"),
    ConstraintGroup("two_shift_pair",  "2교대 쌍",         "6D 수 = 6N 수, 하루 최대 2쌍"),
    ConstraintGroup("fixed_requests",  "고정 리퀘스트",    "EDU·O 등 개인 고정 요청"),
    ConstraintGroup("night_dedicated", "나이트 전담",      "전담자 N=14, D/E 금지"),
]

GROUP_KEYS = [g.key for g in CONSTRAINT_GROUPS]


# ─── 분석용 스케줄러 ──────────────────────────────────────────────────────────

class DiagnosticScheduler(NurseScheduler):
    """제약 그룹을 선택적으로 비활성화할 수 있는 진단용 스케줄러."""

    def __init__(self, nurses: list[Nurse], config: ScheduleConfig, skip_groups: set[str] | None = None):
        super().__init__(nurses, config)
        self.skip = skip_groups or set()

    def _should_skip(self, key: str) -> bool:
        return key in self.skip

    def solve_diagnostic(self, time_limit: int = 30) -> str:
        """
        Returns: 'feasible' | 'infeasible' | 'unknown'
        목적함수 없이 feasibility만 체크.
        """
        self._build_variables()
        self._c_exactly_one_shift_per_day()  # 항상 필요

        if not self._should_skip("fixed_requests"):
            self._c_fixed_requests()
        if not self._should_skip("night_dedicated"):
            self._c_night_dedicated()
        if not self._should_skip("two_shift_pair"):
            self._c_two_shift_pair()
        if not self._should_skip("work_hours"):
            self._c_monthly_work_hours()
        if not self._should_skip("transitions"):
            self._c_forbidden_transitions()
        if not self._should_skip("night_block"):
            self._c_night_block_3shift()
            self._c_night_block_2shift()
        if not self._should_skip("consecutive"):
            self._c_min_consecutive_work()
            self._c_max_consecutive_work()
        if not self._should_skip("off_fairness"):
            self._c_off_fairness_hard()
        if not self._should_skip("leader"):
            self._c_charge_constraints()
            self._c_leader_per_shift()

        # min_staff / max_staff 분리 처리
        skip_min = "min_staff" in self.skip
        skip_max = "max_staff" in self.skip
        if not (skip_min and skip_max):
            self._c_min_max_staff_diagnostic(skip_min=skip_min, skip_max=skip_max)

        try:
            self._c_first_year_limit()
        except AssertionError:
            pass

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = time_limit
        solver.parameters.num_workers = 4
        status = solver.solve(self.model)

        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return "feasible"
        elif status == cp_model.INFEASIBLE:
            return "infeasible"
        return "unknown"

    def _c_min_max_staff_diagnostic(self, skip_min: bool, skip_max: bool):
        """최소/최대 인원 제약을 분리해서 등록."""
        for d in self.days:
            dtype = self._dt(d)
            req   = self.cfg.min_staff[dtype]
            pairs = sum(self.sv[n.id][d][Shift.D6] for n in self.nurses)
            for s, min_cnt in req.items():
                if s == Shift.D:
                    actual = sum(self.sv[n.id][d][Shift.D] for n in self.nurses)
                    total  = actual + pairs
                elif s == Shift.E:
                    actual = sum(self.sv[n.id][d][Shift.E] for n in self.nurses)
                    total  = actual + pairs
                elif s == Shift.N:
                    actual = sum(self.sv[n.id][d][Shift.N] for n in self.nurses)
                    total  = actual + pairs
                else:
                    continue
                if not skip_min:
                    self.model.add(total >= min_cnt)
                if not skip_max:
                    self.model.add(total <= min_cnt + 1)


# ─── 날짜별 수학적 빠른 체크 ──────────────────────────────────────────────────

def _allowed_shifts_for(n: Nurse) -> list[str]:
    if n.group == Group.CHARGE:
        return ["D", "E", "EDU", "O"]
    if n.is_night_dedicated:
        return ["N", "O"]
    if n.can_two_shift:
        return ["6D", "6N", "D", "E", "N", "O"]  # 2교대: 6D/6N 우선, D/E/N 허용
    if n.is_part_time:
        return ["D", "E", "O"]  # 주2일제: 낮/저녁만
    return ["D", "E", "N", "EDU", "O"]


def analyze_daily_staffing(nurses: list[Nurse], config: ScheduleConfig) -> list[dict]:
    """
    솔버 없이 수학적으로 날짜별 인원 부족을 빠르게 감지.
    """
    num_days = days_in_month(config.year, config.month)
    kr       = _get_kr_holidays(config.year)
    issues   = []

    for d in range(1, num_days + 1):
        dt  = day_type(config.year, config.month, d, kr)
        req = config.min_staff[dt]

        fixed_off = [n for n in nurses if n.fixed_requests.get(d) == Shift.O]

        for s in [Shift.D, Shift.E, Shift.N]:
            min_cnt = req.get(s, 0)
            # 이 shift를 배정받을 수 없는 사람 수
            unavail = sum(
                1 for n in nurses
                if s.value not in _allowed_shifts_for(n)
            )
            max_possible = len(nurses) - len(fixed_off) - unavail
            if max_possible < min_cnt:
                issues.append({
                    "day": d,
                    "shift": s.value,
                    "required": min_cnt,
                    "max_possible": max(0, max_possible),
                    "reason": f"{d}일 {s.value}: 최소 {min_cnt}명 필요, 최대 {max(0, max_possible)}명 가능",
                    "severity": "critical",
                })

    return issues


# ─── 메인 분석 함수 ───────────────────────────────────────────────────────────

def analyze(
    nurses: list[Nurse],
    config: ScheduleConfig,
    time_limit_per_check: int = 20,
) -> dict:
    """
    INFEASIBLE 원인을 분석한다.

    Returns:
        {
          "feasible_without": [str],   # 이 제약 제거 시 해결됨
          "always_infeasible": bool,
          "daily_issues": [...],
          "culprits": [...],
          "summary": str,
        }
    """
    start_t = time.time()
    print("[Analyzer] 원인 분석 시작...")

    results: dict = {
        "feasible_without": [],
        "always_infeasible": False,
        "daily_issues": [],
        "culprits": [],
        "summary": "",
    }

    # 0. 날짜별 수학적 체크 (솔버 없이 빠름)
    results["daily_issues"] = analyze_daily_staffing(nurses, config)

    # 1. 모든 제약 제거 시 feasible 여부 기준선
    baseline = DiagnosticScheduler(nurses, config, skip_groups=set(GROUP_KEYS))
    base_status = baseline.solve_diagnostic(time_limit_per_check)
    if base_status == "infeasible":
        results["always_infeasible"] = True
        results["summary"] = (
            "⛔ 모든 제약을 제거해도 INFEASIBLE입니다.\n"
            "간호사 수 자체가 부족하거나 기본 설정 오류일 수 있습니다.\n"
            f"현재 간호사: {len(nurses)}명"
        )
        return results

    # 2. 제약 그룹을 하나씩 제거해서 범인 찾기
    culprits = []
    feasible_without = []

    for group in CONSTRAINT_GROUPS:
        sched = DiagnosticScheduler(nurses, config, skip_groups={group.key})
        status = sched.solve_diagnostic(time_limit_per_check)
        elapsed = time.time() - start_t
        print(f"[Analyzer] '{group.label}' 제거 시 → {status} ({elapsed:.1f}s)")

        if status == "feasible":
            culprits.append(group)
            feasible_without.append(group.key)

    results["feasible_without"] = feasible_without
    results["culprits"] = [
        {"key": g.key, "label": g.label, "description": g.description}
        for g in culprits
    ]

    # 3. 요약 메시지
    lines = ["🔍 INFEASIBLE 원인 분석 결과\n"]

    if culprits:
        lines.append("❌ 다음 제약이 충돌을 일으키고 있습니다:\n")
        for g in culprits:
            lines.append(f"  • [{g.label}] {g.description}")
        lines.append("")
    else:
        lines.append("⚠️ 단일 제약 제거로는 해결되지 않습니다.")
        lines.append("  → 두 개 이상의 제약이 복합적으로 충돌하고 있습니다.\n")

    daily = results["daily_issues"]
    if daily:
        lines.append("📅 날짜별 인원 부족 감지:\n")
        for issue in daily[:10]:
            lines.append(f"  • {issue['reason']}")
        if len(daily) > 10:
            lines.append(f"  ... 외 {len(daily)-10}건")
        lines.append("")

    lines.append("💡 권장 해결 방법:")
    if "min_staff" in feasible_without:
        lines.append("  → 일별 최소 인원 기준을 낮추거나 간호사를 추가하세요")
    if "fixed_requests" in feasible_without:
        lines.append("  → 일부 고정 리퀘스트(EDU/O 등)를 재검토하세요")
    if "work_hours" in feasible_without:
        lines.append("  → 월 목표 근무시간 허용 오차를 늘리세요")
    if "night_block" in feasible_without:
        lines.append("  → 나이트 블록 규칙(2~3개 연속)을 완화하세요")
    if "off_fairness" in feasible_without:
        lines.append("  → 오프 편차 제약을 ±2일로 완화하세요")
    if "consecutive" in feasible_without:
        lines.append("  → 연속 근무 규칙을 완화하거나 인원을 추가하세요")
    if "leader" in feasible_without:
        lines.append("  → 리더/차지 수를 늘리거나 shift별 배치 요건을 확인하세요")
    if "two_shift_pair" in feasible_without:
        lines.append("  → 2교대 가능 인원 수를 확인하세요")
    if not feasible_without:
        lines.append("  → 간호사 수를 늘리거나 전반적인 제약을 재검토하세요")

    elapsed = time.time() - start_t
    lines.append(f"\n⏱ 분석 소요 시간: {elapsed:.1f}초")
    results["summary"] = "\n".join(lines)

    return results
