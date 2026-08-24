import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

const ProfileContext = createContext(null)
const STORAGE_KEY = 'scalesolo.profile.selectedId'

export function ProfileProvider({ children }) {
  const { user } = useAuth()
  const [profiles, setProfiles] = useState([])
  const [selectedProfileId, setSelectedProfileIdState] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || null } catch { return null }
  })
  const [loading, setLoading] = useState(false)

  // refresh() pulls the profile list. We deliberately don't depend on
  // selectedProfileId here — the auto-pick of a default ID is a side-effect
  // we want to run only when the list itself changes, not every time the
  // user switches brands. (Earlier version put selectedProfileId in deps,
  // which created an unnecessary refetch cycle on every switch.)
  const refresh = useCallback(async () => {
    if (!user) {
      setProfiles([])
      return
    }
    setLoading(true)
    try {
      // Select * on the nested profile row — the editor reads from this
      // same list when opening a row to edit, so a narrow column list
      // causes fields like always_include / do_not_say / brand_cta /
      // owner_name / handles to "save" but reappear empty on reopen
      // (the PATCH writes them fine; the next list refresh just doesn't
      // ask for them). No heavy columns live on this table — embeddings
      // are stored elsewhere — so * is cheap and future-proof.
      const { data, error } = await supabase
        .from('profile_access')
        .select('role, allowed_pages, profiles ( * )')
        .eq('user_id', user.id)
      if (error) throw error
      const list = (data || [])
        .map((row) => row.profiles ? { ...row.profiles, _role: row.role, _allowed_pages: row.allowed_pages } : null)
        .filter(Boolean)
      setProfiles(list)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[ScaleSolo] profile refresh failed', e)
      setProfiles([])
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => { refresh() }, [refresh])

  // A board-editor who just had a pending invite claimed on login → refetch the
  // brand list so their newly-granted board access appears without a reload.
  useEffect(() => {
    const onChange = () => refresh()
    window.addEventListener('scalesolo:access-changed', onChange)
    return () => window.removeEventListener('scalesolo:access-changed', onChange)
  }, [refresh])

  // After the list lands, ensure selectedProfileId points at a real row.
  // Runs once per list change, doesn't refetch.
  useEffect(() => {
    if (profiles.length === 0) return
    if (!selectedProfileId || !profiles.find((p) => p.id === selectedProfileId)) {
      setSelectedProfileIdState(profiles[0].id)
    }
  }, [profiles, selectedProfileId])

  const setSelectedProfileId = useCallback((id) => {
    setSelectedProfileIdState(id)
    try { localStorage.setItem(STORAGE_KEY, id) } catch {}
  }, [])

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) || null

  return (
    <ProfileContext.Provider
      value={{
        profiles,
        selectedProfile,
        selectedProfileId,
        setSelectedProfileId,
        refresh,
        loading,
      }}
    >
      {children}
    </ProfileContext.Provider>
  )
}

export function useProfile() {
  const ctx = useContext(ProfileContext)
  if (!ctx) throw new Error('useProfile must be used inside a ProfileProvider')
  return ctx
}
