-- Per-brand visual style controls. Drives every image_prompt + future
-- video_prompt the studio writes so b-roll matches the brand's
-- aesthetic instead of defaulting to Claude's "sleek AI futuristic"
-- bias.
--
-- visual_style_guide  — free-form 1–3 sentence description of the
--   look. Becomes the primary STYLE block in the segmentation prompt
--   and the worker's hard-appended anchor.
--   Example for Vernon Tech & Media:
--     "Business documentary aesthetic. Clean modern office settings,
--      focused professionals in conversation, soft natural lighting.
--      Editorial feel like a Bloomberg spread, not a tech demo."
--
-- visual_keywords  — short tags that ALWAYS get appended to image
--   prompts. The worker adds these as a "Style: ..." trailer even
--   when Claude forgets.
--   Example: {"modern editorial", "natural lighting", "shallow depth of field"}
--
-- visual_avoid  — explicit do-not-render list. Worker appends as
--   "Avoid: ..." to every image prompt. Claude also sees this in
--   the system prompt so it doesn't even propose those things.
--   Example: {"futuristic AI graphics", "holographic displays",
--   "neon", "cyberpunk", "sci-fi", "abstract digital effects"}

alter table public.profiles
  add column if not exists visual_style_guide text,
  add column if not exists visual_keywords text[] not null default '{}',
  add column if not exists visual_avoid    text[] not null default '{}';
