# VOLA Character v1

`.vola`는 확장자만 바꾼 ZIP이 아니다. `VOLACHA1` 서명, 버전이 있는 JSON 헤더, 자체 `vola-rig` 및 원본 크기의 이미지/키폼 바이트를 연속 저장하는 캐릭터 컨테이너다. 헤더에는 `vola-character` 형식, `layered-mesh-v1` 렌더러, 캔버스, 캐릭터명, 파일별 위치·길이·SHA-256이 있다. 잘못된 버전, 경로, 길이, 해시는 로딩 전에 거부한다.

| 위치 | 내용 |
| --- | --- |
| 0–7 | ASCII `VOLACHA1` |
| 8–11 | JSON 헤더 길이, 32비트 little-endian |
| 12– | UTF-8 헤더 JSON + 파일 바이트 (`entries` 순서) |

첫 버전의 `vola-rig` 레이어 필드는 기존 캐릭터의 모양과 동작을 보존한다. 미리보기 로더는 메모리에서만 이를 LivLiv 플레이어의 v4 레이어 모델로 변환한다. **파일 자체에는 `model.json`이나 `.livliv` ZIP이 없다.** 현재 렌더링 엔진은 여전히 `@livliv-dev/player` 기반이므로, 포맷 독립과 엔진 독립은 구분한다. 미래 엔진으로 옮기려면 `layered-mesh-v1` 렌더러 구현을 추가하면 된다.

```sh
python -m pip install -r requirements.txt
npm run build:sample
```

기존 `pack` 명령은 `.livliv` 호환 패키지를 만든다. 예제의 기본 입력은 `assets/sample-boy/sample-boy.vola`이며, 파일 선택으로 `.livliv`도 열 수 있다.

## Live2D 지원 상태

Live2D 지원은 추후 진행한다. 현재 미리보기는 `.vola`와 `.livliv`만 활성화한다. Cubism Core, Live2D 모델, Live2D 재생 코드는 공개판에 포함하지 않았다.
