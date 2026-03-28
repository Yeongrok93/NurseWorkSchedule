"""Excel 결과 내보내기 (run.py의 export_excel을 API용으로 분리)"""

from __future__ import annotations

import calendar as cal_mod
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from scheduler import Nurse, Shift, days_in_month, day_type

CLR = {
    "D": "C6EFCE", "E": "FFEB9C", "N": "E2D9F3", "O": "F2F2F2",
    "D_req": "70AD47", "E_req": "FFC000", "N_req": "9B59B6", "O_req": "BFBFBF",
    "header": "2F4F8F",
    "grp_L": "8497B0", "grp_M": "70AD47", "grp_J": "ED7D31", "grp_F": "9E9E9E",
    "sum_bg": "F5F5F5", "min_ok": "C6EFCE", "min_ng": "FFC7CE",
}
GRP_LABEL = {"leader": "리더", "mid": "중간", "junior": "저연차", "first": "1년차"}
GRP_CLR   = {"leader": "grp_L", "mid": "grp_M", "junior": "grp_J", "first": "grp_F"}
MIN_STAFF = {
    "weekday":  {Shift.D: 7, Shift.E: 6, Shift.N: 6},
    "saturday": {Shift.D: 6, Shift.E: 5, Shift.N: 5},
    "sunday":   {Shift.D: 5, Shift.E: 5, Shift.N: 5},
}

def _fill(h): return PatternFill("solid", fgColor=h)
def _font(bold=False, color="000000", size=10): return Font(bold=bold, color=color, size=size, name="Arial")
def _border(s="thin"): t = Side(style=s); return Border(left=t, right=t, top=t, bottom=t)
def _center(): return Alignment(horizontal="center", vertical="center")
def _left():   return Alignment(horizontal="left",   vertical="center")


