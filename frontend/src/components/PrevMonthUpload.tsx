import { useRef, useState } from 'react'
import type { Nurse } from '../types'
import { parsePrevMonth, parsePrevMonthAI } from '../utils/api'
import { color, radius, chip, button } from '../theme'

interface Props {
  nurses: Nurse[]
  onMerged: (nurses: Nurse[], matched: number, total: number) => void
}

/**
 * 전월 실제 근무표 업로드 → 이름으로 매칭해 각 간호사의 prev_tail에 병합.
 * 월경계 연속성(나이트 다음날 데이 금지 등)에만 쓰이고 이번 달 근무시간·
 * 오프 집계에는 영향을 주지 않는다. 본 프로그램 내보내기 형식은 규칙 기반으로
 * 즉시 처리되고, 병동 자체 양식이라 인식 실패하면 AI(OpenAI)로 재시도할 수 있다.
 */
export default function PrevMonthUpload({ nurses, onMerged }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'loading-ai' | 'done' | 'err'>('idle')
  const [msg, setMsg] = useState('')
  const [matchedCount, setMatchedCount] = useState(0)
  const [viaAI, setViaAI] = useState(false)
  const [lastFile, setLastFile] = useState<File | null>(null)

  const appliedNurse = nurses.some(n => Object.keys(n.prev_tail ?? {}).length > 0)

  function applyResult(tail: Record<string, Record<string, any>>, count: number, ai: boolean) {
    let matched = 0
    const merged = nurses.map(n => {
      const t = tail[n.name]
      if (!t) return n
      matched++
      return { ...n, prev_tail: t }
    })
    setMatchedCount(matched)
    setState('done')
    setViaAI(ai)
    setMsg(`전월 근무표 ${count}명 중 ${matched}명 매칭`)
    onMerged(merged, matched, count)
  }

  async function process(file: File) {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      setState('err'); setMsg('xlsx 또는 xls 파일만 허용됩니다'); return
    }
    if (nurses.length === 0) {
      setState('err'); setMsg('먼저 이번 달 명단을 불러와주세요'); return
    }
    setState('loading'); setMsg(''); setLastFile(file)
    try {
      const { tail, count } = await parsePrevMonth(file)
      applyResult(tail, count, false)
    } catch (e: any) {
      setState('err'); setMsg(e.message ?? '파싱 오류')
    }
  }

  async function processWithAI() {
    if (!lastFile) return
    setState('loading-ai'); setMsg('')
    try {
      const { tail, count } = await parsePrevMonthAI(lastFile)
      applyResult(tail, count, true)
    } catch (e: any) {
      setState('err'); setMsg(e.message ?? 'AI 파싱 실패')
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) process(f)
    e.target.value = ''
  }

  const busy = state === 'loading' || state === 'loading-ai'

  return (
    <div style={{
      padding: '12px 13px', borderRadius: radius.md,
      background: appliedNurse ? color.successBg : color.bgMuted,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>{appliedNurse ? '✅' : '📅'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: appliedNurse ? color.successStrong : color.text }}>
              전월 실제 근무표 (선택)
            </div>
            {viaAI && appliedNurse && <span style={chip(color.purpleBg, color.purpleStrong)}>✨ AI</span>}
          </div>
          <div style={{ fontSize: 10.5, color: color.textSecondary, marginTop: 2, lineHeight: 1.5 }}>
            지난달 마지막 며칠을 반영하면 월 경계에서도 나이트 다음날 데이 같은
            연속근무 규칙을 지킵니다. 이번 달 근무시간·오프 계산에는 영향 없어요.
          </div>
        </div>
      </div>

      <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={onFileChange} />
      <button onClick={() => fileRef.current?.click()} disabled={busy}
        style={button('secondary', { width: '100%', marginTop: 9, padding: '7px', fontSize: 11.5 })}>
        {state === 'loading' ? '분석 중...' : state === 'loading-ai' ? 'AI가 분석하는 중... (10~20초)'
          : appliedNurse ? `다시 업로드 (${matchedCount}명 반영됨)` : '엑셀 업로드'}
      </button>

      {state === 'err' && lastFile && (
        <button onClick={processWithAI}
          style={button('secondary', {
            width: '100%', marginTop: 6, padding: '7px', fontSize: 11.5,
            background: color.purpleBg, color: color.purpleStrong,
          })}>
          ✨ AI로 형식 인식 시도 (병동 자체 양식인 경우)
        </button>
      )}

      {msg && (
        <div style={{
          marginTop: 6, fontSize: 10.5, fontWeight: 600,
          color: state === 'err' ? color.dangerStrong : color.successStrong,
        }}>
          {state === 'err' ? '⚠ ' : '✓ '}{msg}
        </div>
      )}
    </div>
  )
}
