export type ShiftType = 'D' | 'E' | 'N' | '6D' | '6N' | 'EDU' | 'O'
export type GroupType = 'charge' | 'leader' | 'mid' | 'junior' | 'first'

export interface ShiftRequest {
  day: number
  shift: ShiftType
  rank?: number          // 특기사항에서 추출한 희망 순위 (1이 가장 강함)
}

export interface Nurse {
  id: number
  name: string
  group: GroupType
  is_night_dedicated: boolean
  can_two_shift: boolean
  is_part_time: boolean
  fixed_requests: Record<string, ShiftType>
  preferred_requests: ShiftRequest[]
  preceptor_subgroup: string | null
  is_preceptee: boolean
  preceptor_support_days: number
  no_night: boolean                // 야간 근무 불가 ('N 불가')
  independence_day: number | null  // 신입 독립 시작일
  weekly_fixed_off: number[]       // 주차요일제 (0=월 … 6=일)
  career_years: number | null
  sabun: string
  work_kind: string                // 근무종류 원문 (3교대/야간전담/…)
  note: string
}

/** 특기사항 자연어 해석 결과 (사용자 확인 대상) */
export interface NoteInterpretation {
  index: number
  name: string
  note: string
  priority_requests: { rank: number; days: number[] }[]
  weekly_fixed_off: string[]       // ["수","목"]
  leftover: string                 // 해석 못한 나머지
}

export interface NoteInterpretResult {
  items: NoteInterpretation[]
  engine: 'llm' | 'rule' | 'none'
  warning: string | null
}

export interface ConstraintConfig {
  year: number
  month: number
  min_staff_weekday: Record<string, number>
  min_staff_saturday: Record<string, number>
  min_staff_sunday: Record<string, number>
  max_consecutive_work: number
  night_dedicated_count: number
  max_first_year: number
  min_night_block: number
  max_night_block: number
  max_two_shift_pairs_per_day: number
  max_d6_block: number
  max_n6_block: number
  night_min_gap: number
  night_max_count: number
  time_limit_seconds: number
}

export interface NurseStats {
  group: string
  can_two_shift: boolean
  is_part_time: boolean
  counts: Record<string, number>
  total_work: number
  total_nights: number
  total_hours: number
  target_hours: number
  remain: number
  request_rate: string
}

export interface ScheduleResult {
  schedule: Record<string, Record<string, ShiftType>>
  stats: Record<string, NurseStats>
  support_days?: Record<string, number[]>   // {프리셉터 서브그룹: [지원일, ...]}
  relaxed?: string                          // 제약이 완화된 경우 그 내용
}

export interface Holiday {
  day: number
  name: string
}

export type SolverStatus = 'idle' | 'pending' | 'running' | 'done' | 'infeasible' | 'error'

export const GROUP_LABEL: Record<GroupType, string> = {
  charge: '차지',
  leader: '리더',
  mid: '중간연차',
  junior: '저연차',
  first: '1년차',
}

export const GROUP_COLOR: Record<GroupType, string> = {
  charge: '#7c5cfc',
  leader: '#3182f6',
  mid:    '#00a876',
  junior: '#e8990c',
  first:  '#8b95a1',
}

export const SHIFT_COLOR: Record<string, { bg: string; text: string }> = {
  D:    { bg: '#e7f9f3', text: '#00875a' },
  E:    { bg: '#fff4e5', text: '#b75e00' },
  N:    { bg: '#f3efff', text: '#6938d3' },
  '6D': { bg: '#eaf2ff', text: '#1b64da' },
  '6N': { bg: '#ffeff5', text: '#d6336c' },
  EDU:  { bg: '#fff1e6', text: '#c2540a' },
  O:    { bg: 'transparent', text: '#b0b8c1' },
}
