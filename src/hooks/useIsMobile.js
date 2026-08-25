import { useEffect, useState } from 'react'

// Reactive "is this a phone-width viewport" flag, shared across pages that need
// a JS mobile branch (inline styles can't be hit by media queries). The
// Schedule page (Content.jsx) has its own module-local copy for historical
// reasons; new pages import this one. Default 768px matches the app shell's
// mobile breakpoint family.
export default function useIsMobile(maxWidth = 768) {
  const [is, setIs] = useState(() => typeof window !== 'undefined' && window.matchMedia(`(max-width:${maxWidth}px)`).matches)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${maxWidth}px)`)
    const on = () => setIs(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [maxWidth])
  return is
}
