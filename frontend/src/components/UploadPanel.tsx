import { useRef, useState } from 'react'
import type { Nurse } from '../types'
import { parseExcel } from '../utils/api'

interface Props {
  onParsed: (nurses: Nurse[]) => void
}

export default function UploadPanel({ onParsed }: Props) {
  const fileRef  = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'idle'|'loading'|'ok'|'err'>('idle')
  const [msg,   setMsg]   = useState('')
  const [dragging, setDragging] = useState(false)

  async function process(file: File) {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      setState('err'); setMsg('xlsx 또는 xls 파일만 허용됩니다'); return
    }
    setState('loading'); setMsg('')
    try {
      const { nurses, count } = await parseExcel(file)
      onParsed(nurses)
      setState('ok'); setMsg(`${count}명 불러오기 완료`)
    } catch (e: any) {
      setState('err'); setMsg(e.message ?? '파싱 오류')
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) process(f)
    e.target.value = ''
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) process(f)
  }

  const borderColor = dragging ? '#2563eb' : state === 'ok' ? '#059669' : state === 'err' ? '#dc2626' : 'var(--color-border-secondary)'

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{
        border: `2px dashed ${borderColor}`,
        borderRadius: 10,
        padding: '28px 20px',
        textAlign: 'center',
        background: dragging ? '#eff6ff' : 'var(--color-background-primary)',
        transition: 'all .15s',
        cursor: 'pointer',
      }}
      onClick={() => fileRef.current?.click()}
    >
      <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={onFileChange} />

      <div style={{ fontSize: 28, marginBottom: 8 }}>
        {state === 'loading' ? '⏳' : state === 'ok' ? '✅' : state === 'err' ? '❌' : '📂'}
      </div>

      {state === 'loading' ? (
        <div style={{ fontSize: 13, color: '#2563eb' }}>파싱 중...</div>
      ) : (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
            {dragging ? '여기에 놓으세요' : '희망근무 엑셀 업로드'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            클릭하거나 파일을 드래그하세요 · .xlsx / .xls
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.6,
            background: 'var(--color-background-secondary)', borderRadius: 6, padding: '6px 10px', display: 'inline-block', textAlign: 'left' }}>
            컬럼: <code>이름 · 그룹 · 나이트전담(선택) · 1일 · 2일 · ...</code><br/>
            그룹: 리더 / 중간연차 / 저연차 / 1년차 &nbsp;|&nbsp; 희망: D · E · N · O
          </div>
        </>
      )}

      {msg && (
        <div style={{ marginTop: 10, fontSize: 13, fontWeight: 500,
          color: state === 'ok' ? '#065f46' : '#991b1b' }}>
          {state === 'ok' ? '✅ ' : '❌ '}{msg}
        </div>
      )}
    </div>
  )
}
