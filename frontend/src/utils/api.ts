import type {
  ConstraintConfig, Nurse, ScheduleResult, Holiday,
  NoteInterpretResult, NoteInterpretation, PrevMonthResult,
} from '../types'

// 개발: VITE_API_URL(.env.local) 사용 / 배포·exe 빌드: 같은 서버에서 서빙되므로 상대 경로
const BASE = import.meta.env.DEV
  ? (import.meta.env.VITE_API_URL ?? 'http://localhost:8002')
  : ''
const WS_BASE = BASE
  ? BASE.replace(/^http/, 'ws')
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

export async function parseExcel(file: File): Promise<{ nurses: Nurse[]; count: number }> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${BASE}/parse-excel`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error((await res.json()).detail)
  return res.json()
}

export async function startSchedule(nurses: Nurse[], config: ConstraintConfig): Promise<string> {
  const res = await fetch(`${BASE}/schedule/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nurses, config }),
  })
  if (!res.ok) throw new Error((await res.json()).detail)
  const { job_id } = await res.json()
  return job_id
}

export function connectJobWS(
  jobId: string,
  onStatus: (s: string) => void,
  onResult: (r: ScheduleResult) => void,
  onError: (msg: string) => void,
): WebSocket {
  const ws = new WebSocket(`${WS_BASE}/ws/${jobId}`)
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'status') onStatus(msg.status)
    if (msg.type === 'result') onResult(msg.data)
    if (msg.type === 'error') onError(msg.message)
  }
  ws.onerror = () => onError('WebSocket 연결 오류')
  return ws
}

export async function downloadExcel(
  jobId: string,
  nurses: Nurse[],
  config: ConstraintConfig,
): Promise<void> {
  const res = await fetch(`${BASE}/schedule/${jobId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nurses, config }),
  })
  if (!res.ok) throw new Error('다운로드 실패')
  const blob = await res.blob()
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = `schedule_${config.year}${String(config.month).padStart(2,'0')}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}

export async function analyzeInfeasibility(
  nurses: Nurse[],
  config: ConstraintConfig,
): Promise<{
  culprits: { key: string; label: string; description: string }[]
  daily_issues: { day: number; shift: string; reason: string }[]
  summary: string
  always_infeasible: boolean
  feasible_without: string[]
}> {
  const res = await fetch(`${BASE}/schedule/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nurses, config }),
  })
  if (!res.ok) throw new Error('분석 실패')
  return res.json()
}

export async function interpretNotes(
  nurses: Nurse[],
  year: number,
  month: number,
  apiKey?: string,
): Promise<NoteInterpretResult> {
  const res = await fetch(`${BASE}/notes/interpret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nurses, year, month, api_key: apiKey || null }),
  })
  if (!res.ok) throw new Error('특기사항 해석 실패')
  return res.json()
}

export async function applyNotes(
  nurses: Nurse[],
  items: NoteInterpretation[],
): Promise<Nurse[]> {
  const res = await fetch(`${BASE}/notes/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nurses, items }),
  })
  if (!res.ok) throw new Error('적용 실패')
  return (await res.json()).nurses
}

/** 규칙 기반 파서가 실패했을 때 AI(OpenAI)로 재시도. 서버에 키가 없으면 400. */
export async function parseExcelAI(file: File): Promise<{ nurses: Nurse[]; count: number }> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${BASE}/parse-excel-ai`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error((await res.json()).detail ?? 'AI 파싱 실패')
  return res.json()
}

export async function parsePrevMonth(file: File, carryDays = 7): Promise<PrevMonthResult> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${BASE}/parse-prev-month?carry_days=${carryDays}`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error((await res.json()).detail ?? '파싱 실패')
  return res.json()
}

/** 규칙 기반이 실패했을 때 AI(OpenAI)로 재시도 — 병동 자체 양식의 전월 실제 근무표 지원 */
export async function parsePrevMonthAI(file: File, carryDays = 7): Promise<PrevMonthResult> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${BASE}/parse-prev-month-ai?carry_days=${carryDays}`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error((await res.json()).detail ?? 'AI 파싱 실패')
  return res.json()
}

export async function getHolidays(year: number, month: number): Promise<Holiday[]> {
  const res = await fetch(`${BASE}/holidays?year=${year}&month=${month}`)
  return res.json()
}
