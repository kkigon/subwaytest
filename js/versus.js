/* ============================================================
   versus.js — 대전 모드
   ------------------------------------------------------------
   설계 핵심 (멀티플레이어 표준 방식):
   1) "지금 누가 접속해 있나"의 단일 진실은 Realtime Presence 다.
   2) 방장은 원칙적으로 "현재 접속자 중 가장 오래 머문 사람"
      (= joinedAt 이 가장 이른 사람, 동률이면 id 사전순).
      → 모든 클라이언트가 같은 presence를 보고 같은 방장을 계산하므로
        분열(split-brain)이 생기지 않는다. DB 경쟁/브로드캐스트 불필요.
   3) 방장이 나가거나 새로고침하면 joinedAt이 갱신/소멸되어
      자동으로 다음으로 오래 머문 사람이 방장이 된다. (= 진짜 나갔다 들어오기)
   4) 수동 위임(👑 위임)은 explicitHostId 오버라이드로 처리:
      그 사람이 접속해 있는 한 그 사람이 방장. 접속이 끊기면 다시 규칙(2)로.
   5) presence stale 방지: Account 준비 후에만 track, 그리고
      visibilitychange/재연결 시 fresh 데이터로 다시 track.
   ============================================================ */

const Versus = (() => {
  const Room = {
    code: null,
    myName: null,
    data: null,             // rooms 행 캐시 (region/mode/duration/status/explicit_host)
    channel: null,          // presence + broadcast
    dbChannel: null,        // rooms 행 Postgres Changes
    players: [],            // [{id,name,themeLine,joinedAt}]
    explicitHostId: null,   // 수동 위임으로 지정된 방장(있으면 우선)
  };

  const playerListeners = [];
  const hostListeners = [];
  function onPlayersChange(fn) { playerListeners.push(fn); }
  function onHostChange(fn) { hostListeners.push(fn); }
  function notifyPlayers() { playerListeners.forEach(fn => { try { fn(Room.players); } catch (e) {} }); }
  let lastHostId = undefined;
  function notifyHostIfChanged() {
    const h = getHostId();
    if (h !== lastHostId) { lastHostId = h; hostListeners.forEach(fn => { try { fn(isHost()); } catch (e) {} }); }
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

  // 이 탭의 "이번 접속" 고유 세션 + 합류 시각.
  // 새로고침하면 새 값이 되어, 같은 사람이라도 '새로 합류'로 취급된다.
  let mySessionJoinedAt = Date.now();
  function refreshJoinTime() { mySessionJoinedAt = Date.now(); }

  /* ---------- 방장 계산 (핵심) ---------- */
  // 현재 방장 id = explicitHostId(접속 중일 때) 우선, 아니면 joinedAt 최소(동률 id순)
  function getHostId() {
    const players = Room.players || [];
    if (Room.explicitHostId && players.some(p => p.id === Room.explicitHostId)) {
      return Room.explicitHostId;
    }
    if (players.length === 0) return null;
    let best = players[0];
    for (const p of players) {
      if (p.joinedAt < best.joinedAt ||
         (p.joinedAt === best.joinedAt && String(p.id).localeCompare(String(best.id)) < 0)) {
        best = p;
      }
    }
    return best.id;
  }
  function isHost() { return getHostId() === myId(); }

  /* ---------- 이름/코드 유틸 ---------- */
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  function makeCode(len = 6) { let s = ""; for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }

  function guestName() {
    let n = localStorage.getItem("guestName");
    if (!n) { n = "Guest #" + Math.floor(1000 + Math.random() * 9000); localStorage.setItem("guestName", n); }
    return n;
  }

  // 표시 이름: 로그인+프로필이 준비됐을 때만 닉네임, 그 외엔 게스트.
  function resolveMyName() {
    const loggedIn = Account.isLoggedIn && Account.isLoggedIn();
    const p = Account.getProfile && Account.getProfile();
    if (loggedIn && p && p.nickname) return p.nickname;
    return guestName();
  }
  // 테마 노선 색. 로그인+프로필 있을 때만, 아니면 null(회색).
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
      // 같은 key에 메타가 여러 개면 가장 최근(joinedAt 최대) 것만 사용 → stale 방지
      let m = metas[0];
      for (const cand of metas) { if ((cand.joinedAt || 0) > (m.joinedAt || 0)) m = cand; }
      if (!m || !m.id || !m.name) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      list.push(m);
    }
    // 방장 먼저, 그다음 joinedAt 순
    const hostId = (() => {
      // 임시로 list 기준 host 계산(아래 getHostId와 동일 규칙)
      if (Room.explicitHostId && list.some(p => p.id === Room.explicitHostId)) return Room.explicitHostId;
      if (list.length === 0) return null;
      let best = list[0];
      for (const p of list) if (p.joinedAt < best.joinedAt || (p.joinedAt === best.joinedAt && String(p.id).localeCompare(String(best.id)) < 0)) best = p;
      return best.id;
    })();
    list.sort((a, b) => {
      const ha = a.id === hostId ? 1 : 0, hb = b.id === hostId ? 1 : 0;
      return (hb - ha) || (a.joinedAt - b.joinedAt) || String(a.name).localeCompare(String(b.name));
    });
    return list;
  }

  function myMeta() {
    return { id: myId(), name: Room.myName, themeLine: myThemeLine(), joinedAt: mySessionJoinedAt };
  }

  // presence 상태가 바뀔 때 호출: 목록/방장 갱신
  function handleSync() {
    if (!Room.channel) return;
    Room.players = buildPlayers(Room.channel.presenceState());
    notifyPlayers();
    notifyHostIfChanged();
  }

  /* ---------- Realtime 연결 ---------- */
  async function connectChannel() {
    const c = client();
    if (!c || !Room.code) return false;
    await disconnectChannel(true);

    refreshJoinTime();   // 이번 접속의 합류 시각

    const channel = c.channel("room:" + Room.code, { config: { presence: { key: myId() } } });
    channel.on("presence", { event: "sync" }, handleSync);

    // 수동 위임 즉시 반영(보조). 단일 진실은 explicitHostId(+DB).
    channel.on("broadcast", { event: "set_host" }, ({ payload }) => {
      if (!payload) return;
      Room.explicitHostId = payload.hostId || null;
      handleSync();
    });
    channel.on("broadcast", { event: "clear_host" }, () => {
      Room.explicitHostId = null;
      handleSync();
    });

    Room.channel = channel;
    await new Promise((resolve) => {
      channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") { await channel.track(myMeta()); resolve(true); }
      });
      setTimeout(() => resolve(false), 5000);
    });

    // rooms 행 변경 감지(설정/상태/명시적 방장 동기화)
    const dbCh = c.channel("roomdb:" + Room.code);
    dbCh.on("postgres_changes",
      { event: "*", schema: "public", table: "rooms", filter: "code=eq." + Room.code },
      (payload) => {
        if (payload.eventType === "DELETE") return;
        const row = payload.new || {};
        if (Room.data) Room.data = Object.assign({}, Room.data, row);
        if (row.explicit_host !== undefined) {
          Room.explicitHostId = row.explicit_host || null;
          handleSync();
        }
      });
    Room.dbChannel = dbCh;
    await new Promise((resolve) => { dbCh.subscribe(() => resolve(true)); setTimeout(() => resolve(false), 5000); });

    return true;
  }

  // 재연결/탭 복귀 시 fresh 데이터로 다시 track (stale presence 방지)
  async function retrack() {
    if (!Room.channel) return;
    Room.myName = resolveMyName();
    try { await Room.channel.track(myMeta()); } catch (e) {}
  }

  async function disconnectChannel(keepList) {
    const c = client();
    if (c && Room.channel) { try { await Room.channel.untrack(); } catch (e) {} try { await c.removeChannel(Room.channel); } catch (e) {} }
    if (c && Room.dbChannel) { try { await c.removeChannel(Room.dbChannel); } catch (e) {} }
    Room.channel = null; Room.dbChannel = null;
    if (!keepList) { Room.players = []; lastHostId = undefined; }
  }

  /* ---------- 방 생성 ---------- */
  async function createRoom() {
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요. 잠시 후 다시 시도해주세요." };
    Room.myName = resolveMyName();
    Room.explicitHostId = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode(6);
      const row = {
        code, host_id: myId(), host_name: Room.myName,
        region: (typeof State !== "undefined" && State.region) ? State.region : "seoul",
        mode: "all", duration_sec: 90, status: "waiting", explicit_host: null,
      };
      const { error } = await c.from("rooms").insert(row);
      if (!error) {
        Room.code = code; Room.data = row;
        await connectChannel();
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
    Room.explicitHostId = data.explicit_host || null;
    await connectChannel();
    return { ok: true, code };
  }

  /* ---------- 수동 위임 ---------- */
  async function transferHost(newHostId) {
    if (!Room.code || !isHost()) return { ok: false };
    const target = Room.players.find(p => p.id === newHostId);
    if (!target) return { ok: false };
    Room.explicitHostId = newHostId;
    // 즉시성 보강 브로드캐스트 + DB 기록(재접속 복원용)
    if (Room.channel) { try { await Room.channel.send({ type: "broadcast", event: "set_host", payload: { hostId: newHostId } }); } catch (e) {} }
    const c = client();
    if (c) { try { await c.from("rooms").update({ explicit_host: newHostId, host_id: newHostId, host_name: target.name }).eq("code", Room.code); } catch (e) {} }
    handleSync();
    return { ok: true };
  }

  /* ---------- 방 나가기 (버튼 전용) ---------- */
  async function leaveRoom() {
    const c = client();
    const wasHost = isHost();
    const others = (Room.players || []).filter(p => p.id !== myId());

    // 내가 명시적 방장이었다면, 나가면서 그 지정을 해제(다음 규칙으로 자동 승계되도록)
    if (Room.explicitHostId === myId()) {
      if (Room.channel) { try { await Room.channel.send({ type: "broadcast", event: "clear_host" }); } catch (e) {} }
      if (c && Room.code) { try { await c.from("rooms").update({ explicit_host: null }).eq("code", Room.code); } catch (e) {} }
    }

    await disconnectChannel();

    // 아무도 안 남으면 방 삭제
    if (c && Room.code && others.length === 0) {
      try { await c.from("rooms").delete().eq("code", Room.code); } catch (e) {}
    }
    Room.code = null; Room.data = null; Room.players = []; Room.explicitHostId = null; lastHostId = undefined;
  }

  // 새로고침/창닫기 직전: presence에서 즉시 이탈(동기 시도). 남은 사람이 규칙으로 자동 승계.
  function quickLeave() { try { if (Room.channel) Room.channel.untrack(); } catch (e) {} }

  return {
    Room,
    makeCode, guestName, resolveMyName, myThemeLine, inviteLink, myId,
    createRoom, joinRoom, leaveRoom, transferHost, quickLeave, retrack,
    onPlayersChange, onHostChange, getPlayers: () => Room.players,
    isHost, getHostId,
  };
})();
