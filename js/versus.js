/* ============================================================
   versus.js — 대전 모드
   ------------------------------------------------------------
   핵심 설계(중요):
   - "방장이 누구인가"의 단일 진실(single source of truth)은
     rooms 테이블의 host_id 다. presence에는 방장 정보를 넣지 않는다.
   - rooms 행의 변경(host_id, status 등)은 Postgres Changes(Realtime)로
     모두에게 실시간 통보된다 → 새로고침해도 방장 정보가 사라지지 않음.
   - presence는 "누가 접속해 있나 + 이름/색"만 담당한다.
   - 방을 나가는 것은 오직 leaveRoom()(나가기 버튼)으로만. 단순 새로고침/
     일시적 연결 끊김은 방을 나가는 것으로 처리하지 않는다.
   ============================================================ */

const Versus = (() => {
  const Room = {
    code: null,
    hostId: null,       // 단일 진실: 현재 방장 id (rooms.host_id)
    hostName: null,
    myName: null,       // 화면에 보일 내 이름 (닉네임 또는 Guest #1234)
    data: null,         // rooms 테이블의 행 캐시
    channel: null,      // Realtime presence/broadcast 채널
    dbChannel: null,    // Realtime Postgres Changes 채널 (rooms 행 감시)
    players: [],        // 현재 접속 참가자 [{id,name,themeLine}]
  };

  // 참가자/방 상태 변경 시 UI 갱신 콜백
  const playerListeners = [];
  const hostListeners = [];
  function onPlayersChange(fn) { playerListeners.push(fn); }
  function onHostChange(fn) { hostListeners.push(fn); }
  function notifyPlayers() { playerListeners.forEach(fn => { try { fn(Room.players); } catch (e) {} }); }
  function notifyHost() { hostListeners.forEach(fn => { try { fn(isHost()); } catch (e) {} }); }

  function client() { return Account.getClient ? Account.getClient() : null; }

  // 이 브라우저의 고유 id. 로그인 사용자는 user id, 게스트는 영구 보관되는 무작위 id.
  // ※ localStorage 사용 → 새로고침해도 같은 id 유지(방장 식별이 끊기지 않음)
  function myId() {
    const uid = Account.getUserId && Account.getUserId();
    if (uid) return uid;
    let id = localStorage.getItem("vsGuestId");
    if (!id) {
      id = "g_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("vsGuestId", id);
    }
    return id;
  }

  function isHost() { return !!Room.hostId && Room.hostId === myId(); }

  /* ---------- 이름/코드 유틸 ---------- */
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 헷갈리는 글자 제외
  function makeCode(len = 6) {
    let s = "";
    for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }

  // 비로그인 게스트 이름: 새로고침해도 유지되도록 localStorage 사용
  function guestName() {
    let n = localStorage.getItem("guestName");
    if (!n) {
      n = "Guest #" + Math.floor(1000 + Math.random() * 9000);
      localStorage.setItem("guestName", n);
    }
    return n;
  }

  function resolveMyName() {
    const p = Account.getProfile && Account.getProfile();
    if (Account.isLoggedIn && Account.isLoggedIn() && p && p.nickname) return p.nickname;
    return guestName();
  }

  // 내 테마 노선(닉네임 태그 색). 비로그인(게스트)은 null → UI에서 회색 처리.
  function myThemeLine() {
    const loggedIn = Account.isLoggedIn && Account.isLoggedIn();
    const p = Account.getProfile && Account.getProfile();
    if (loggedIn && p && p.theme_line) return p.theme_line;
    return null;
  }

  function inviteLink(code) {
    const base = location.href.split("#")[0].split("?")[0];
    return base + "?room=" + code;
  }

  /* ---------- presence → 참가자 배열 ---------- */
  function buildPlayers(state) {
    const list = [];
    const seen = new Set();
    for (const key in state) {
      const metas = state[key];
      if (!Array.isArray(metas) || !metas[0]) continue;
      const m = metas[0];
      if (!m || !m.id || !m.name) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      list.push(m);
    }
    // 방장을 맨 앞으로(현재 hostId 기준), 그다음 이름순
    list.sort((a, b) => {
      const ha = (a.id === Room.hostId) ? 1 : 0;
      const hb = (b.id === Room.hostId) ? 1 : 0;
      return (hb - ha) || String(a.name).localeCompare(String(b.name));
    });
    return list;
  }

  function myMeta() {
    return { id: myId(), name: Room.myName, themeLine: myThemeLine() };
  }

  /* ---------- Realtime 연결 ---------- */
  // (1) presence 채널: 접속자 목록 + (보조) 즉시성 위한 host_changed 브로드캐스트
  // (2) Postgres Changes 채널: rooms 행 변경을 실시간 감지 (단일 진실 동기화)
  async function connectChannel() {
    const c = client();
    if (!c || !Room.code) return false;

    await disconnectChannel(true);  // 기존 채널 정리(목록은 유지)

    // --- presence 채널 ---
    const channel = c.channel("room:" + Room.code, {
      config: { presence: { key: myId() } },
    });

    channel.on("presence", { event: "sync" }, () => {
      Room.players = buildPlayers(channel.presenceState());
      notifyPlayers();
      maybeReassignHost();   // 방장이 사라졌으면 남은 사람이 자동 승계
    });

    // 즉시성 보강용 브로드캐스트(방장 변경을 빠르게 알림). 단일 진실은 여전히 DB.
    channel.on("broadcast", { event: "host_changed" }, ({ payload }) => {
      if (!payload) return;
      applyHost(payload.newHostId, payload.newHostName);
    });

    Room.channel = channel;
    await new Promise((resolve) => {
      channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") { await channel.track(myMeta()); resolve(true); }
      });
      setTimeout(() => resolve(false), 4000);
    });

    // --- Postgres Changes 채널: 이 방(rooms 행) 변경 실시간 감지 ---
    const dbCh = c.channel("roomdb:" + Room.code);
    dbCh.on("postgres_changes",
      { event: "*", schema: "public", table: "rooms", filter: "code=eq." + Room.code },
      (payload) => {
        const row = payload.new || {};
        if (payload.eventType === "DELETE") return;  // 삭제는 별도 처리 안 함(이 단계)
        // 방장/상태를 DB 기준으로 갱신
        if (row.host_id !== undefined) applyHost(row.host_id, row.host_name);
        if (row.status !== undefined && Room.data) Room.data.status = row.status;
        if (Room.data) Room.data = Object.assign({}, Room.data, row);
      }
    );
    Room.dbChannel = dbCh;
    await new Promise((resolve) => {
      dbCh.subscribe(() => resolve(true));
      setTimeout(() => resolve(false), 4000);
    });

    return true;
  }

  // 방장 정보 적용(공통). 바뀌면 UI 갱신.
  function applyHost(hostId, hostName) {
    const changed = (Room.hostId !== hostId);
    Room.hostId = hostId || null;
    if (hostName !== undefined) Room.hostName = hostName;
    if (Room.data) { Room.data.host_id = Room.hostId; if (hostName !== undefined) Room.data.host_name = hostName; }
    if (changed) { notifyHost(); }
    // 정렬(왕관 위치)도 갱신
    notifyPlayers();
  }

  // 방장이 방에서 사라졌으면(새로고침·접속종료 등) 남은 사람 중 한 명이 자동 승계.
  // 모든 클라이언트가 "현재 접속자 중 id가 가장 작은 사람"을 새 방장으로 선출(결정론적)하고,
  // 그 사람만 DB를 갱신한다 → Postgres Changes로 모두에게 전파되어 일관성 유지.
  let reassigning = false;
  async function maybeReassignHost() {
    const players = Room.players;
    if (!players || players.length === 0) return;
    // 현재 방장이 아직 접속 중이면 아무 것도 안 함
    const hostPresent = Room.hostId && players.some(p => p.id === Room.hostId);
    if (hostPresent) return;

    // 새 방장 후보: 접속자 중 id 사전순 최소 (모두가 동일하게 계산)
    const sorted = [...players].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const elected = sorted[0];
    if (!elected) return;

    // 내가 선출된 사람일 때만 DB에 기록 (중복 쓰기 방지)
    if (elected.id === myId() && !reassigning) {
      reassigning = true;
      const c = client();
      try {
        if (c && Room.code) {
          await c.from("rooms").update({ host_id: elected.id, host_name: elected.name }).eq("code", Room.code);
        }
        // 즉시성 보강 브로드캐스트
        if (Room.channel) {
          try {
            await Room.channel.send({ type: "broadcast", event: "host_changed",
              payload: { newHostId: elected.id, newHostName: elected.name } });
          } catch (e) {}
        }
      } catch (e) { /* 무시 */ }
      // 내 화면도 즉시 반영
      applyHost(elected.id, elected.name);
      setTimeout(() => { reassigning = false; }, 1000);
    }
  }

  async function disconnectChannel(keepList) {
    const c = client();
    if (c && Room.channel) {
      try { await Room.channel.untrack(); } catch (e) {}
      try { await c.removeChannel(Room.channel); } catch (e) {}
    }
    if (c && Room.dbChannel) {
      try { await c.removeChannel(Room.dbChannel); } catch (e) {}
    }
    Room.channel = null; Room.dbChannel = null;
    if (!keepList) Room.players = [];
  }

  /* ---------- 방 생성 ---------- */
  async function createRoom() {
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요. 잠시 후 다시 시도해주세요." };
    Room.myName = resolveMyName();
    const hostId = myId();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode(6);
      const row = {
        code,
        host_id: hostId,
        host_name: Room.myName,
        region: (typeof State !== "undefined" && State.region) ? State.region : "seoul",
        mode: "all",
        duration_sec: 90,
        status: "waiting",
      };
      const { error } = await c.from("rooms").insert(row);
      if (!error) {
        Room.code = code;
        Room.hostId = hostId; Room.hostName = Room.myName;
        Room.data = row;
        await connectChannel();
        return { ok: true, code };
      }
      if (error.code !== "23505") {
        console.warn("[Versus] 방 생성 실패", error.message);
        return { ok: false, message: error.message };
      }
    }
    return { ok: false, message: "방 코드 생성에 실패했어요. 다시 시도해주세요." };
  }

  /* ---------- 방 입장 (새로고침 후 재접속도 이 경로) ---------- */
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
    Room.hostId = data.host_id || null;   // DB의 방장이 곧 진실
    Room.hostName = data.host_name || null;
    Room.myName = resolveMyName();
    Room.data = data;
    await connectChannel();
    return { ok: true, code };
  }

  /* ---------- 방장 위임 ---------- */
  async function transferHost(newHostId) {
    const c = client();
    if (!c || !Room.code || !isHost()) return { ok: false };
    const target = Room.players.find(p => p.id === newHostId);
    if (!target) return { ok: false };

    // 1) 단일 진실(DB) 갱신 → Postgres Changes로 모두에게 전파됨
    try {
      await c.from("rooms").update({ host_id: newHostId, host_name: target.name }).eq("code", Room.code);
    } catch (e) {}

    // 2) 즉시성 보강: 브로드캐스트도 함께(전파 지연 최소화)
    if (Room.channel) {
      try {
        await Room.channel.send({ type: "broadcast", event: "host_changed",
          payload: { newHostId, newHostName: target.name } });
      } catch (e) {}
    }

    // 3) 내 화면 즉시 반영
    applyHost(newHostId, target.name);
    return { ok: true };
  }

  /* ---------- 방 나가기 (오직 버튼으로만 호출) ---------- */
  async function leaveRoom() {
    const c = client();
    const amHost = isHost();

    if (c && Room.code && amHost) {
      const others = Room.players.filter(p => p.id !== myId());
      if (others.length > 0) {
        // 남은 참가자에게 위임 후 떠남
        const next = others[0];
        try {
          await c.from("rooms").update({ host_id: next.id, host_name: next.name }).eq("code", Room.code);
        } catch (e) {}
        if (Room.channel) {
          try {
            await Room.channel.send({ type: "broadcast", event: "host_changed",
              payload: { newHostId: next.id, newHostName: next.name } });
          } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 200)); // 전파 여유
        await disconnectChannel();
      } else {
        // 혼자면 방 삭제
        await disconnectChannel();
        try { await c.from("rooms").delete().eq("code", Room.code); } catch (e) {}
      }
    } else {
      await disconnectChannel();
    }
    Room.code = null; Room.hostId = null; Room.hostName = null;
    Room.data = null; Room.players = [];
  }

  // 새로고침/창닫기 직전 호출: presence에서 즉시 빠진다(동기적 시도).
  // DB 쓰기는 하지 않음(불안정) — 남은 사람들이 maybeReassignHost로 승계.
  function quickLeave() {
    try { if (Room.channel) Room.channel.untrack(); } catch (e) {}
  }

  return {
    Room,
    makeCode, guestName, resolveMyName, myThemeLine, inviteLink, myId,
    createRoom, joinRoom, leaveRoom, transferHost, quickLeave,
    onPlayersChange, onHostChange, getPlayers: () => Room.players,
    isHost, getHostId: () => Room.hostId,
  };
})();
