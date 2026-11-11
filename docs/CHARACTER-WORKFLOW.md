# 샘플보이 제작·재구현 절차

## 자산 기준

`assets/sample-boy/original.png`는 사용자가 직접 제작한 1024×1536 기준 그림입니다. `assets/sample-boy/frames/`에는 최종 입력 7장(`base`, `blink`, `open`, `smile`, `worried`, `surprised`, `excited`)이 있습니다. 모두 투명 RGBA 1152×1536이며, 원본 너비 양쪽에 각 64px 여백을 둔 작업 캔버스입니다. 기준 그림 한 장만으로 각 표정을 자동 복원할 수는 없으므로, 7장의 최종 프레임도 함께 배포합니다.

새 그림으로 만들 때는 기준 구도와 머리·의상·안경·목걸이 카드 위치를 고정하고 눈썹·눈·입만 바꾼 7장을 준비합니다. 안경을 분리하려면 동일한 표정의 안경 없는 7장도 준비해 `prepare-character.mjs`, `prepare-clean-character.mjs`로 합성할 수 있습니다. 이 두 스크립트는 추가 원화가 있을 때 쓰는 선택 단계입니다. 동봉된 최종 프레임으로 재제작할 때는 사용하지 않습니다.

## 동봉 프레임에서 재제작

저장소 루트에서 `npm ci`, `python -m pip install -r requirements.txt`, `npm run build:sample`을 실행합니다. 스크립트는 동봉된 7장을 `_work/sample-cast/`에 복사하고, 아래 순서를 실행합니다. 모든 생성물은 `_out/sample/`과 `_work/`에만 씁니다.

1. `vola-live build separated_character`: 머리·얼굴·눈·입 레이어를 분리합니다.
2. `attach-clean-glasses.mjs`: 보정된 안경테 한 장을 독립 레이어로 붙입니다.
3. `prepare-idle-model.mjs`: 표정 텍스처의 열린 눈 중복을 지웁니다.
4. `vola-live build surprise_eyes --no-expr`: 놀란 그림에서 별도 눈을 추출합니다.
5. `merge-surprise-rig.mjs`: 놀란 눈·눈썹·홍채를 합치고, 기본 눈과의 전환을 지정합니다.
6. `validate`, `pack`, `export`, `qa-surprise-iris.mjs`: 형식·압축·모델과 홍채 경계를 검사합니다.

결과 모델은 `_out/sample/separated_surprise_cleaniris_v3.vola`입니다. 재생용 공개 모델은 `assets/sample-boy/sample-boy.vola`에 있습니다. 새 빌드는 생성 시각과 환경 정보가 달라 바이트 해시가 같지 않을 수 있습니다.

## 레이어와 눈 보정의 핵심

안경테를 앞머리와 눈에 굽지 않고 `glasses` 한 장으로 뒀습니다. 표정 텍스처에서는 눈 영역을 비워 자동 깜빡임 때 열린 눈이 남지 않게 했습니다. 놀란 표정은 기본 눈을 늘리지 않고 별도 흰자·눈꺼풀·홍채·눈썹을 켭니다. 기본 눈 레이어는 놀란 상태에서 꺼집니다.

놀란 홍채의 실제 그림은 25×35px이고, 투명 여백을 더한 텍스처와 레이어 박스는 37×43px입니다. 좌우 6px·상하 4px의 여백과 각 눈 흰자에 대한 `clip`이 시선 이동 중 회색 가장자리 번짐을 막습니다. `qa-surprise-iris.mjs`가 두 눈의 크기·여백·클립을 검사합니다. 안경은 눈·눈썹·앞머리와 별도 레이어로 유지합니다.

`@livliv-dev/player` 0.3.0의 특수 눈 렌더 경로에는 표정 `show/hide` 패치가 필요합니다. `npm ci --prefix examples/character-preview` 후 `npm run build:player`를 실행하면 `player-surprise.js`가 생성됩니다. 패치 대상의 원문이 달라지면 스크립트가 실패하므로 다른 플레이어 버전에서는 다시 검토해야 합니다.

## 미리보기 검수

저장소 루트에서 `python -m http.server 8765 --bind 127.0.0.1`을 실행하고 <http://127.0.0.1:8765/examples/character-preview/>를 엽니다. 기본·기쁨·걱정·놀람·신남에서 자동 눈 깜빡임을 확인합니다. 놀람에서 시선을 −1, 0, +1로 옮기고 홍채 회색 자국, 겹친 눈동자, 안경테 중복선, 귀 옆 잔상을 확인합니다. 호흡 두 주기와 표정별 모션, 무음 대사 한 번·반복·정지, 음성 파일 재생과 태그 전환도 확인합니다. 자동 음성 태그는 음량·침묵에 따른 편집 가능한 초안이며 음성 인식이나 감정 판정이 아닙니다.