def build_excel(result: dict, nurses: list[Nurse], year: int, month: int, output: BytesIO):
    schedule = result["schedule"]
    stats    = result["stats"]
    num_days = days_in_month(year, month)
    days     = range(1, num_days + 1)

    req_map = {
        n.name: {req.day: req.shift.value for req in n.preferred_requests}
        for n in nurses
    }

    wb  = Workbook()
    ws  = wb.active
    ws.title = "듀티표"
    ws.freeze_panes = "D3"

    DOW_KO = ["월","화","수","목","금","토","일"]

    # 타이틀
    ws.merge_cells(f"A1:{get_column_letter(3+num_days+6)}1")
    tc = ws["A1"]
    tc.value     = f"  {year}년 {month}월 간호사 근무표   ★=나이트전담  ^=희망반영"
    tc.font      = _font(bold=True, color="FFFFFF", size=12)
    tc.fill      = _fill(CLR["header"])
    tc.alignment = _left()
    ws.row_dimensions[1].height = 22

    # 헤더
    for ci, lbl in enumerate(["그룹","이름","전담"], 1):
        c = ws.cell(2, ci, lbl)
        c.font = _font(bold=True, color="FFFFFF"); c.fill = _fill(CLR["header"]); c.alignment = _center()

    for d in days:
        wd = cal_mod.weekday(year, month, d)
        wk = wd in (5, 6)
        c  = ws.cell(2, 3+d, f"{d}\n{DOW_KO[wd]}")
        c.font      = _font(bold=True, color="FFD700" if wk else "FFFFFF")
        c.fill      = _fill("1F4E79" if wk else CLR["header"])
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[2].height = 28

    for lbl, off in [("D수",1),("E수",2),("N수",3),("O수",4),("근무",5),("요청",6)]:
        c = ws.cell(2, 3+num_days+off, lbl)
        c.font = _font(bold=True, color="FFFFFF"); c.fill = _fill(CLR["header"]); c.alignment = _center()

    ws.column_dimensions["A"].width = 6
    ws.column_dimensions["B"].width = 9
    ws.column_dimensions["C"].width = 5
    for d in days:
        ws.column_dimensions[get_column_letter(3+d)].width = 3.5
    for i in range(1, 7):
        ws.column_dimensions[get_column_letter(3+num_days+i)].width = 5

    # 데이터
    for ri, n in enumerate(nurses):
        row = 3 + ri
        day_map  = schedule.get(n.name, {})
        grp_hex  = CLR[GRP_CLR[n.group.value]]

        for ci, (val, al) in enumerate([
            (GRP_LABEL[n.group.value], _center()),
            (("★ " if n.is_night_dedicated else "") + n.name, _left()),
            ("N전담" if n.is_night_dedicated else "", _center()),
        ], 1):
            c = ws.cell(row, ci, val)
            c.fill = _fill(grp_hex); c.font = _font(bold=(ci<=2), size=9 if ci==3 else 10)
            c.alignment = al; c.border = _border()

        cnt = {"D":0,"E":0,"N":0,"O":0}
        for d in days:
            sh     = day_map.get(str(d), "O")
            cnt[sh] += 1
            is_req = req_map.get(n.name, {}).get(d) == sh
            text   = ("" if sh=="O" else sh) + ("^" if is_req else "")
            clr_k  = f"{sh}_req" if is_req else sh
            c = ws.cell(row, 3+d, text)
            c.fill = _fill(CLR[clr_k])
            c.font = _font(bold=is_req, size=9, color={
                "D":"155724","E":"7B4400","N":"4C1D95","O":"555555"}[sh])
            c.alignment = _center(); c.border = _border("hair")

        fulfilled = sum(1 for d,s in req_map.get(n.name,{}).items() if day_map.get(str(d))==s)
        total_req = len(n.preferred_requests)
        for val, off, col in [
            (cnt["D"],1,"155724"),(cnt["E"],2,"7B4400"),(cnt["N"],3,"4C1D95"),
            (cnt["O"],4,"555555"),(cnt["D"]+cnt["E"]+cnt["N"],5,"000000"),
            (f"{fulfilled}/{total_req}",6,"000000"),
        ]:
            c = ws.cell(row, 3+num_days+off, val)
            c.font=_font(bold=(off==5),size=9,color=col); c.fill=_fill(CLR["sum_bg"])
            c.alignment=_center(); c.border=_border()
        ws.row_dimensions[row].height = 16

    # 일별 집계
    for sh, off in [("D",0),("E",1),("N",2)]:
        r = 3 + len(nurses) + off
        c = ws.cell(r, 1, f"{sh} 계")
        c.font=_font(bold=True,size=9); c.fill=_fill("EEEEEE"); c.alignment=_center()
        ws.merge_cells(f"A{r}:C{r}")
        for d in days:
            cnt_d = sum(1 for n in nurses if schedule.get(n.name,{}).get(str(d))==sh)
            dt    = day_type(year, month, d)
            mn    = MIN_STAFF[dt][Shift(sh)]
            ok    = cnt_d >= mn
            c = ws.cell(r, 3+d, cnt_d)
            c.fill=_fill(CLR["min_ok"] if ok else CLR["min_ng"])
            c.font=_font(bold=not ok,size=9,color={"D":"155724","E":"7B4400","N":"4C1D95"}[sh] if ok else "9C0006")
            c.alignment=_center(); c.border=_border("hair")
        ws.row_dimensions[r].height = 14

    # 통계 시트
    ws2 = wb.create_sheet("통계요약")
    for ci, h in enumerate(["그룹","이름","D","E","N","O","총근무","요청"], 1):
        c = ws2.cell(1,ci,h); c.font=_font(bold=True,color="FFFFFF"); c.fill=_fill(CLR["header"]); c.alignment=_center()
        ws2.column_dimensions[get_column_letter(ci)].width = 9
    for ri, n in enumerate(nurses, 2):
        s   = stats.get(n.name, {}); cnt = s.get("counts", {})
        grp_hex = CLR[GRP_CLR[n.group.value]]
        for ci, val in enumerate([
            GRP_LABEL[n.group.value],
            ("★ " if n.is_night_dedicated else "") + n.name,
            cnt.get("D",0), cnt.get("E",0), cnt.get("N",0), cnt.get("O",0),
            s.get("total_work",0), s.get("request_rate",""),
        ], 1):
            c = ws2.cell(ri,ci,val)
            c.fill=_fill(grp_hex if ci<=2 else "FAFAFA")
            c.font=_font(bold=(ci<=2),size=10); c.alignment=_center() if ci!=2 else _left(); c.border=_border()

    wb.save(output)
