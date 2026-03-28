"""
희망근무 엑셀 파서
==================
지원 포맷:
  A열: 이름
  B열: 그룹 (차지/리더/중간연차/저연차/1년차)
  C열: 나이트전담 (O 또는 빈칸)
  D열: 2교대 (O 또는 빈칸)
  E열: 주2일제 (O 또는 빈칸)
  F열~: 1일, 2일, 3일... (헤더 행에 날짜 숫자)
        셀 값: D / E / N / O / EDU / 교육 / 빈칸(희망없음)
"""

from __future__ import annotations

from typing import Any

import openpyxl


GROUP_MAP = {
    "차지": "charge", "charge": "charge",
    "리더": "leader", "leader": "leader",
    "중간연차": "mid", "중간": "mid", "mid": "mid",
    "저연차": "junior", "junior": "junior",
    "1년차": "first", "신입": "first", "first": "first",
}

PART_TIME_KEYWORDS = {"주2일", "주2일제", "파트", "part", "parttime", "part-time"}

SHIFT_VALUES = {"D", "E", "N", "O", "EDU", "교육"}


def parse_nurse_excel(file_obj) -> list[dict[str, Any]]:
    wb = openpyxl.load_workbook(file_obj, data_only=True)
    ws = wb.active

    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 2:
        raise ValueError("데이터가 부족합니다 (최소 헤더 + 1행 필요)")

    # 헤더 행 찾기: '이름' 또는 'name' 포함하는 행
    header_row_idx = 0
    for i, row in enumerate(rows):
        cells = [str(c).strip().lower() if c else "" for c in row]
        if any(c in ("이름", "name") for c in cells):
            header_row_idx = i
            break

    header = rows[header_row_idx]

    # 날짜 컬럼 인덱스 추출 (헤더에서 숫자만 찾기)
    day_cols: dict[int, int] = {}
    for ci, cell in enumerate(header):
        if cell is None:
            continue
        val = str(cell).strip().replace("일", "").replace("day", "").strip()
        if val.isdigit():
            day_cols[ci] = int(val)

    # 이름/그룹/전담/2교대/주2일제 컬럼 인덱스
    name_col = grp_col = nd_col = ts_col = pt_col = None
    for ci, cell in enumerate(header):
        if cell is None:
            continue
        low = str(cell).strip().lower()
        if low in ("이름", "name") and name_col is None:
            name_col = ci
        elif low in ("그룹", "group") and grp_col is None:
            grp_col = ci
        elif low in ("나이트전담", "night", "전담", "nd") and nd_col is None:
            nd_col = ci
        elif low in ("2교대", "two_shift", "can_two_shift", "2shift", "ts") and ts_col is None:
            ts_col = ci
        elif low in ("주2일제", "주2일", "파트", "parttime", "part_time", "pt") and pt_col is None:
            pt_col = ci

    if name_col is None:
        raise ValueError("'이름' 컬럼을 찾을 수 없습니다")

    nurses = []
    for row in rows[header_row_idx + 1:]:
        name = row[name_col] if name_col < len(row) else None
        if not name or str(name).strip() == "":
            continue

        name = str(name).strip()
        grp_raw = str(row[grp_col]).strip() if grp_col and grp_col < len(row) and row[grp_col] else "mid"
        grp = GROUP_MAP.get(grp_raw.lower(), GROUP_MAP.get(grp_raw, "mid"))

        nd_raw = str(row[nd_col]).strip().upper() if nd_col and nd_col < len(row) and row[nd_col] else ""
        is_nd = nd_raw in ("O", "Y", "YES", "TRUE", "1", "전담")

        ts_raw = str(row[ts_col]).strip().upper() if ts_col and ts_col < len(row) and row[ts_col] else ""
        can_ts = ts_raw in ("O", "Y", "YES", "TRUE", "1", "가능")

        pt_raw = str(row[pt_col]).strip().lower() if pt_col and pt_col < len(row) and row[pt_col] else ""
        is_pt  = pt_raw in ("o", "y", "yes", "true", "1", "주2일", "주2일제", "파트")

        # 희망 근무 파싱 (preferred), EDU는 fixed로 처리
        preferred: list[dict] = []
        fixed_requests: dict[str, str] = {}
        for ci, day in day_cols.items():
            if ci >= len(row):
                continue
            val = row[ci]
            if val is None:
                continue
            shift = str(val).strip().upper()
            if shift == "교육":
                shift = "EDU"
            if shift not in SHIFT_VALUES:
                continue
            if shift == "EDU":
                fixed_requests[str(day)] = "EDU"
            elif shift != "O":
                preferred.append({"day": day, "shift": shift})

        nurses.append({
            "name": name,
            "group": grp,
            "is_night_dedicated": is_nd,
            "can_two_shift": can_ts,
            "is_part_time": is_pt,
            "preferred_requests": preferred,
            "fixed_requests": fixed_requests,
        })

    for i, n in enumerate(nurses):
        n["id"] = i + 1

    return nurses
