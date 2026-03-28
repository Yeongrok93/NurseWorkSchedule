# 간호사 듀티표 생성기

OR-Tools CP-SAT 기반 자동 스케줄러 — FastAPI + React + TypeScript

---

## 프로젝트 구조

```
nurse-scheduler-web/
├── backend/
│   ├── main.py           # FastAPI + WebSocket
│   ├── scheduler.py      # CP-SAT 솔버 (핵심 로직)
│   ├── excel_parser.py   # 희망근무 엑셀 파싱
│   ├── excel_export.py   # 결과 Excel 생성
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── NursesPage.tsx    # 명단 관리 + 제약 설정
│   │   │   └── SchedulePage.tsx  # 스케줄 생성 + 결과 표시
│   │   ├── types/index.ts
│   │   └── utils/api.ts
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
└── docker-compose.yml    # 로컬 통합 실행용
```

---

## 로컬 실행 (Docker)

```bash
docker-compose up --build
# 프론트: http://localhost:3000
# 백엔드: http://localhost:8000
# API 문서: http://localhost:8000/docs
```

---

## 클라우드 배포 (Railway + Vercel)

### 1. Railway — 백엔드

1. [railway.app](https://railway.app) 접속 → New Project → Deploy from GitHub
2. `backend/` 디렉토리 선택 (또는 root 설정)
3. 환경변수 설정:
   ```
   PORT=8000
   ```
4. 배포 완료 후 도메인 복사 (예: `https://nurse-api-xxx.railway.app`)

### 2. Vercel — 프론트엔드

1. [vercel.com](https://vercel.com) 접속 → Import Git Repository
2. Root Directory: `frontend`
3. Framework: Vite
4. 환경변수 설정:
   ```
   VITE_API_URL=https://nurse-api-xxx.railway.app
   ```
5. Deploy

---

## 희망근무 엑셀 포맷

파서가 유연하게 동작합니다. 아래 컬럼이 있으면 자동 인식:

| 컬럼 | 필수 | 설명 |
|------|------|------|
| 이름 (또는 name) | ✅ | 간호사 이름 |
| 그룹 (또는 group) | 권장 | 리더/중간연차/저연차/1년차 |
| 나이트전담 (또는 nd) | 선택 | O 입력 시 전담 처리 |
| 1일 ~ 31일 | 선택 | 희망 근무: D/E/N/O, 빈칸=희망없음 |

예시:
```
이름    그룹      나이트전담  1일  2일  5일  10일
김수진  리더              D       O
이혜원  중간연차           E   D
도연주  중간연차  O        N   N       N
신입A   1년차              O
```

---

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/health` | 서버 상태 |
| GET | `/holidays?year=&month=` | 한국 공휴일 조회 |
| POST | `/parse-excel` | 엑셀 파싱 → 간호사 목록 |
| POST | `/schedule/start` | 스케줄 생성 시작 → job_id |
| GET | `/schedule/{job_id}` | 결과 조회 |
| WS | `/ws/{job_id}` | 진행상황 실시간 수신 |
| POST | `/schedule/{job_id}/export` | Excel 다운로드 |

---

## 환경변수

### Backend (Railway)
| 변수 | 기본값 | 설명 |
|------|--------|------|
| PORT | 8000 | 서버 포트 |

### Frontend (Vercel)
| 변수 | 예시 | 설명 |
|------|------|------|
| VITE_API_URL | https://xxx.railway.app | 백엔드 URL |
