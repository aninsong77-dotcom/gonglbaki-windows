# 곤글박이 - Electron 전체화면 설정 가이드

## 변경 사항 요약
- ✅ 프로그램 실행 시 자동으로 **최대화된 창**으로 시작
- ✅ 우상단에 **창 조절 버튼** 3개 추가 (최소화 / 최대화·복원 / 닫기)
- ✅ 헤더를 드래그해서 창 이동 가능 (Electron 프레임리스 창)

## 추가된 파일

```
gongulbaki/
├── electron-main.js   ← Electron 메인 프로세스 (창 생성, 최대화, IPC)
├── preload.js         ← 보안 브릿지 (창 조작 API를 React에 노출)
└── src/pages/Index.tsx ← 우상단 창 조절 버튼 추가됨
```

## Electron 설치 방법

```bash
cd gongulbaki

# Electron 및 추가 패키지 설치
npm install electron concurrently wait-on --save-dev
```

## 실행 방법

### 방법 1: Electron으로 실행 (권장)
```bash
# 1) Python 서버 먼저 시작
cd server
python app.py

# 2) 새 터미널에서 Electron 실행
cd gongulbaki
npx electron .
```

### 방법 2: 한 번에 실행 (concurrently 사용)
```bash
cd gongulbaki
npm run electron:dev
```

## 창 조절 버튼 위치
- 헤더 우측 끝, 설정 버튼 오른쪽에 표시됨
- `—` 최소화 / `□` 최대화·복원 / `✕` 닫기 (닫기는 마우스 오버 시 빨간색)
- **Electron으로 실행할 때만 표시** (일반 브라우저에서는 숨김)

## 참고: 기존 브라우저 실행 방식과의 차이
| 방식 | 전체화면 | 창 조절 버튼 | 드래그 이동 |
|------|---------|------------|-----------|
| 기존 (브라우저) | 수동 | OS 기본 | OS 기본 |
| **Electron (신규)** | **자동 최대화** | **커스텀 버튼** | **헤더 드래그** |
