export type ShiftType = 'D' | 'E' | 'N' | '6D' | '6N' | 'EDU' | 'O'
export type GroupType = 'charge' | 'leader' | 'mid' | 'junior' | 'first'

export interface ShiftRequest {
  day: number
  shift: ShiftType
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
  charge: '#6366f1',
  leader: '#818cf8',
  mid: '#34d399',
  junior: '#fb923c',
  first: '#94a3b8',
}

export const SHIFT_COLOR: Record<string, { bg: string; text: string }> = {
  D:    { bg: '#d1fae5', text: '#065f46' },
  E:    { bg: '#fef3c7', text: '#78350f' },
  N:    { bg: '#ede9fe', text: '#4c1d95' },
  '6D': { bg: '#bfdbfe', text: '#1e3a8a' },
  '6N': { bg: '#fce7f3', text: '#831843' },
  EDU:  { bg: '#fff7ed', text: '#7c2d12' },
  O:    { bg: 'transparent', text: '#9ca3af' },
}
