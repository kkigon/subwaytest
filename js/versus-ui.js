/* ============================================================
   versus-ui.js — 대전 모드 화면 제어 (1단계)
   ------------------------------------------------------------
   - 홈의 "⚔️ 대전 모드" 버튼 → 대전 진입 화면(만들기 / 입장)
   - 방 생성/입장 성공 → 대기실(코드·초대링크 표시)
   - URL에 ?room=CODE 가 있으면 자동으로 입장 시도
   - 실시간 참가자 목록/게임 시작은 다음 단계에서 채운다.
   ============================================================ */

(() => {
  const $ = sel => document.querySelector(sel);

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- 화면 전환 ---------- */
  // 대전 관련 오버레이를 보여주고 홈/게임 오버레이는 숨긴다.
  function showScreen(id) {
    document.querySelectorAll(".vs-screen").forEach(s => s.classList.remove("show"));
    if (id) $(id)?.classList.add("show");
    document.body.classList.toggle("in-versus", !!id);
  }

  function openEntry() {
    // 서버(설정) 준비 확인
    if (!Account.isConfigured || !Account.isConfigured()) {
      alert("대전 모드는 서버 연결이 필요해요. 잠시 후 다시 시도하거나 새로고침 해주세요.");
      return;
    }
    $("#vs-entry-error").textContent = "";
    $("#vs-code-input").value = "";
    showScreen("#vs-entry-screen");
  }

  function closeVersus() {
    showScreen(null);
    // 홈으로 복귀
    document.body.classList.remove("in-versus");
  }

  /* ---------- 방 만들기 ---------- */
  async function doCreate() {
    const btn = $("#vs-create-btn");
    btn.disabled = true; btn.textContent = "방 만드는 중…";
    const res = await Versus.createRoom();
    btn.disabled = false; btn.textContent = "방 만들기";
    if (!res.ok) { $("#vs-entry-error").textContent = res.message || "방 생성 실패"; return; }
    enterLobby();
  }

  /* ---------- 코드로 입장 ---------- */
  async function doJoin(codeFromUrl) {
    const code = codeFromUrl || $("#vs-code-input").value;
    const btn = $("#vs-join-btn");
    if (btn) { btn.disabled = true; btn.textContent = "입장 중…"; }
    const res = await Versus.joinRoom(code);
    if (btn) { btn.disabled = false; btn.textContent = "입장하기"; }
    if (!res.ok) {
      const errEl = $("#vs-entry-error");
      if (errEl) errEl.textContent = res.message || "입장 실패";
      // URL 자동입장 실패 시 진입화면이라도 보여줌
      if (codeFromUrl) showScreen("#vs-entry-screen");
      return;
    }
    enterLobby();
  }

  /* ---------- 대기실 ---------- */
  function lineColor(id) {
    if (typeof lineById === "function") { const l = lineById(id); if (l) return l.color; }
    return "#0052A4";
  }

  // 참가자 한 명을 닉네임 태그로
  function playerTag(pl) {
    const color = lineColor(pl.themeLine);
    const crown = pl.isHost ? `<span class="vs-crown" title="방장">👑</span>` : "";
    const meMark = (pl.id === Versus.myId()) ? `<span class="vs-me">나</span>` : "";
    return `<div class="vs-player">
      ${crown}
      <span class="nick-tag static" style="--theme:${color}">
        <span class="nick-dot"></span>
        <span class="nick-text">${escapeHtml(pl.name)}</span>
      </span>
      ${meMark}
    </div>`;
  }

  function renderPlayers(players) {
    const box = $("#vs-players");
    if (!box) return;
    if (!players || players.length === 0) {
      box.innerHTML = `<p class="muted">참가자를 기다리는 중…</p>`;
      return;
    }
    const count = players.length;
    box.innerHTML =
      `<div class="vs-players-count">현재 ${count}명 접속 중</div>` +
      `<div class="vs-players-list">${players.map(playerTag).join("")}</div>`;
  }

  function enterLobby() {
    const R = Versus.Room;
    $("#vs-lobby-code").textContent = R.code;
    $("#vs-lobby-link").value = Versus.inviteLink(R.code);

    // 방장/참가자에 따라 안내 문구
    $("#vs-lobby-role").textContent = R.isHost ? "방장" : "참가자";
    $("#vs-host-controls").style.display = R.isHost ? "" : "none";
    $("#vs-guest-note").style.display = R.isHost ? "none" : "";

    // 내 이름 표시
    $("#vs-my-name").textContent = R.myName;

    // 실시간 참가자 목록 렌더 (현재 상태 즉시 + 변경 구독)
    renderPlayers(Versus.getPlayers());

    showScreen("#vs-lobby-screen");
  }

  async function doLeave() {
    await Versus.leaveRoom();
    // URL의 ?room 파라미터 제거
    if (location.search.includes("room=")) {
      history.replaceState(null, "", location.pathname);
    }
    closeVersus();
  }

  async function copyLink() {
    const box = $("#vs-lobby-link");
    try {
      await navigator.clipboard.writeText(box.value);
    } catch (e) {
      box.select(); document.execCommand("copy");
    }
    const btn = $("#vs-copy-link");
    const orig = btn.textContent;
    btn.textContent = "복사됨!";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }

  /* ---------- 초기화 ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-versus")?.addEventListener("click", openEntry);
    $("#vs-create-btn")?.addEventListener("click", doCreate);
    $("#vs-join-btn")?.addEventListener("click", () => doJoin());

    // 참가자 목록이 실시간으로 바뀌면 다시 그림
    Versus.onPlayersChange(renderPlayers);
    $("#vs-code-input")?.addEventListener("keydown", e => { if (e.key === "Enter") doJoin(); });
    // 코드 입력은 자동 대문자
    $("#vs-code-input")?.addEventListener("input", e => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
    $("#vs-copy-link")?.addEventListener("click", copyLink);
    document.querySelectorAll(".vs-leave-btn").forEach(b => b.addEventListener("click", doLeave));
    $("#vs-entry-back")?.addEventListener("click", closeVersus);

    // URL에 ?room=CODE 가 있으면 자동 입장 시도 (Account 준비 후)
    const params = new URLSearchParams(location.search);
    const roomCode = params.get("room");
    if (roomCode) {
      const tryAuto = () => doJoin(roomCode);
      if (Account.isReady && Account.isReady()) tryAuto();
      else if (Account.onChange) {
        // Account가 준비되면 한 번만 시도
        let done = false;
        Account.onChange(() => { if (!done && Account.isReady()) { done = true; tryAuto(); } });
        // 혹시 onChange가 늦으면 안전장치
        setTimeout(() => { if (!done) { done = true; tryAuto(); } }, 1500);
      } else {
        setTimeout(tryAuto, 1200);
      }
    }
  });

  window.VersusUI = { openEntry, closeVersus };
})();
