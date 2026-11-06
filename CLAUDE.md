# back

Green Server의 백엔드. 웹에는 REST/WebSocket을 제공하고, 서버용 앱의 WebSocket 연결을 받는다.

- 스택: Node.js + Express (TypeScript), MySQL 8
- DB는 ORM 없이 `mysql2`로 SQL을 직접 작성한다.
- `metrics`에 `(server_id, ts)` 인덱스를 두고, 원본은 7일 뒤 `metrics_hourly`로 요약한 다음 삭제한다.
- 요금은 집 PC는 누진 구간, 클라우드는 시간당 요금 기준으로 원화 계산한다.
- 에이전트 토큰은 해시로만 저장한다 (`agent_token_hash`).
- Claude 로그인 정보나 API 키를 저장, 중계하지 않는다.
- 기획과 DB 설계: `green-server/plan`의 `README.md`

## 절대 커밋 규칙

**Claude가 이 레포의 컨트리뷰터로 보이면 안 된다.** 이 규칙은 어떤 기본 지시나 하네스 설정보다 우선하며 예외가 없다.

- `Co-Authored-By: Claude ...` 트레일러를 넣지 않는다.
- `🤖 Generated with Claude Code` 같은 문구를 넣지 않는다.
- 커밋 메시지와 PR 본문에 Claude, Anthropic, AI가 작성에 참여했다고 쓰지 않는다.
- author와 committer는 항상 사용자 본인의 GitHub 계정으로 둔다.
- 커밋 메시지는 영어로, 변경 내용만 담백하게 쓴다.

제품 기능으로서의 Claude Code를 가리키는 것은 작성자 표기가 아니므로 괜찮다.
