// Canonical pool of HeyGen v4 motion / gesture prompts. Each segment
// sent to HeyGen gets ONE of these as its `motion_prompt` so the avatar
// renders with intentional, varied body language instead of HeyGen's
// default talking-head loop.
//
// Selection is DETERMINISTIC by segment_index (modulo pool length) so:
//   - Re-renders of the same segment use the same prompt (stable
//     output, no "why does this look different now" surprises).
//   - A 7-segment video gets 7 different gestures, varied naturally.
//   - Videos longer than 20 segments wrap; that's fine — pool is large
//     enough that adjacent segments never repeat.
//
// User-set or Claude-generated motion_gesture_prompt values take
// precedence. This pool is the fallback when the column is empty.

export const MOTION_GESTURE_POOL = [
  'Speaks naturally with relaxed shoulders, occasional hand gestures emphasizing key points.',
  'Maintains steady eye contact with camera, hands moving fluidly while explaining.',
  'Both hands gesture openly throughout, palms visible, conversational and engaged.',
  'Leans in slightly when emphasizing important moments, settles back during calmer points.',
  'Nods occasionally while speaking, head moves naturally with the rhythm of the words.',
  'Right hand counts off points on fingers as concepts build.',
  'Hands move at chest level with controlled, intentional gestures while explaining.',
  'Eyebrows lift naturally with emphasis, expression stays warm and engaged.',
  'Shoulders stay relaxed, hands occasionally rest on desk between gestures.',
  'Tilts head subtly while making thoughtful points, returns to center when explaining.',
  'Open palm gestures sweep outward when introducing new ideas.',
  'Index finger raises briefly when making a key distinction or callout.',
  'Both hands come together at chest then open outward when expanding on a concept.',
  'Light smile holds throughout, eyes stay locked on camera with confident presence.',
  'Hands gesture asymmetrically and naturally, never mirrored or stiff.',
  'Leans forward with focused intensity during important takeaways.',
  'Right hand traces a small arc in the air when describing flow or process.',
  'Settles into a confident posture, gestures stay close to body, calm and authoritative.',
  'Eyes occasionally glance off-camera briefly as if recalling, then return to lens.',
  'Expressive face leads the delivery, hands support with measured, purposeful movement.',
]

// Deterministic picker. Returns the same prompt every time for a given
// index — important for re-renders to be stable.
export function pickMotionGesture(segmentIndex) {
  const idx = Number.isFinite(segmentIndex) && segmentIndex >= 0
    ? Math.floor(segmentIndex)
    : 0
  return MOTION_GESTURE_POOL[idx % MOTION_GESTURE_POOL.length]
}
