"""
FastAPI REST 서버
=================
설치:
    pip install ortools fastapi uvicorn

실행:
    uvicorn api:app --reload --port 8000

엔드포인트:
    POST /schedule   → 듀티표 생성
    GET  /health     → 서버 상태
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from scheduler import (
    Nurse, Group, Shift, ScheduleConfig, NurseScheduler,
    days_in_month,
)

app = FastAPI(title="간호사 듀티표 API", version="1.0.0")


# ─── Request/Response 스키마 ──────────────────────────────────────────────────

class NurseInput(BaseModel):
    id: int
    name: str
    group: str   # "leader" | "mid" | "junior" | "first"
    is_night_dedicated: bool = False
    # {day(str): shift(str)} — JSON은 키를 str로만 허용
    fixed_requests: dict[str, str] = Field(default_factory=dict)


class ScheduleRequest(BaseModel):
    year: int
    month: int
    nurses: list[NurseInput]
    # 최소 인원 오버라이드 (선택)
    min_staff_weekday:  Optional[dict[str, int]] = None  # {"D":7,"E":6,"N":6}
    min_staff_saturday: Optional[dict[str, int]] = None
    min_staff_sunday:   Optional[dict[str, int]] = None
    # 제약 파라미터
    max_consecutive_work: int = 5
    night_dedicated_count: int = 14
    max_first_year: int = 8
    time_limit_seconds: int = 60
    # 가중치
    w_off_fairness: int = 10
    w_night_fairness: int = 8
    w_weekend_fairness: int = 6
    w_staffmix: int = 4


class ScheduleResponse(BaseModel):
    status: str          # "optimal" | "feasible" | "infeasible"
    year: int
    month: int
    num_days: int
    # schedule[nurse_name][day_str] = "D"|"E"|"N"|"O"
    schedule: dict[str, dict[str, str]]
    stats: dict


# ─── 엔드포인트 ───────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/schedule", response_model=ScheduleResponse)
def create_schedule(req: ScheduleRequest):
    # ── 간호사 변환
    nurses = []
    for ni in req.nurses:
        try:
            grp = Group(ni.group)
        except ValueError:
            raise HTTPException(400, f"알 수 없는 그룹: {ni.group}")

        fixed: dict[int, Shift] = {}
        for day_str, sh_str in ni.fixed_requests.items():
            try:
                fixed[int(day_str)] = Shift(sh_str)
            except (ValueError, KeyError):
                raise HTTPException(400, f"잘못된 고정 요청: day={day_str} shift={sh_str}")

        nurses.append(Nurse(
            id=ni.id,
            name=ni.name,
            group=grp,
            is_night_dedicated=ni.is_night_dedicated,
            fixed_requests=fixed,
        ))

    # ── 설정 구성
    def parse_shift_dict(raw: Optional[dict[str, int]]) -> Optional[dict[Shift, int]]:
        if raw is None:
            return None
        return {Shift(k): v for k, v in raw.items()}

    default_min = {
        "weekday":  {Shift.D: 7, Shift.E: 6, Shift.N: 6},
        "saturday": {Shift.D: 6, Shift.E: 5, Shift.N: 5},
        "sunday":   {Shift.D: 5, Shift.E: 5, Shift.N: 5},
    }
    if req.min_staff_weekday:
        default_min["weekday"]  = parse_shift_dict(req.min_staff_weekday)
    if req.min_staff_saturday:
        default_min["saturday"] = parse_shift_dict(req.min_staff_saturday)
    if req.min_staff_sunday:
        default_min["sunday"]   = parse_shift_dict(req.min_staff_sunday)

    cfg = ScheduleConfig(
        year=req.year,
        month=req.month,
        min_staff=default_min,
        max_consecutive_work=req.max_consecutive_work,
        night_dedicated_count=req.night_dedicated_count,
        max_first_year=req.max_first_year,
        time_limit_seconds=req.time_limit_seconds,
        w_off_fairness=req.w_off_fairness,
        w_night_fairness=req.w_night_fairness,
        w_weekend_fairness=req.w_weekend_fairness,
        w_staffmix=req.w_staffmix,
    )

    # ── 솔버 실행
    scheduler = NurseScheduler(nurses, cfg)
    result = scheduler.solve()

    num_days = days_in_month(req.year, req.month)

    if result is None:
        return ScheduleResponse(
            status="infeasible",
            year=req.year,
            month=req.month,
            num_days=num_days,
            schedule={},
            stats={},
        )

    # int 키 → str 키 변환 (JSON 호환)
    str_schedule = {
        name: {str(d): sh for d, sh in day_map.items()}
        for name, day_map in result["schedule"].items()
    }

    return ScheduleResponse(
        status="feasible",
        year=req.year,
        month=req.month,
        num_days=num_days,
        schedule=str_schedule,
        stats=result["stats"],
    )
