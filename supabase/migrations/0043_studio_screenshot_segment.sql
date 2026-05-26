-- Add 'screenshot' to the studio_segments.segment_type CHECK constraint.
--
-- A screenshot segment is a voiceover paired with a user-uploaded image
-- (product UI, dashboard, etc.) rendered inside a template-styled
-- device frame. The avatar is heard but not shown — the screenshot
-- fills the frame so viewers can read the UI clearly.
--
-- Storage reuses studio_segments.image_url for the uploaded screenshot
-- (same column as Kie-generated b-roll). The render worker branches on
-- segment_type=screenshot to pick the {template}-scene-screenshot-v1
-- composition instead of letting Claude choose one.

alter table public.studio_segments
  drop constraint if exists studio_segments_segment_type_check;

alter table public.studio_segments
  add constraint studio_segments_segment_type_check
  check (segment_type in (
    'avatar',
    'voiceover_broll',
    'voiceover_motion_graphics',
    'pure_motion_graphics',
    'screenshot'
  ));
