-- Split a studio_segments row in two at a character offset.
--
-- Usage:
--   select * from public.studio_split_segment('<segment uuid>', 42);
--
-- Behavior:
--   1. Lock the parent row.
--   2. Slice script_text at split_at_char into a prefix + suffix. Trim
--      whitespace from each piece. Both halves must be non-empty —
--      we don't want to create empty segments.
--   3. Shift every downstream segment's segment_index up by 1 so we
--      can slot the new segment at parent.segment_index + 1. The
--      unique constraint on (studio_video_id, segment_index) is
--      `deferrable initially deferred`, so a multi-row update inside
--      one transaction is safe even though intermediate states
--      temporarily duplicate indexes.
--   4. Insert the new segment with the suffix. Inherits segment_type
--      from the parent so b-roll / avatar / motion-graphics intent
--      stays. transition_in defaults to 'cut' (the user can change
--      it after via the dropdown). Asset URLs are blank, status is
--      'pending'.
--   5. Update the parent: shortened script_text, asset URLs cleared,
--      status reset to 'pending'. Re-generation is required on both
--      halves because the new audio + visuals depend on the new
--      script_text.
--
-- Returns both resulting segments (parent + new) ordered by
-- segment_index so the API can ship them back to the client and
-- Realtime catches up naturally.

create or replace function public.studio_split_segment(
  p_segment_id uuid,
  p_split_at int
) returns setof public.studio_segments
language plpgsql
security invoker
as $$
declare
  v_parent public.studio_segments;
  v_new_id uuid;
  v_prefix text;
  v_suffix text;
  v_full text;
  v_safe_split int;
begin
  -- Lock the parent so a concurrent edit can't fight us on indexes.
  select * into v_parent from public.studio_segments
  where id = p_segment_id for update;
  if not found then
    raise exception 'Segment % not found', p_segment_id;
  end if;

  v_full := coalesce(v_parent.script_text, '');
  v_safe_split := greatest(0, least(p_split_at, length(v_full)));
  v_prefix := btrim(substring(v_full from 1 for v_safe_split));
  v_suffix := btrim(substring(v_full from v_safe_split + 1));

  if length(v_prefix) = 0 or length(v_suffix) = 0 then
    raise exception 'Split point would produce an empty segment (prefix len=%, suffix len=%)',
      length(v_prefix), length(v_suffix);
  end if;

  -- Shift downstream indexes up by 1. Deferred unique constraint
  -- tolerates the temporary collision until commit.
  update public.studio_segments
    set segment_index = segment_index + 1, updated_at = now()
  where studio_video_id = v_parent.studio_video_id
    and segment_index > v_parent.segment_index;

  -- Insert the new segment with the suffix. Inherits brand-relevant
  -- defaults from the parent (segment_type, approved); clears all
  -- generated assets so the orchestrator regenerates them.
  insert into public.studio_segments (
    studio_video_id, profile_id, segment_index, segment_type,
    script_text, approved, transition_in, status
  ) values (
    v_parent.studio_video_id,
    v_parent.profile_id,
    v_parent.segment_index + 1,
    v_parent.segment_type,
    v_suffix,
    coalesce(v_parent.approved, true),
    'cut',
    'pending'
  ) returning id into v_new_id;

  -- Update the parent: shortened text + every asset / job-id / overlay
  -- field cleared so the next generation pass starts fresh on both
  -- halves.
  update public.studio_segments
    set script_text          = v_prefix,
        voice_url             = null,
        voice_duration_secs   = null,
        avatar_video_url      = null,
        image_prompt          = null,
        image_url             = null,
        kie_task_id           = null,
        heygen_video_id       = null,
        overlay_placements    = null,
        rendered_chunk_url    = null,
        voice_source_start_secs = null,
        voice_source_end_secs   = null,
        status                = 'pending',
        error                 = null,
        updated_at            = now()
  where id = p_segment_id;

  return query
    select * from public.studio_segments
    where id in (p_segment_id, v_new_id)
    order by segment_index;
end;
$$;

-- Allow authenticated users to call this. The function uses
-- security invoker so RLS on studio_segments still applies — a user
-- who can't see the row can't split it.
grant execute on function public.studio_split_segment(uuid, int) to authenticated;
