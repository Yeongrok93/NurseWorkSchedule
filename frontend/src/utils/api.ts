import type { ConstraintConfig, Nurse, ScheduleResult, Holiday } from '../types'

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
const WS_BASE = BASE.replace(/^http/, 'ws')

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

export async function getHolidays(year: number, month: number): Promise<Holiday[]> {
  const res = await fetch(`${BASE}/holidays?year=${year}&month=${month}`)
  return res.json()
}
