"""
특기사항(자연어) → 구조화 제약 번역기
=======================================
수간호사가 자유 텍스트로 적은 특기사항을 솔버가 쓸 수 있는 형태로 바꾼다.

  "1순위 25-26, 2순위 7-10, 3순위 15-17입니다"
      → 25·26일 희망은 1순위, 7~10일은 2순위, 15~17일은 3순위
  "수,목 주차요일제입니다"
      → 매주 수/목 고정 오프

설계 원칙
  1. LLM은 '번역기'일 뿐 제약을 바꾸지 않는다.
     최소인원·연속근무 상한 같은 솔버 파라미터는 절대 건드릴 수 없다.
  2. 출력은 화이트리스트된 스키마로 강제한다.
  3. 사람이 확인·수정한 뒤에 반영한다 (UI 단계).
  4. LLM 없이도 동작해야 한다 — 규칙 기반이 기본, LLM은 선택적 보강.
"""

from __future__ import annotations

import re
from typing import Any

# 요일 문자 → Python calendar.weekday (월=0 … 일=6)
_WEEKDAY_IDX = {"월": 0, "화": 1, "수": 2, "목": 3, "금": 4, "토": 5, "일": 6}

# "1순위", "2 순위", "1순의"(오타) 등
_RANK_RE = re.compile(r"([123])\s*순\s*[위의]")
# "25-26", "7~10", "15 - 17"
_RANGE_RE = re.compile(r"(\d{1,2})\s*[-~–—]\s*(\d{1,2})")
# 단일 일자 "8일", "5일"
_SINGLE_DAY_RE = re.compile(r"(\d{1,2})\s*일")
# "수,목 주차요일제" / "화/수 주차요일제"
_WEEKLY_OFF_RE = re.compile(r"([월화수목금토일](?:\s*[,/·와과및]\s*[월화수목금토일])*)\s*[^.]{0,4}주\s*차?\s*요일제")


# ═════════════════════════════════════════════════════════════════════════════
# 규칙 기반 (기본 경로 — 항상 동작)
# ═════════════════════════════════════════════════════════════════════════════

def _extract_days(segment: str, month: int, num_days: int) -> list[int]:
    """텍스트 조각에서 일자 목록 추출. '8/15~17' 처럼 월 접두가 붙은 경우 제거."""
    seg = re.sub(rf"\b{month}\s*/\s*", " ", segment)      # "8/15" → " 15"
    seg = re.sub(r"\b\d{1,2}\s*월\s*", " ", seg)          # "8월 " 제거

    days: set[int] = set()
    consumed_spans: list[tuple[int, int]] = []

    for m in _RANGE_RE.finditer(seg):
        a, b = int(m.group(1)), int(m.group(2))
        if 1 <= a <= num_days and 1 <= b <= num_days and a <= b and b - a <= 15:
            days.update(range(a, b + 1))
            consumed_spans.append(m.span())

    def _consumed(pos: int) -> bool:
        return any(s <= pos < e for s, e in consumed_spans)

    for m in _SINGLE_DAY_RE.finditer(seg):
        if _consumed(m.start()):
            continue
        d = int(m.group(1))
        if 1 <= d <= num_days:
            days.add(d)

    # "1순위 5-8" 처럼 '일' 없이 끝나는 단독 숫자도 허용 (범위가 하나도 없을 때만)
    if not days:
        for m in re.finditer(r"\b(\d{1,2})\b", seg):
            d = int(m.group(1))
            if 1 <= d <= num_days:
                days.add(d)

    return sorted(days)


