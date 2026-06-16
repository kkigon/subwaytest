/* ============================================================
   versus.js — 대전 모드 (2단계: 실시간 참가자 목록 = Presence)
   ------------------------------------------------------------
   - Supabase의 rooms 테이블로 방을 만들고 코드로 입장한다.
   - Realtime Presence로 "지금 방에 누가 있는지"를 실시간 추적한다.
   - 게임 시작/정답 동기화(Broadcast)는 다음 단계에서 추가.
   - Account.getClient() 로 Supabase 클라이언트를 빌려 쓴다.
   ============================================================ */

const Versus = (() => {
  const $ = sel => document.querySelector(sel);

  // 현재 방 상태
  const Room = {
    code: null,
    isHost: false,
    myName: null,       // 화면에 보일 내 이름 (닉네임 또는 Guest #1234)
    data: null,         // rooms 테이블의 행
    channel: null,      // Realtime 채널
    players: [],        // 현재 참가자 목록 [{id,name,themeLine,isHost}]
  };

  // presence 변경 시 UI가 다시 그리도록 등록하는 콜백들
  const playerListeners = [];
  function onPlayersChange(fn) { playerListeners.push(fn); }
  function notifyPlayers() { playerListeners.forEach(fn => { try { fn(Room.players); } catch (e) {} }); }

  // 방장 권한 변경 시 UI 갱신 콜백들
  const hostListeners = [];
  function onHostChange(fn) { hostListeners.push(fn); }
  function notifyHost() { hostListeners.forEach(fn => { try { fn(Room.isHost); } catch (e) {} }); }

  function client() { return Account.getClient ? Account.getClient() : null; }

  // 이 브라우저 세션의 고유 id (게스트도 자기 자신을 식별하기 위함)
  function myId() {
    let id = sessionStorage.getItem("vsClientId");
    if (!id) {
      id = "u_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem("vsClientId", id);
    }
    // 로그인 사용자는 user id를 우선 사용(여러 기기 구분에 유리)
    const uid = Account.getUserId && Account.getUserId();
    return uid || id;
  }

  /* ---------- 이름/코드 유틸 ---------- */
  // 헷갈리는 글자(0,O,1,I,L) 제외한 코드 문자셋
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  function makeCode(len = 6) {
    let s = "";
    for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }

  // 비로그인 게스트 이름: 세션 동안 유지
  function guestName() {
    let n = sessionStorage.getItem("guestName");
    if (!n) {
      n = "Guest #" + Math.floor(1000 + Math.random() * 9000);
      sessionStorage.setItem("guestName", n);
    }
    return n;
  }

  // 화면에 표시할 내 이름 결정 (로그인=닉네임, 아니면 게스트)
  function resolveMyName() {
    const p = Account.getProfile && Account.getProfile();
    if (Account.isLoggedIn && Account.isLoggedIn() && p && p.nickname) return p.nickname;
    return guestName();
  }

  // 내 테마 노선(닉네임 태그 색). 게스트는 기본값.
  function myThemeLine() {
    const p = Account.getProfile && Account.getProfile();
    return (p && p.theme_line) ? p.theme_line : "L1";
  }

  // 초대 링크
  function inviteLink(code) {
    const base = location.href.split("#")[0].split("?")[0];
    return base + "?room=" + code;
  }

  /* ---------- Realtime 채널 (Presence) ---------- */
  // presence state를 평탄한 참가자 배열로 변환
  function buildPlayers(state) {
    const list = [];
    const seen = new Set();
    for (const key in state) {
      const metas = state[key];
      if (!Array.isArray(metas) || !metas[0]) continue;
      const m = metas[0];
      if (!m || !m.id || !m.name) continue;     // 유효한 참가자만
      if (seen.has(m.id)) continue;             // 중복 방지
      seen.add(m.id);
      list.push(m);
    }
    // 방장을 맨 앞으로, 그다음 이름순
    list.sort((a, b) => (b.isHost - a.isHost) || String(a.name).localeCompare(String(b.name)));
    return list;
  }

  // 방 채널에 접속하고 내 존재를 track
  async function connectChannel() {
    const c = client();
    if (!c || !Room.code) return false;

    // 기존 채널 정리
    if (Room.channel) { try { await c.removeChannel(Room.channel); } catch (e) {} Room.channel = null; }

    const channel = c.channel("room:" + Room.code, {
      config: { presence: { key: myId() } },
    });

    // presence 동기화: 전체 목록이 바뀔 때마다
    channel.on("presence", { event: "sync" }, () => {
      Room.players = buildPlayers(channel.presenceState());
      notifyPlayers();
    });

    // 방장 변경 브로드캐스트 수신
    channel.on("broadcast", { event: "host_changed" }, ({ payload }) => {
      const newHostId = payload && payload.newHostId;
      Room.data = Room.data || {};
      Room.data.host_id = newHostId;
      Room.data.host_name = payload && payload.newHostName;
      const amHost = (newHostId === myId());
      if (amHost !== Room.isHost) {
        Room.isHost = amHost;
        // 내 presence의 isHost 값을 갱신해 모두에게 반영
        if (Room.channel) { try { Room.channel.track(myMeta()); } catch (e) {} }
      }
      notifyHost();      // 역할 변경을 UI에 알림
      notifyPlayers();
    });

    Room.channel = channel;

    await new Promise((resolve) => {
      channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track(myMeta());   // 내 존재를 방에 알림
          resolve(true);
        }
      });
      // 안전장치: 일정 시간 내 응답 없으면 그냥 진행
      setTimeout(() => resolve(false), 4000);
    });
    return true;
  }

  // 내 presence 메타데이터
  function myMeta() {
    return {
      id: myId(),
      name: Room.myName,
      themeLine: myThemeLine(),
      isHost: !!Room.isHost,
    };
  }

  // 채널에서 나가기(untrack + 구독 해제)
  async function disconnectChannel() {
    const c = client();
    if (c && Room.channel) {
      try { await Room.channel.untrack(); } catch (e) {}
      try { await c.removeChannel(Room.channel); } catch (e) {}
    }
    Room.channel = null;
    Room.players = [];
  }

  /* ---------- 방 생성 ---------- */
  async function createRoom() {
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요. 잠시 후 다시 시도해주세요." };

    Room.myName = resolveMyName();
    // 코드 중복을 피하기 위해 몇 번 시도
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode(6);
      const row = {
        code,
        host_id: (Account.getUserId && Account.getUserId()) || null,
        host_name: Room.myName,
        region: (typeof State !== "undefined" && State.region) ? State.region : "seoul",
        mode: "all",
        duration_sec: 90,
        status: "waiting",
      };
      const { error } = await c.from("rooms").insert(row);
      if (!error) {
        Room.code = code;
        Room.isHost = true;
        Room.data = row;
        await connectChannel();   // 실시간 채널 접속 + 내 존재 track
        return { ok: true, code };
      }
      // 코드 충돌(기본키 중복)이면 다시 시도, 그 외 오류는 즉시 반환
      if (error.code !== "23505") {
        console.warn("[Versus] 방 생성 실패", error.message);
        return { ok: false, message: error.message };
      }
    }
    return { ok: false, message: "방 코드 생성에 실패했어요. 다시 시도해주세요." };
  }

  /* ---------- 방 입장 ---------- */
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
    Room.isHost = (Account.getUserId && Account.getUserId()) && data.host_id === Account.getUserId();
    Room.myName = resolveMyName();
    Room.data = data;
    await connectChannel();   // 실시간 채널 접속 + 내 존재 track
    return { ok: true, code };
  }

  /* ---------- 방장 위임 ---------- */
  // 지정한 참가자에게 방장 권한을 넘긴다.
  async function transferHost(newHostId) {
    const c = client();
    if (!c || !Room.code || !Room.isHost) return { ok: false };
    const target = Room.players.find(p => p.id === newHostId);
    if (!target) return { ok: false };

    // 1) rooms 테이블의 방장 정보 갱신(영구 기록)
    try {
      await c.from("rooms").update({ host_id: newHostId, host_name: target.name }).eq("code", Room.code);
    } catch (e) { /* 업데이트 실패해도 브로드캐스트는 시도 */ }

    // 2) 모두에게 방장 변경 알림
    if (Room.channel) {
      try {
        await Room.channel.send({
          type: "broadcast",
          event: "host_changed",
          payload: { newHostId, newHostName: target.name },
        });
      } catch (e) {}
    }

    // 3) 내 상태도 즉시 갱신 (브로드캐스트는 보낸 사람 자신에겐 안 올 수 있음)
    Room.isHost = (newHostId === myId());
    Room.data = Room.data || {};
    Room.data.host_id = newHostId; Room.data.host_name = target.name;
    try { if (Room.channel) await Room.channel.track(myMeta()); } catch (e) {}
    notifyHost(); notifyPlayers();
    return { ok: true };
  }

  /* ---------- 방 나가기 ---------- */
  async function leaveRoom() {
    const c = client();

    // 방장이 나가는데 다른 참가자가 있으면 → 방장 위임 후 떠남
    if (c && Room.code && Room.isHost) {
      const others = Room.players.filter(p => p.id !== myId());
      if (others.length > 0) {
        const next = others[0];   // 남은 참가자 중 첫 명에게 위임
        try {
          await c.from("rooms").update({ host_id: next.id, host_name: next.name }).eq("code", Room.code);
        } catch (e) {}
        if (Room.channel) {
          try {
            await Room.channel.send({
              type: "broadcast",
              event: "host_changed",
              payload: { newHostId: next.id, newHostName: next.name },
            });
          } catch (e) {}
        }
        // 위임 메시지가 전달될 짧은 여유
        await new Promise(r => setTimeout(r, 150));
        await disconnectChannel();
      } else {
        // 혼자였으면 방 삭제
        await disconnectChannel();
        try { await c.from("rooms").delete().eq("code", Room.code); } catch (e) {}
      }
    } else {
      // 참가자가 나가는 경우: 그냥 떠남
      await disconnectChannel();
    }

    Room.code = null; Room.isHost = false; Room.data = null; Room.players = [];
  }

  return {
    Room,
    makeCode, guestName, resolveMyName, myThemeLine, inviteLink, myId,
    createRoom, joinRoom, leaveRoom, transferHost,
    onPlayersChange, onHostChange, getPlayers: () => Room.players,
    isHost: () => Room.isHost,
  };
})();
