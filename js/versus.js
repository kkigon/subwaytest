/* ============================================================
   versus.js — 대전 모드 (1단계: 방 생성 / 입장 / 대기실 뼈대)
   ------------------------------------------------------------
   - Supabase의 rooms 테이블로 방을 만들고 코드로 입장한다.
   - 실시간 참가자/게임 동기화(Presence/Broadcast)는 다음 단계에서 추가.
   - Account.getClient() 로 Supabase 클라이언트를 빌려 쓴다.
   ============================================================ */

const Versus = (() => {
  const $ = sel => document.querySelector(sel);

  // 현재 방 상태 (이 단계에서는 최소한만)
  const Room = {
    code: null,
    isHost: false,
    myName: null,       // 화면에 보일 내 이름 (닉네임 또는 Guest #1234)
    data: null,         // rooms 테이블의 행
  };

  function client() { return Account.getClient ? Account.getClient() : null; }

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
    return { ok: true, code };
  }

  /* ---------- 방 나가기 ---------- */
  async function leaveRoom() {
    const c = client();
    // 방장이 나가면 방 삭제(이 단계 한정 간단 처리). 참가자면 그냥 떠남.
    if (c && Room.code && Room.isHost) {
      await c.from("rooms").delete().eq("code", Room.code);
    }
    Room.code = null; Room.isHost = false; Room.data = null;
  }

  return {
    Room,
    makeCode, guestName, resolveMyName, myThemeLine, inviteLink,
    createRoom, joinRoom, leaveRoom,
  };
})();