def parse_note_rule_based(note: str, month: int, num_days: int) -> dict[str, Any]:
    """특기사항 한 줄 → {priority_requests, weekly_fixed_off, leftover}"""
    out: dict[str, Any] = {
        "priority_requests": [],   # [{"rank": 1, "days": [25, 26]}, ...]
        "weekly_fixed_off": [],    # ["수", "목"]
        "leftover": "",            # 해석 못한 나머지 (사람이 확인)
    }
    if not note or not note.strip():
        return out

    text = note.strip()

    # ── 주차요일제 ──
    m = _WEEKLY_OFF_RE.search(text)
    if m:
        chars = re.findall(r"[월화수목금토일]", m.group(1))
        out["weekly_fixed_off"] = sorted(set(chars), key=lambda c: _WEEKDAY_IDX[c])
        text = text[: m.start()] + " " + text[m.end():]

    # ── 순위별 일자 ──
    marks = list(_RANK_RE.finditer(text))
    if marks:
        # 표기 방향 판별: 첫 순위 표시 앞에 날짜가 있으면 "8/9 1순위" 형태(후치)
        postfix = bool(_extract_days(text[: marks[0].start()], month, num_days))
        for i, mk in enumerate(marks):
            rank = int(mk.group(1))
            if postfix:
                start = marks[i - 1].end() if i > 0 else 0
                end = mk.start()
            else:
                start = mk.end()
                end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            days = _extract_days(text[start:end], month, num_days)
            if days:
                out["priority_requests"].append({"rank": rank, "days": days})

    # ── 남은 자연어 (사람 확인용) ──
    if not marks and not out["weekly_fixed_off"]:
        out["leftover"] = text.strip()
    else:
        tail = _RANK_RE.sub(" ", text)
        tail = re.sub(r"[\d\s\-~–—/():,.·일월off개OFF]+", " ", tail).strip()
        if len(tail) > 4:
            out["leftover"] = tail

    return out


# ═════════════════════════════════════════════════════════════════════════════
# LLM 보강 (선택 — API 키가 있을 때만)
# ═════════════════════════════════════════════════════════════════════════════

_LLM_SYSTEM = """너는 간호사 듀티표 프로그램의 '특기사항 번역기'다.

수간호사가 자유롭게 적은 한국어 메모를 읽고, 정해진 구조로만 옮겨 적는다.
너는 근무 규칙을 바꾸거나 판단하지 않는다. 오직 적힌 내용을 옮기기만 한다.

추출 대상은 세 가지뿐이다:
1. 희망근무 우선순위 — "1순위 25-26, 2순위 7-10" 같은 표현.
   해당 날짜들을 rank(1/2/3)와 함께 옮긴다.
2. 주차요일제 — "수,목 주차요일제" = 매주 수요일·목요일 고정 오프.
   요일 문자만 옮긴다.
3. 그 외 사람이 확인해야 할 사항 — 교육 일정, 연차 사용 희망 등은
   review_notes에 원문 그대로 짧게 남긴다.

규칙:
- 날짜는 해당 월의 일(day) 숫자만 쓴다. "8/15~17"은 [15,16,17]이다.
- 범위 표기(-, ~)는 양끝을 포함해 펼친다.
- 오타가 있어도 문맥으로 판단한다. 예: "1순의"는 1순위, "29.~0일"은 29~30일일 가능성이 높다.
  확신이 없으면 그 항목은 비우고 review_notes에 원문을 남긴다.
- 메모에 없는 내용은 절대 만들어내지 않는다.
- 최소인원, 연속근무일수 같은 근무 규칙은 네 소관이 아니다. 언급돼 있어도 review_notes로만 남긴다."""


