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
      const { data, error } = await supabase
        .from('profile_access')
        .select('role, allowed_pages, profiles ( id, business_name, industry, brand_primary_color, brand_secondary_color, logo_url, is_active, synced_platforms, timezone, preferred_tone, target_audience, core_hashtags, brand_bible, polish_template, cover_template )')
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
