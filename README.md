# CoolCalendar

CoolMessenger 메시지를 읽어 AI로 정리하고, 로컬 ICS 및 Google Calendar 일정으로 관리하는 Windows 데스크톱 앱입니다. UI와 데스크톱 런타임은 Electron + React + TypeScript로 구성되어 있습니다.

## 빠른 실행

빌드된 앱이 있으면 다음 파일을 실행합니다.

```powershell
.\run_desktop_calendar.bat
```

개발 모드로 실행하려면 다음 명령을 사용합니다.

```powershell
cd electron_app
npm install
npm run dev
```

## 설치 파일 만들기

```powershell
cd electron_app
npm run dist
```

설치 파일과 압축 해제된 실행 파일은 `electron_app/release/`에 생성됩니다.

화면 글꼴은 앱에 포함된 Noto Sans KR Variable을 사용합니다. 글꼴 라이선스는 패키지의 `resources/licenses/OFL-NotoSansKR.txt`에서 확인할 수 있습니다.

## 주요 기능

- CoolMessenger UDB의 최근 수신 메시지 자동 감시 및 검색
- 메시지 AI 요약, 할 일 감지, 일정 추천과 자동 생성
- 월간 캘린더, 날짜별 일정, 완료 체크리스트
- 밝은 테마 기본값과 밝게/어둡게 화면 전환
- 메시지를 날짜로 드래그해서 ICS 일정 생성
- 일정 생성·수정·휴지통·복원·영구 삭제
- Google Calendar OAuth 연결과 로컬/원격 일정 동기화
- Windows 바탕화면 캘린더 오버레이
- 트레이 상주, 로그인 시 자동 실행, 창 위치 복원

## 기존 Python 버전에서 이전

Electron 앱의 첫 실행 시 기존 `desktop_app/config.json`을 찾아 다음 데이터를 자동으로 이관합니다.

- UDB 및 일정 폴더 경로
- 창과 오버레이 설정
- OpenAI 및 Google Calendar 설정
- Google OAuth 토큰과 동기화 상태
- 일정 완료 상태와 AI 분석 캐시

ICS 파일은 기존 `CoolMessenger Calendar Drop` 폴더를 그대로 사용하므로 별도의 내보내기 작업이 필요하지 않습니다. API 키와 Google OAuth Client Secret은 Electron의 Windows 보안 저장소로 암호화한 뒤 설정 파일에 기록합니다.

## 폴더 구성

- `electron_app/`: 현재 Electron 애플리케이션
- `desktop_app/`: 이전 PySide6 구현 및 데이터 마이그레이션 원본
- `legacy/`: 초기 Python/Tk 구현
- `data/`: 이전 요약 결과와 로컬 미리보기

## 로컬 데이터

Electron 설정과 동기화 상태는 `%APPDATA%\coolcalendar-electron`에 저장됩니다. 아래 파일은 Git에 포함되지 않습니다.

- 사용자별 UDB 경로와 설정
- OpenAI API 키 및 Google OAuth 정보
- AI 분석 캐시와 일정 완료 상태
- Google Calendar 토큰 및 동기화 맵

## 확인 명령

```powershell
cd electron_app
npm run build
npm audit --omit=dev
```