def parse_notes_llm(
    notes: list[dict[str, Any]],
    month: int,
    num_days: int,
    api_key: str,
    model: str = "claude-opus-4-8",
) -> dict[int, dict[str, Any]]:
    """
    특기사항 여러 건을 한 번의 요청으로 해석한다.
    notes: [{"index": 0, "name": "N19_3", "note": "1순위: 1~8일(장기오프)"}, ...]
    반환: {index: {"priority_requests": [...], "weekly_fixed_off": [...], "leftover": "..."}}
    실패 시 예외를 던진다 (호출부에서 규칙 기반으로 폴백).
    """
    import anthropic
    from pydantic import BaseModel, Field

    class PriorityRequest(BaseModel):
        rank: int = Field(description="희망 순위 1/2/3")
        days: list[int] = Field(description="해당 순위의 날짜(일) 목록")

    class NoteResult(BaseModel):
        index: int = Field(description="입력으로 준 간호사 index")
        priority_requests: list[PriorityRequest]
        weekly_fixed_off: list[str] = Field(
            description="주차요일제 요일 문자 목록 (월화수목금토일 중). 없으면 빈 배열")
        review_notes: list[str] = Field(
            description="사람이 확인해야 할 기타 사항. 없으면 빈 배열")

    class Extraction(BaseModel):
        results: list[NoteResult]

    payload = "\n".join(
        f'{n["index"]}. [{n.get("name", "")}] {n["note"]}' for n in notes
    )

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.parse(
        model=model,
        max_tokens=16000,
        system=_LLM_SYSTEM,
        thinking={"type": "adaptive"},
        output_config={"effort": "medium"},
        messages=[{
            "role": "user",
            "content": (
                f"{month}월 근무표({num_days}일)의 간호사별 특기사항이다. "
                f"각 줄은 'index. [이름] 메모' 형식이다.\n\n{payload}\n\n"
                f"각 index에 대해 구조화해서 돌려줘. 메모가 비어 있으면 빈 값으로 둔다."
            ),
        }],
        output_format=Extraction,
    )

    parsed = response.parsed_output
    out: dict[int, dict[str, Any]] = {}
    for r in parsed.results:
        days_ok = lambda ds: sorted({d for d in ds if 1 <= d <= num_days})
        out[r.index] = {
            "priority_requests": [
                {"rank": p.rank, "days": days_ok(p.days)}
                for p in r.priority_requests
                if p.rank in (1, 2, 3) and days_ok(p.days)
            ],
            "weekly_fixed_off": [w for w in r.weekly_fixed_off if w in _WEEKDAY_IDX],
            "leftover": " / ".join(r.review_notes),
        }
    return out


# ═════════════════════════════════════════════════════════════════════════════
# 공개 API
# ═════════════════════════════════════════════════════════════════════════════

def interpret_notes(
    nurses: list[dict[str, Any]],
    month: int,
    num_days: int,
    api_key: str | None = None,
) -> dict[str, Any]:
    """
    간호사 목록의 note를 해석해 '적용 후보'를 만든다. 적용은 하지 않는다.
    반환: {"items": [...], "engine": "llm"|"rule", "warning": str|None}
    """
    targets = [
        {"index": i, "name": n.get("name", ""), "note": (n.get("note") or "").strip()}
        for i, n in enumerate(nurses)
        if (n.get("note") or "").strip()
    ]
    if not targets:
        return {"items": [], "engine": "none", "warning": None}

    engine = "rule"
    warning = None
    results: dict[int, dict[str, Any]] = {}

    if api_key:
        try:
            results = parse_notes_llm(targets, month, num_days, api_key)
            engine = "llm"
        except Exception as e:                        # 키 오류·네트워크·스키마 실패
            warning = f"LLM 해석 실패 ({type(e).__name__}) — 규칙 기반으로 처리했습니다"
            results = {}

    for t in targets:
        if t["index"] not in results:
            results[t["index"]] = parse_note_rule_based(t["note"], month, num_days)

    items = []
    for t in targets:
        r = results[t["index"]]
        items.append({
            "index": t["index"],
            "name": t["name"],
            "note": t["note"],
            "priority_requests": r.get("priority_requests", []),
            "weekly_fixed_off": r.get("weekly_fixed_off", []),
            "leftover": r.get("leftover", ""),
        })
    return {"items": items, "engine": engine, "warning": warning}


def apply_interpretation(
    nurses: list[dict[str, Any]],
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    확인된 해석 결과를 간호사 목록에 반영한다.
      - priority_requests → 해당 날짜의 기존 희망근무에 rank 부여 (새로 만들지 않음)
      - weekly_fixed_off  → weekly_fixed_off (요일 인덱스)
    """
    by_index = {it["index"]: it for it in items}
    for i, n in enumerate(nurses):
        it = by_index.get(i)
        if not it:
            continue

        rank_of_day: dict[int, int] = {}
        for pr in it.get("priority_requests", []):
            rank = int(pr.get("rank", 0) or 0)
            for d in pr.get("days", []):
                # 더 높은(숫자가 작은) 순위가 이기도록
                if d not in rank_of_day or rank < rank_of_day[d]:
                    rank_of_day[d] = rank

        for req in n.get("preferred_requests", []):
            r = rank_of_day.get(int(req["day"]))
            if r:
                req["rank"] = r

        wd = [_WEEKDAY_IDX[c] for c in it.get("weekly_fixed_off", []) if c in _WEEKDAY_IDX]
        if wd:
            n["weekly_fixed_off"] = sorted(set(wd))

    return nurses
