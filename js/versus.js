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
  function onPlayersChange(fn) { playerListeners.push(fn); }
  function onHostChange(fn) { hostListeners.push(fn); }
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
  function myMeta() { return { id: myId(), name: Room.myName, themeLine: myThemeLine(), joinedAt: mySessionJoinedAt }; }
  function hostPresent() { return !!Room.hostId && Room.players.some(p => p.id === Room.hostId); }

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
    Room.hostId = hostId || null;
    if (Room.data) { Room.data.host_id = Room.hostId; if (hostName !== undefined) Room.data.host_name = hostName; }
    notifyHostIfChanged();
    notifyPlayers();   // 왕관 위치 갱신
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
    // 게임 시작 신호: 방장이 보낸 설정+문제순서로 모두 동시에 게임 시작
    channel.on("broadcast", { event: "game_start" }, ({ payload }) => {
      if (payload) startGameFromSignal(payload);
    });
    // 선착순 정답: 같은 문제(index)에 대한 첫 vs_correct만 채택
    channel.on("broadcast", { event: "vs_correct" }, ({ payload }) => {
      if (payload) applyVsCorrect(payload);
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

  // 게임 시작 신호 수신 시 모두가 실행 (방장 자신도 self:true로 받음)
  const gameStartListeners = [];
  let lastStartedAt = 0;
  let vsHandledIndex = -1;   // 이미 처리한(정답자 확정된) 문제 번호
  function onGameStart(fn) { gameStartListeners.push(fn); }
  function startGameFromSignal(payload) {
    // 같은 시작 신호를 중복 처리하지 않도록 startedAt으로 디듀프
    if (payload && payload.startedAt && payload.startedAt === lastStartedAt) return;
    if (payload && payload.startedAt) lastStartedAt = payload.startedAt;
    vsHandledIndex = -1;   // 새 게임이므로 정답 처리 기록 초기화
    if (Room.data) Room.data.status = "playing";
    gameStartListeners.forEach(fn => { try { fn(payload); } catch (e) {} });
  }

  // 방장이 "게임 시작"을 누르면 호출: 문제 순서 생성 + 모두에게 broadcast
  async function startGame(settings) {
    if (!Room.code || !isHost()) return { ok: false, message: "방장만 시작할 수 있어요." };
    const region = settings.region || (Room.data && Room.data.region) || "seoul";
    const mode = settings.mode || "all";
    const customLines = settings.customLines || [];
    const playMode = settings.playMode || "timed";
    const duration = settings.duration || 60;

    // 출제 노선 id와 문제 순서를 방장이 생성 (모두 동일하게 쓰도록 broadcast)
    const lineIds = window.VersusGame.resolveLineIds(region, mode, customLines);
    if (!lineIds || lineIds.length === 0) return { ok: false, message: "노선을 선택해주세요." };
    const order = window.VersusGame.buildOrder(region, lineIds);

    const payload = { region, mode, lineIds, playMode, duration, order, startedAt: Date.now() };

    // 상태를 playing으로 (재접속자가 게임 중임을 알 수 있게)
    const c = client();
    if (c) { try { await c.from("rooms").update({ status: "playing" }).eq("code", Room.code); } catch (e) {} }

    // 모두에게 시작 신호 (self:true라 나도 받아서 같은 경로로 시작)
    if (Room.channel) {
      try { await Room.channel.send({ type: "broadcast", event: "game_start", payload }); } catch (e) {}
    }
    // 혹시 broadcast 자기수신이 안 되는 경우 대비, 직접도 한 번
    startGameFromSignal(payload);
    return { ok: true };
  }

  /* ---------- 선착순 정답 ---------- */
  // 내가 정답을 맞혔을 때(게임에서 호출): 모두에게 알림
  function sendCorrect(index) {
    const payload = { index, winnerId: myId(), winnerName: Room.myName, t: Date.now() };
    if (Room.channel) { try { Room.channel.send({ type: "broadcast", event: "vs_correct", payload }); } catch (e) {} }
    // self:true라 내 핸들러로도 들어오지만, 혹시 몰라 직접도 한 번
    applyVsCorrect(payload);
  }
  // 정답 신호 수신: 같은 문제(index)에 대한 첫 신호만 채택
  function applyVsCorrect(payload) {
    if (!payload || typeof payload.index !== "number") return;
    if (payload.index <= vsHandledIndex) return;   // 이미 처리한 문제 → 무시(두 번째 정답 무시)
    vsHandledIndex = payload.index;
    if (window.VersusGame && typeof window.VersusGame.applyCorrect === "function") {
      window.VersusGame.applyCorrect({ id: payload.winnerId, name: payload.winnerName }, payload.index);
    }
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
    updateSettings, startGame, onGameStart, sendCorrect,
    onPlayersChange, onHostChange, getPlayers: () => Room.players,
    isHost, getHostId,
  };
})();
