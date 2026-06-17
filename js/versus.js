/* ============================================================
   versus.js — 대전 모드
   ------------------------------------------------------------
   설계 핵심 (authoritative single-source + 단일 writer 승계):
   1) "방장이 누구인가"의 단일 진실은 오직 rooms.host_id 다.
      presence는 "누가 접속해 있나 + 이름/색"만 담당하고,
      방장 판단에는 관여하지 않는다 → 진실이 둘로 갈리지 않음(분열 방지).
   2) host_id 변경은 Postgres Changes(Realtime)로 모두에게 실시간 전파.
   3) 위임 = host_id 를 그 사람으로 UPDATE.
   4) 방장이 presence에서 사라지면 곧장 넘기지 않고 "유예 시간"을 둔다.
      유예(약 10초)가 지나도 방장이 안 돌아오면, 남은 접속자 중
      '가장 오래 접속한 단 한 명'만 자신을 새 host_id로 기록(단일 writer).
      → 새로고침(보통 1~3초)은 유예가 흡수 → 방장 유지.
        진짜 이탈만 승계 발생 → 경쟁/분열 없음.
   5) presence stale 방지: Account 준비 후에만 track, 탭 복귀/재연결 시
      fresh 데이터로 다시 track.
   ============================================================ */

const Versus = (() => {
  const HOST_GRACE_MS = 10000;   // 방장이 사라진 뒤 승계까지 기다리는 유예

  const Room = {
    code: null,
    myName: null,
    data: null,             // rooms 행 캐시
    channel: null,          // presence + broadcast
    dbChannel: null,        // rooms 행 Postgres Changes
    players: [],            // [{id,name,themeLine,joinedAt}]
    hostId: null,           // 단일 진실: 현재 방장(rooms.host_id)
  };

  const playerListeners = [];
  const hostListeners = [];
  const backToLobbyListeners = [];
  function onPlayersChange(fn) { playerListeners.push(fn); }
  function onHostChange(fn) { hostListeners.push(fn); }
  function onBackToLobby(fn) { backToLobbyListeners.push(fn); }
  function notifyPlayers() { playerListeners.forEach(fn => { try { fn(Room.players); } catch (e) {} }); }
  let lastNotifiedHost = undefined;
  function notifyHostIfChanged() {
    if (Room.hostId !== lastNotifiedHost) {
      lastNotifiedHost = Room.hostId;
      hostListeners.forEach(fn => { try { fn(isHost()); } catch (e) {} });
    }
  }

  function client() { return Account.getClient ? Account.getClient() : null; }

  // 내 고유 id: 로그인 사용자는 user id, 게스트는 localStorage에 영구 보관
  function myId() {
    const uid = Account.getUserId && Account.getUserId();
    if (uid) return uid;
    let id = localStorage.getItem("vsGuestId");
    if (!id) { id = "g_" + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("vsGuestId", id); }
    return id;
  }

  // 이번 접속의 합류 시각(승계 시 '가장 오래 접속한 사람' 판정용 tiebreaker)
  let mySessionJoinedAt = Date.now();
  function refreshJoinTime() { mySessionJoinedAt = Date.now(); }

  /* ---------- 방장 판단 ---------- */
  // 방장은 오직 rooms.host_id. presence와 무관.
  function getHostId() { return Room.hostId; }
  function isHost() { return !!Room.hostId && Room.hostId === myId(); }

  /* ---------- 이름/코드 유틸 ---------- */
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  function makeCode(len = 6) { let s = ""; for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }

  function guestName() {
    let n = localStorage.getItem("guestName");
    if (!n) { n = "Guest #" + Math.floor(1000 + Math.random() * 9000); localStorage.setItem("guestName", n); }
    return n;
  }
  function resolveMyName() {
    const loggedIn = Account.isLoggedIn && Account.isLoggedIn();
    const p = Account.getProfile && Account.getProfile();
    if (loggedIn && p && p.nickname) return p.nickname;
    return guestName();
  }
  function myThemeLine() {
    const loggedIn = Account.isLoggedIn && Account.isLoggedIn();
    const p = Account.getProfile && Account.getProfile();
    if (loggedIn && p && p.theme_line) return p.theme_line;
    return null;
  }
  function inviteLink(code) { return location.href.split("#")[0].split("?")[0] + "?room=" + code; }

  /* ---------- presence → 참가자 배열 ---------- */
  function buildPlayers(state) {
    const list = [];
    const seen = new Set();
    for (const key in state) {
      const metas = state[key];
      if (!Array.isArray(metas) || metas.length === 0) continue;
      // 같은 key에 메타 여러 개면 가장 최근(joinedAt 최대) 것만 → stale 방지
      let m = metas[0];
      for (const cand of metas) { if ((cand.joinedAt || 0) > (m.joinedAt || 0)) m = cand; }
      if (!m || !m.id || !m.name) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      list.push(m);
    }
    // 방장(host_id) 먼저, 그다음 joinedAt 순
    list.sort((a, b) => {
      const ha = a.id === Room.hostId ? 1 : 0, hb = b.id === Room.hostId ? 1 : 0;
      return (hb - ha) || (a.joinedAt - b.joinedAt) || String(a.name).localeCompare(String(b.name));
    });
    return list;
  }
  let myTyping = false;
  function myMeta() { return { id: myId(), name: Room.myName, themeLine: myThemeLine(), joinedAt: mySessionJoinedAt, typing: myTyping }; }
  function hostPresent() { return !!Room.hostId && Room.players.some(p => p.id === Room.hostId); }

  // 내 "입력중" 상태를 presence로 전파 (디바운스는 호출측에서)
  function setTyping(on) {
    on = !!on;
    if (on === myTyping) return;
    myTyping = on;
    if (Room.channel) { try { Room.channel.track(myMeta()); } catch (e) {} }
  }

  // presence 동기화 시
  function handleSync() {
    if (!Room.channel) return;
    Room.players = buildPlayers(Room.channel.presenceState());
    notifyPlayers();
    scheduleHostCheck();   // 방장이 사라졌는지 유예 후 점검
  }

  /* ---------- 방장 승계 워치독 ---------- */
  let hostCheckTimer = null;
  function scheduleHostCheck() {
    // 방장이 접속 중이면 예약 취소
    if (hostPresent()) {
      if (hostCheckTimer) { clearTimeout(hostCheckTimer); hostCheckTimer = null; }
      return;
    }
    // 이미 예약돼 있으면 그대로 둠(중복 방지)
    if (hostCheckTimer) return;
    hostCheckTimer = setTimeout(async () => {
      hostCheckTimer = null;
      await maybeClaimHost();
    }, HOST_GRACE_MS);
  }

  // 유예가 지난 시점에 방장이 여전히 없으면, '가장 오래 접속한 단 한 명'만 승계 기록.
  async function maybeClaimHost() {
    if (hostPresent()) return;                 // 그새 방장이 돌아옴
    const players = Room.players || [];
    if (players.length === 0) return;
    // 가장 오래 접속한 사람(=joinedAt 최소, 동률 id순)
    const sorted = [...players].sort((a, b) =>
      (a.joinedAt - b.joinedAt) || String(a.id).localeCompare(String(b.id)));
    const heir = sorted[0];
    if (!heir || heir.id !== myId()) return;   // 나는 후계자가 아님 → 아무것도 안 함(단일 writer)
    // 내가 후계자 → DB에 새 방장으로 기록(모두에게 Postgres Changes로 전파됨)
    const c = client();
    if (c && Room.code) {
      try { await c.from("rooms").update({ host_id: myId(), host_name: Room.myName }).eq("code", Room.code); } catch (e) {}
    }
    applyHost(myId(), Room.myName);            // 내 화면 즉시 반영
    // 보조: 브로드캐스트로도 빠르게 알림
    if (Room.channel) { try { await Room.channel.send({ type: "broadcast", event: "host_set", payload: { hostId: myId(), hostName: Room.myName } }); } catch (e) {} }
  }

  // 방장 정보 적용(공통)
  function applyHost(hostId, hostName) {
    const wasHost = (Room.hostId === myId());
    Room.hostId = hostId || null;
    if (Room.data) { Room.data.host_id = Room.hostId; if (hostName !== undefined) Room.data.host_name = hostName; }
    notifyHostIfChanged();
    notifyPlayers();   // 왕관 위치 갱신

    // ★ 내가 방장이 됐는데 게임이 진행 중이면(스냅샷 보유) 게임 루프를 이어받는다.
    const amHostNow = (Room.hostId === myId());
    if (amHostNow && !wasHost && !hostGame && lastSnapshot && lastSnapshot.phase && lastSnapshot.phase !== "ended") {
      takeOverHostGame(lastSnapshot);
    }
  }

  // 마지막 스냅샷으로부터 방장 게임 상태를 복원해 루프를 이어받는다(방장 교체 대비)
  function takeOverHostGame(snap) {
    hostGame = {
      order: snap.order || [], region: snap.region, lineIds: snap.lineIds, duration: snap.duration,
      startAt: Date.now(), playAt: snap.playAt || Date.now(),
      gameEndsAt: snap.gameEndsAt, index: snap.index,
      qEndsAt: snap.qEndsAt, scores: Object.assign({}, snap.scores || {}),
      winnerId: snap.winnerId || null, winnerName: snap.winnerName || null,
      phase: snap.phase, revealUntil: snap.phase === "reveal" ? (Date.now() + 600) : 0,
      names: Object.assign({}, snap.names || {}),
    };
    startHostLoop();
  }

  /* ---------- Realtime 연결 ---------- */
  async function connectChannel() {
    const c = client();
    if (!c || !Room.code) return false;
    await disconnectChannel(true);

    refreshJoinTime();

    // broadcast self:true → 내가 보낸 host_set도 동일 경로로 처리(일관성)
    const channel = c.channel("room:" + Room.code, {
      config: { presence: { key: myId() }, broadcast: { self: true } },
    });
    channel.on("presence", { event: "sync" }, handleSync);
    // 승계/위임 즉시 반영 — 이게 화면 갱신의 주 경로(브로드캐스트는 빠르고 안정적)
    channel.on("broadcast", { event: "host_set" }, ({ payload }) => {
      if (payload && payload.hostId) applyHost(payload.hostId, payload.hostName);
    });
    // 새로 들어온 사람이 현재 방장을 물어보면, 방장(또는 아는 사람)이 알려줌
    channel.on("broadcast", { event: "host_who" }, () => {
      if (Room.hostId && Room.channel) {
        try { Room.channel.send({ type: "broadcast", event: "host_set", payload: { hostId: Room.hostId, hostName: Room.data && Room.data.host_name } }); } catch (e) {}
      }
    });
    // 게임 시작 신호: 방장이 보낸 설정+문제순서로 모두 동시에 게임 화면 진입
    channel.on("broadcast", { event: "game_start" }, ({ payload }) => {
      if (payload) startGameFromSignal(payload);
    });
    // 상태 스냅샷: 모두 화면에 반영(자가치유). 참가자/방장 공통.
    channel.on("broadcast", { event: "vs_state" }, ({ payload }) => {
      if (payload) applyState(payload);
    });
    // 참가자의 답: 방장만 접수해서 채점
    channel.on("broadcast", { event: "vs_answer" }, ({ payload }) => {
      if (payload && isHost()) hostReceiveAnswer(payload);
    });
    // 방장이 "대기실로" 누르면 모두 대기실로 복귀
    channel.on("broadcast", { event: "back_to_lobby" }, () => {
      backToLobbyListeners.forEach(fn => { try { fn(); } catch (e) {} });
    });

    Room.channel = channel;
    await new Promise((resolve) => {
      channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") { await channel.track(myMeta()); resolve(true); }
      });
      setTimeout(() => resolve(false), 5000);
    });

    // rooms 행 변경 실시간 감지 → host_id/상태 동기화 (Realtime 켜져 있으면 동작)
    const dbCh = c.channel("roomdb:" + Room.code);
    dbCh.on("postgres_changes",
      { event: "*", schema: "public", table: "rooms", filter: "code=eq." + Room.code },
      (payload) => {
        if (payload.eventType === "DELETE") return;
        const row = payload.new || {};
        if (Room.data) Room.data = Object.assign({}, Room.data, row);
        if (row.host_id !== undefined) applyHost(row.host_id, row.host_name);
      });
    Room.dbChannel = dbCh;
    await new Promise((resolve) => { dbCh.subscribe(() => resolve(true)); setTimeout(() => resolve(false), 5000); });

    // 안전망: 주기적으로 DB의 host_id를 다시 읽어 화면을 자가 치유.
    // (Postgres Changes가 혹시 안 켜져 있어도 몇 초 안에 방장 표시가 맞춰짐)
    startReconciler();

    return true;
  }

  // 주기적 DB 재동기화 (3초마다 host_id 확인)
  let reconcileTimer = null;
  function startReconciler() {
    stopReconciler();
    reconcileTimer = setInterval(async () => {
      const c = client();
      if (!c || !Room.code) return;
      try {
        const { data } = await c.from("rooms").select("host_id, host_name, status").eq("code", Room.code).maybeSingle();
        if (data && data.host_id && data.host_id !== Room.hostId) {
          applyHost(data.host_id, data.host_name);   // 화면 자가 치유
        }
        if (data && data.status && Room.data) Room.data.status = data.status;
      } catch (e) {}
    }, 3000);
  }
  function stopReconciler() { if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; } }

  async function retrack() {
    if (!Room.channel) return;
    Room.myName = resolveMyName();
    try { await Room.channel.track(myMeta()); } catch (e) {}
  }

  async function disconnectChannel(keepList) {
    const c = client();
    if (hostCheckTimer) { clearTimeout(hostCheckTimer); hostCheckTimer = null; }
    stopReconciler();
    if (c && Room.channel) { try { await Room.channel.untrack(); } catch (e) {} try { await c.removeChannel(Room.channel); } catch (e) {} }
    if (c && Room.dbChannel) { try { await c.removeChannel(Room.dbChannel); } catch (e) {} }
    Room.channel = null; Room.dbChannel = null;
    if (!keepList) { Room.players = []; lastNotifiedHost = undefined; }
  }

  /* ---------- 방 생성 ---------- */
  async function createRoom() {
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요. 잠시 후 다시 시도해주세요." };
    Room.myName = resolveMyName();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode(6);
      const row = {
        code, host_id: myId(), host_name: Room.myName,
        region: (typeof State !== "undefined" && State.region) ? State.region : "seoul",
        mode: "all", duration_sec: 90, status: "waiting",
      };
      const { error } = await c.from("rooms").insert(row);
      if (!error) {
        Room.code = code; Room.data = row; Room.hostId = myId();
        await connectChannel();
        notifyHostIfChanged();
        return { ok: true, code };
      }
      if (error.code !== "23505") { console.warn("[Versus] 방 생성 실패", error.message); return { ok: false, message: error.message }; }
    }
    return { ok: false, message: "방 코드 생성에 실패했어요. 다시 시도해주세요." };
  }

  /* ---------- 방 입장 (새로고침 재접속도 이 경로) ---------- */
  async function joinRoom(code) {
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요." };
    code = (code || "").trim().toUpperCase();
    if (code.length < 4) return { ok: false, message: "코드를 정확히 입력해주세요." };

    const { data, error } = await c.from("rooms").select("*").eq("code", code).maybeSingle();
    if (error) { console.warn("[Versus] 입장 조회 실패", error.message); return { ok: false, message: error.message }; }
    if (!data) return { ok: false, message: "그런 방이 없어요. 코드를 다시 확인해주세요." };
    if (data.status === "ended") return { ok: false, message: "이미 끝난 방이에요." };

    Room.code = code;
    Room.myName = resolveMyName();
    Room.data = data;
    Room.hostId = data.host_id || null;   // DB가 곧 진실
    await connectChannel();
    notifyHostIfChanged();
    return { ok: true, code };
  }

  /* ---------- 게임 설정 / 시작 ---------- */
  // 방장이 대기실에서 설정을 바꾸면 DB에 저장(다음 단계에서 대기실 표시에 활용 가능)
  async function updateSettings(s) {
    if (!Room.code || !isHost()) return { ok: false };
    const patch = {};
    if (s.region !== undefined) patch.region = s.region;
    if (s.mode !== undefined) patch.mode = s.mode;
    if (s.customLines !== undefined) patch.custom_lines = (s.customLines || []).join(",");
    if (s.duration !== undefined) patch.duration_sec = s.duration;
    if (s.playMode !== undefined) patch.play_mode = s.playMode;
    Room.data = Object.assign({}, Room.data, patch);
    const c = client();
    if (c) { try { await c.from("rooms").update(patch).eq("code", Room.code); } catch (e) {} }
    return { ok: true };
  }

  /* ============================================================
     호스트 권위 모델 (authoritative host)
     ------------------------------------------------------------
     실제 멀티플레이어 퀴즈(Kahoot/HQ 등)와 같은 방식:
     • 방장(host)이 게임의 단일 진실. 점수·현재 문제·타이머를 방장이 소유.
     • 방장은 "전체 상태 스냅샷"(vs_state)을 주기적으로(약 1초) + 변경 시 즉시 방송.
     • 참가자는 자기 답을 방장에게 전송(vs_answer)만 함. 채점/승자판정은 방장만.
     • 모든 화면은 스냅샷을 '그대로 표시'. 메시지가 유실돼도 다음 스냅샷이 교정 → 자가치유.
     • 타이머는 방장이 준 절대시각(questionEndsAt)으로 카운트 → 모두 동기화.
     ============================================================ */
  const gameStartListeners = [];
  const stateListeners = [];
  let lastStartedAt = 0;
  function onGameStart(fn) { gameStartListeners.push(fn); }
  function onState(fn) { stateListeners.push(fn); }

  // ----- 방장이 소유하는 게임 상태 (참가자에겐 null) -----
  let hostGame = null;   // { order, region, lineIds, duration, gameEndsAt, index, qEndsAt, scores:{}, winnerId, winnerName, phase, names:{} }
  let hostTickTimer = null;
  let hostSnapshotTimer = null;

  const VS_Q_SECONDS = 10;       // 문제별 제한시간
  const VS_REVEAL_MS = 1500;     // 정답 공개 후 다음 문제까지

  // 방장이 "게임 시작"을 누르면: 상태 초기화하고 게임 루프 시작
  async function startGame(settings) {
    if (!Room.code || !isHost()) return { ok: false, message: "방장만 시작할 수 있어요." };
    const region = settings.region || (Room.data && Room.data.region) || "seoul";
    const mode = settings.mode || "all";
    const customLines = settings.customLines || [];
    const duration = settings.duration || 60;

    const lineIds = window.VersusGame.resolveLineIds(region, mode, customLines);
    if (!lineIds || lineIds.length === 0) return { ok: false, message: "노선을 선택해주세요." };
    const order = window.VersusGame.buildOrder(region, lineIds);

    const c = client();
    if (c) { try { await c.from("rooms").update({ status: "playing" }).eq("code", Room.code); } catch (e) {} }

    const now = Date.now();
    const COUNTDOWN_MS = 3300;   // 시작 카운트다운(클라가 보여줌)
    hostGame = {
      order, region, lineIds, duration,
      startAt: now,
      playAt: now + COUNTDOWN_MS,                 // 실제 첫 문제 시작 시각
      gameEndsAt: now + COUNTDOWN_MS + duration * 1000,
      index: 0,
      qEndsAt: now + COUNTDOWN_MS + VS_Q_SECONDS * 1000,
      scores: {}, winnerId: null, winnerName: null,
      phase: "countdown",                          // countdown → playing → reveal → ended
      revealUntil: 0,
      names: {},
    };
    // 시작 신호(설정+순서) 방송 — 모두 같은 문제로 게임 화면 진입 + 카운트다운
    const startPayload = { region, mode, lineIds, duration, order, startedAt: now, playAt: hostGame.playAt };
    broadcast("game_start", startPayload, 3);
    startGameFromSignal(startPayload);

    startHostLoop();
    return { ok: true };
  }

  // 방장 게임 루프: 타이머 감시(문제 시간/정답공개/게임종료) + 스냅샷 송출
  function startHostLoop() {
    stopHostLoop();
    hostTickTimer = setInterval(hostTick, 200);
    hostSnapshotTimer = setInterval(() => broadcastState(), 1000);
    // 즉시 1회
    setTimeout(() => broadcastState(), 50);
  }
  function stopHostLoop() {
    if (hostTickTimer) { clearInterval(hostTickTimer); hostTickTimer = null; }
    if (hostSnapshotTimer) { clearInterval(hostSnapshotTimer); hostSnapshotTimer = null; }
  }

  function hostTick() {
    if (!hostGame || !isHost()) return;
    const now = Date.now();
    // 이름 최신화(점수판 표시용)
    (Room.players || []).forEach(p => { hostGame.names[p.id] = { name: p.name, themeLine: p.themeLine }; });

    if (hostGame.phase === "countdown") {
      if (now >= hostGame.playAt) { hostGame.phase = "playing"; broadcastState(); }
      return;
    }
    if (hostGame.phase === "playing") {
      if (now >= hostGame.gameEndsAt) { endHostGame(); return; }
      // 문제 시간 초과 → 정답 공개(승자 없음)
      if (now >= hostGame.qEndsAt) {
        hostGame.phase = "reveal";
        hostGame.winnerId = null; hostGame.winnerName = null;
        hostGame.revealUntil = now + VS_REVEAL_MS;
        broadcastState();
      }
      return;
    }
    if (hostGame.phase === "reveal") {
      if (now >= hostGame.revealUntil) {
        // 다음 문제로
        const next = hostGame.index + 1;
        if (next >= hostGame.order.length || now >= hostGame.gameEndsAt) { endHostGame(); return; }
        hostGame.index = next;
        hostGame.winnerId = null; hostGame.winnerName = null;
        hostGame.qEndsAt = Math.min(now + VS_Q_SECONDS * 1000, hostGame.gameEndsAt);
        hostGame.phase = "playing";
        broadcastState();
      }
      return;
    }
  }

  function endHostGame() {
    if (!hostGame) return;
    hostGame.phase = "ended";
    broadcastState();
    broadcastState();  // 한 번 더(유실 대비)
    stopHostLoop();
  }

  // 방장: 참가자(또는 자신)의 정답 접수 → 현재 문제의 첫 정답자만 승자 확정
  function hostReceiveAnswer(ans) {
    if (!hostGame || !isHost()) return;
    if (hostGame.phase !== "playing") return;       // 공개/카운트다운 중엔 무시
    if (typeof ans.index !== "number" || ans.index !== hostGame.index) return; // 다른 문제
    if (hostGame.winnerId) return;                  // 이미 승자 있음(선착순)
    // 승자 확정
    hostGame.winnerId = ans.playerId;
    hostGame.winnerName = ans.playerName;
    hostGame.scores[ans.playerId] = (hostGame.scores[ans.playerId] || 0) + 1;
    hostGame.phase = "reveal";
    hostGame.revealUntil = Date.now() + VS_REVEAL_MS;
    broadcastState();
  }

  // 방장: 현재 상태를 스냅샷으로 방송
  function buildSnapshot() {
    const g = hostGame;
    return {
      index: g.index, phase: g.phase,
      qEndsAt: g.qEndsAt, gameEndsAt: g.gameEndsAt, playAt: g.playAt,
      winnerId: g.winnerId, winnerName: g.winnerName,
      scores: g.scores, names: g.names,
      order: g.order, region: g.region, lineIds: g.lineIds, duration: g.duration,
      hostId: Room.hostId, ts: Date.now(),
    };
  }
  function broadcastState() {
    if (!hostGame || !isHost()) return;
    const snap = buildSnapshot();
    broadcast("vs_state", snap, 1);
    applyState(snap);   // 방장 자신도 동일 경로로 반영
  }

  // 참가자/방장 공통: 스냅샷 수신 → 화면에 반영 (자가치유의 핵심)
  let lastStateTs = 0;
  let lastSnapshot = null;
  function applyState(snap) {
    if (!snap) return;
    if (snap.ts && snap.ts < lastStateTs) return;   // 더 오래된 스냅샷이면 무시
    lastStateTs = snap.ts || Date.now();
    lastSnapshot = snap;
    stateListeners.forEach(fn => { try { fn(snap); } catch (e) {} });
  }

  // 참가자: 내 답을 방장에게 전송 (방장이면 직접 접수)
  function sendAnswer(index) {
    const ans = { index, playerId: myId(), playerName: Room.myName, t: Date.now() };
    if (isHost()) { hostReceiveAnswer(ans); return; }
    broadcast("vs_answer", ans, 3);   // 유실 대비 3회
  }

  function startGameFromSignal(payload) {
    if (payload && payload.startedAt && payload.startedAt === lastStartedAt) return;
    if (payload && payload.startedAt) lastStartedAt = payload.startedAt;
    if (Room.data) Room.data.status = "playing";
    lastStateTs = 0;
    gameStartListeners.forEach(fn => { try { fn(payload); } catch (e) {} });
  }

  // 방장이 결과 화면에서 "대기실로"를 누르면: 상태 되돌리고 모두 대기실로
  async function backToLobby() {
    if (!isHost()) return { ok: false };
    hostGame = null; stopHostLoop();
    const c = client();
    if (c && Room.code) { try { await c.from("rooms").update({ status: "waiting" }).eq("code", Room.code); } catch (e) {} }
    broadcast("back_to_lobby", {}, 3);
    backToLobbyListeners.forEach(fn => { try { fn(); } catch (e) {} });
    return { ok: true };
  }

  // 공통 방송 헬퍼: 유실 대비 n회 반복
  function broadcast(event, payload, times) {
    let n = 0; times = times || 1;
    const send = () => {
      if (Room.channel) { try { Room.channel.send({ type: "broadcast", event, payload }); } catch (e) {} }
      if (++n < times) setTimeout(send, 200);
    };
    send();
  }

  /* ---------- 수동 위임 ---------- */
  async function transferHost(newHostId) {
    if (!Room.code || !isHost()) return { ok: false };
    const target = Room.players.find(p => p.id === newHostId);
    if (!target) return { ok: false };
    const c = client();
    if (c) { try { await c.from("rooms").update({ host_id: newHostId, host_name: target.name }).eq("code", Room.code); } catch (e) {} }
    applyHost(newHostId, target.name);   // 내 화면 즉시
    if (Room.channel) { try { await Room.channel.send({ type: "broadcast", event: "host_set", payload: { hostId: newHostId, hostName: target.name } }); } catch (e) {} }
    return { ok: true };
  }

  /* ---------- 방 나가기 (버튼 전용) ---------- */
  async function leaveRoom() {
    const c = client();
    const amHost = isHost();
    const others = (Room.players || []).filter(p => p.id !== myId());

    if (c && Room.code && amHost && others.length > 0) {
      // 방장이 직접 나감 → 가장 오래 접속한 남은 사람에게 즉시 위임
      const sorted = [...others].sort((a, b) => (a.joinedAt - b.joinedAt) || String(a.id).localeCompare(String(b.id)));
      const heir = sorted[0];
      try { await c.from("rooms").update({ host_id: heir.id, host_name: heir.name }).eq("code", Room.code); } catch (e) {}
      if (Room.channel) { try { await Room.channel.send({ type: "broadcast", event: "host_set", payload: { hostId: heir.id, hostName: heir.name } }); } catch (e) {} }
      await new Promise(r => setTimeout(r, 200));
      await disconnectChannel();
    } else if (c && Room.code && others.length === 0) {
      // 아무도 안 남으면 방 삭제
      await disconnectChannel();
      try { await c.from("rooms").delete().eq("code", Room.code); } catch (e) {}
    } else {
      await disconnectChannel();
    }
    Room.code = null; Room.data = null; Room.players = []; Room.hostId = null; lastNotifiedHost = undefined;
  }

  // 새로고침/창닫기 직전: presence에서 즉시 이탈. (방장이면 host_id는 DB에 남아 유예 동안 유지)
  function quickLeave() { try { if (Room.channel) Room.channel.untrack(); } catch (e) {} }

  return {
    Room,
    makeCode, guestName, resolveMyName, myThemeLine, inviteLink, myId,
    createRoom, joinRoom, leaveRoom, transferHost, quickLeave, retrack,
    updateSettings, startGame, onGameStart, onState, sendAnswer,
    setTyping, backToLobby, onBackToLobby,
    onPlayersChange, onHostChange, getPlayers: () => Room.players,
    isHost, getHostId,
  };
})();
