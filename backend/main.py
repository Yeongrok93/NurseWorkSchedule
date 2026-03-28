"""
간호사 듀티표 생성기 — FastAPI 백엔드
======================================
WebSocket으로 솔버 진행상황 실시간 스트리밍
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any

import holidays
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from excel_parser import parse_nurse_excel
from excel_export import build_excel
from infeasibility_analyzer import analyze as analyze_infeasibility
from scheduler import (
    Group, Nurse, NurseScheduler, ScheduleConfig, Shift, ShiftRequest,
    days_in_month,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ─── App ──────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("서버 시작")
    yield
    logger.info("서버 종료")

app = FastAPI(title="간호사 듀티표 API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_jobs: dict[str, Any] = {}


# ─── 스키마 ───────────────────────────────────────────────────────────────────

class NurseIn(BaseModel):
    id: int
    name: str
    group: str              # charge / leader / mid / junior / first
    is_night_dedicated: bool = False
    can_two_shift: bool = False
    is_part_time: bool = False
    fixed_requests: dict[str, str] = {}      # {"1": "EDU", ...}
    preferred_requests: list[dict] = []      # [{"day":3,"shift":"D"}, ...]

class ConstraintConfig(BaseModel):
    year: int
    month: int
    min_staff_weekday:  dict[str, int] = {"D": 7, "E": 6, "N": 6}
    min_staff_saturday: dict[str, int] = {"D": 6, "E": 5, "N": 5}
    min_staff_sunday:   dict[str, int] = {"D": 5, "E": 5, "N": 5}
    max_consecutive_work: int = 5
    night_dedicated_count: int = 14
    max_first_year: int = 15
    min_night_block: int = 2
    max_night_block: int = 3
    max_two_shift_pairs_per_day: int = 2
    max_d6_block: int = 2
    max_n6_block: int = 2
    night_min_gap: int = 10
    night_max_count: int = 7
    time_limit_seconds: int = 90

class ScheduleRequest(BaseModel):
    nurses: list[NurseIn]
    config: ConstraintConfig


# ─── 유틸 ────────────────────────────────────────────────────────────────────

def _to_nurse(ni: NurseIn) -> Nurse:
    grp = Group(ni.group)
    fixed = {int(d): Shift(s) for d, s in ni.fixed_requests.items()}
    prefs = [ShiftRequest(day=r["day"], shift=Shift(r["shift"]))
             for r in ni.preferred_requests]
    return Nurse(
        id=ni.id, name=ni.name, group=grp,
        is_night_dedicated=ni.is_night_dedicated,
        can_two_shift=ni.can_two_shift,
        is_part_time=ni.is_part_time,
        fixed_requests=fixed,
        preferred_requests=prefs,
    )

def _make_config(cfg: ConstraintConfig) -> ScheduleConfig:
    # v3: holidays 처리는 scheduler 내부에서 자동으로 수행
    return ScheduleConfig(
        year=cfg.year,
        month=cfg.month,
        min_staff={
            "weekday":  {Shift(k): v for k, v in cfg.min_staff_weekday.items()},
            "saturday": {Shift(k): v for k, v in cfg.min_staff_saturday.items()},
            "sunday":   {Shift(k): v for k, v in cfg.min_staff_sunday.items()},
        },
        max_consecutive_work=cfg.max_consecutive_work,
        night_dedicated_count=cfg.night_dedicated_count,
        max_first_year=cfg.max_first_year,
        min_night_block=cfg.min_night_block,
        max_night_block=cfg.max_night_block,
        max_two_shift_pairs_per_day=cfg.max_two_shift_pairs_per_day,
        max_d6_block=cfg.max_d6_block,
        max_n6_block=cfg.max_n6_block,
        night_min_gap=cfg.night_min_gap,
        night_max_count=cfg.night_max_count,
        time_limit_seconds=cfg.time_limit_seconds,
    )


# ─── REST 엔드포인트 ──────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/holidays")
def get_holidays(year: int, month: int):
    """해당 월 한국 공휴일 반환."""
    kr = holidays.KR(years=year)
    result = []
    import datetime
    for day in range(1, days_in_month(year, month) + 1):
        date = datetime.date(year, month, day)
        if date in kr:
            result.append({"day": day, "name": kr[date]})
    return result


@app.post("/parse-excel")
async def parse_excel(file: UploadFile = File(...)):
    """희망근무 엑셀 파싱 → 간호사 목록 반환."""
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(400, "xlsx 또는 xls 파일만 허용됩니다")
    content = await file.read()
    try:
        nurses = parse_nurse_excel(io.BytesIO(content))
        return {"nurses": nurses, "count": len(nurses)}
    except Exception as e:
        raise HTTPException(422, f"파싱 오류: {e}")


@app.post("/schedule/start")
async def start_schedule(req: ScheduleRequest):
    """스케줄 생성 작업 시작 → job_id 반환. WebSocket으로 진행상황 수신."""
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "pending", "result": None, "error": None}

    async def run():
        try:
            _jobs[job_id]["status"] = "running"
            nurses = [_to_nurse(n) for n in req.nurses]
            cfg    = _make_config(req.config)

            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                lambda: NurseScheduler(nurses, cfg).solve()
            )
            if result is None:
                _jobs[job_id]["status"] = "infeasible"
            else:
                result["schedule"] = {
                    name: {str(d): sh for d, sh in dm.items()}
                    for name, dm in result["schedule"].items()
                }
                _jobs[job_id]["status"] = "done"
                _jobs[job_id]["result"] = result
        except Exception as e:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"] = str(e)

    asyncio.create_task(run())
    return {"job_id": job_id}


@app.post("/schedule/analyze")
async def analyze_schedule(req: ScheduleRequest):
    """
    INFEASIBLE 원인 분석.
    제약 그룹을 하나씩 제거하며 어떤 제약이 충돌을 일으키는지 찾아준다.
    """
    nurses = [_to_nurse(n) for n in req.nurses]
    cfg    = _make_config(req.config)

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        lambda: analyze_infeasibility(nurses, cfg, time_limit_per_check=20),
    )
    return result


@app.get("/schedule/{job_id}")
def get_schedule(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job


@app.post("/schedule/{job_id}/export")
async def export_schedule(job_id: str, req: ScheduleRequest):
    job = _jobs.get(job_id)
    if not job or job["status"] != "done":
        raise HTTPException(400, "완료된 스케줄이 없습니다")

    nurses = [_to_nurse(n) for n in req.nurses]
    buf = io.BytesIO()
    build_excel(
        result=job["result"],
        nurses=nurses,
        year=req.config.year,
        month=req.config.month,
        output=buf,
    )
    buf.seek(0)
    filename = f"schedule_{req.config.year}{req.config.month:02d}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ─── WebSocket (솔버 진행상황 실시간 스트리밍) ───────────────────────────────

@app.websocket("/ws/{job_id}")
async def ws_progress(websocket: WebSocket, job_id: str):
    await websocket.accept()
    try:
        while True:
            job = _jobs.get(job_id)
            if not job:
                await websocket.send_json({"type": "error", "message": "job not found"})
                break

            status = job["status"]
            await websocket.send_json({"type": "status", "status": status})

            if status in ("done", "infeasible", "error"):
                if status == "done":
                    await websocket.send_json({"type": "result", "data": job["result"]})
                elif status == "error":
                    await websocket.send_json({"type": "error", "message": job.get("error", "unknown error")})
                break

            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass
