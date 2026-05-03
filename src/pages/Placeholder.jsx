import { Construction } from 'lucide-react'

const wrap = {
  display: 'grid',
  placeItems: 'center',
  minHeight: 420,
}
const card = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: '40px 56px',
  textAlign: 'center',
  maxWidth: 560,
}
const iconWrap = {
  width: 56,
  height: 56,
  borderRadius: 14,
  margin: '0 auto 18px',
  display: 'grid',
  placeItems: 'center',
  background: 'linear-gradient(135deg, var(--red), var(--red-dark))',
  color: '#fff',
  boxShadow: '0 8px 22px rgba(239,68,68,0.3)',
}
const title = {
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  fontWeight: 700,
  marginBottom: 10,
  color: 'var(--text)',
}
const hint = { color: 'var(--muted)', fontSize: 14, lineHeight: 1.6 }

export default function Placeholder({ title: t, hint: h }) {
  return (
    <div style={wrap} className="fade-up">
      <div style={card}>
        <div style={iconWrap}><Construction size={26} strokeWidth={2.2} /></div>
        <div style={title}>{t}</div>
        <div style={hint}>{h}</div>
      </div>
    </div>
  )
}
