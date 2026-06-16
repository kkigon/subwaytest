-- ============================================================
--  대전 모드 — 1단계: 방(rooms) 테이블
--  사용법: Supabase 대시보드 → SQL Editor → New query
--           → 이 파일 전체 붙여넣고 → Run
-- ------------------------------------------------------------
--  이 단계에서는 "방 생성 / 코드로 입장"까지만 다룬다.
--  실시간 참가자/게임 동기화는 다음 단계에서 Realtime으로 추가.
-- ============================================================

create table if not exists public.rooms (
  code         text primary key,                 -- 방 코드 (예: 'K7Q2M9') — 사람이 입력/공유
  host_id      uuid,                              -- 방장 (로그인 사용자면 user id, 게스트면 null)
  host_name    text not null,                     -- 방장 표시 이름 (닉네임 또는 'Guest #1234')
  region       text not null default 'seoul',     -- 'seoul' | 'busan'
  mode         text not null default 'all',       -- 'core' | 'all' | 'custom'
  custom_lines text,                              -- 커스텀일 때 노선 id들(콤마구분), 아니면 null
  duration_sec integer not null default 90,       -- 한 게임 제한시간(초)
  status       text not null default 'waiting',   -- 'waiting' | 'playing' | 'ended'
  created_at   timestamptz not null default now()
);

-- 오래된 방 정리를 쉽게 하기 위한 인덱스 (생성시각)
create index if not exists rooms_created_idx on public.rooms (created_at);

-- ============================================================
--  RLS: 방은 코드를 아는 사람이 자유롭게 다루는 구조(친구끼리 대전).
--  로그인 여부와 무관하게 동작해야 하므로 익명(anon)도 허용한다.
--  (민감 정보가 없고, 코드 자체가 일종의 비밀번호 역할)
-- ============================================================
alter table public.rooms enable row level security;

-- 누구나 방을 조회할 수 있음 (코드로 입장하려면 읽기가 필요)
drop policy if exists "rooms_select_all" on public.rooms;
create policy "rooms_select_all" on public.rooms
  for select using (true);

-- 누구나 방을 생성할 수 있음
drop policy if exists "rooms_insert_all" on public.rooms;
create policy "rooms_insert_all" on public.rooms
  for insert with check (true);

-- 누구나 방 설정을 변경할 수 있음 (방장 권한은 프론트엔드에서 통제)
-- (다음 단계에서 더 엄격히 조일 수 있음)
drop policy if exists "rooms_update_all" on public.rooms;
create policy "rooms_update_all" on public.rooms
  for update using (true) with check (true);

-- 누구나 방을 삭제할 수 있음 (방장이 나갈 때 등)
drop policy if exists "rooms_delete_all" on public.rooms;
create policy "rooms_delete_all" on public.rooms
  for delete using (true);
