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

  const refresh = useCallback(async () => {
    if (!user) {
      setProfiles([])
      return
    }
    setLoading(true)
    try {
      // Joins through profile_access to scope to this user.
      const { data, error } = await supabase
        .from('profile_access')
        .select('role, allowed_pages, profiles ( id, business_name, industry, brand_primary_color, logo_url, is_active )')
        .eq('user_id', user.id)
      if (error) throw error
      const list = (data || [])
        .map((row) => row.profiles ? { ...row.profiles, _role: row.role, _allowed_pages: row.allowed_pages } : null)
        .filter(Boolean)
      setProfiles(list)
      // ensure selected id is valid
      if (list.length && !list.find((p) => p.id === selectedProfileId)) {
        setSelectedProfileIdState(list[0].id)
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[ScaleSolo] profile refresh failed', e)
      setProfiles([])
    } finally {
      setLoading(false)
    }
  }, [user, selectedProfileId])

  useEffect(() => { refresh() }, [refresh])

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
