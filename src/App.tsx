import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ChevronDown,
  Download,
  FileImage,
  FolderClosed,
  Grid2X2,
  HardDrive,
  Heart,
  LayoutDashboard,
  List,
  LogOut,
  Menu,
  MoreHorizontal,
  Play,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Hub } from 'aws-amplify/utils'
import {
  beginSignIn,
  cognitoConfigured,
  demoMode,
  endSession,
  getPortalUser,
  type PortalUser,
} from './auth'
import { listMedia, mediaApiConfigured, uploadMedia } from './api'
import { collections, initialMedia, type MediaItem, type MediaKind } from './media'
import './App.css'

type AuthStatus = 'loading' | 'demo' | 'signed-in' | 'signed-out' | 'unconfigured'
type ViewMode = 'grid' | 'list'
type Section = 'Library' | 'Collections' | 'Favorites' | 'Uploads' | 'Trash' | 'Team'

const navItems: { label: Section; icon: LucideIcon }[] = [
  { label: 'Library', icon: LayoutDashboard },
  { label: 'Collections', icon: FolderClosed },
  { label: 'Favorites', icon: Heart },
  { label: 'Uploads', icon: Upload },
  { label: 'Trash', icon: Trash2 },
]

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>(() =>
    demoMode ? 'demo' : cognitoConfigured ? 'loading' : 'unconfigured',
  )
  const [user, setUser] = useState<PortalUser | null>(() =>
    demoMode
      ? { username: 'preview-user', email: 'sammy@click-refresh.com', initials: 'SR' }
      : null,
  )
  const [section, setSection] = useState<Section>('Library')
  const [media, setMedia] = useState<MediaItem[]>(initialMedia)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | MediaKind>('all')
  const [view, setView] = useState<ViewMode>('grid')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [storageLoading, setStorageLoading] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)

  const refreshUser = async () => {
    const currentUser = await getPortalUser()
    setUser(currentUser)
    setAuthStatus(currentUser ? 'signed-in' : 'signed-out')

    if (currentUser && window.location.pathname === '/auth/callback') {
      window.history.replaceState({}, document.title, '/')
    }
  }

  useEffect(() => {
    if (demoMode || !cognitoConfigured) return

    // Initial authentication is external state, so it must be synchronized after mount.
    // oxlint-disable-next-line react/set-state-in-effect
    void refreshUser()
    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn' || payload.event === 'signedOut') {
        void refreshUser()
      }
    })
    return unsubscribe
  }, [])

  const refreshMedia = useCallback(async () => {
    if (!mediaApiConfigured) return
    setStorageLoading(true)
    setStorageError(null)
    try {
      setMedia(await listMedia())
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to load S3 media.')
    } finally {
      setStorageLoading(false)
    }
  }, [])

  useEffect(() => {
    // The S3 library is external state and is synchronized after authentication.
    // oxlint-disable-next-line react/set-state-in-effect
    if (authStatus === 'signed-in') void refreshMedia()
  }, [authStatus, refreshMedia])

  const visibleMedia = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return media.filter((item) => {
      const matchesSection = section !== 'Favorites' || item.favorite
      const matchesKind = kind === 'all' || item.kind === kind
      const searchable = [item.name, item.collection, ...item.tags].join(' ').toLowerCase()
      return matchesSection && matchesKind && (!normalized || searchable.includes(normalized))
    })
  }, [kind, media, query, section])

  const toggleFavorite = (id: string) => {
    setMedia((items) =>
      items.map((item) => (item.id === id ? { ...item, favorite: !item.favorite } : item)),
    )
  }

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (authStatus === 'loading') return <LoadingScreen />
  if (authStatus === 'unconfigured') return <ConfigurationScreen />
  if (authStatus === 'signed-out') return <SignInScreen />

  return (
    <div className="portal-shell">
      <aside className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`}>
        <div className="brand-lockup">
          <img src="/ao-logo.webp" alt="All-Outdoors" />
          <div>
            <strong>Media Portal</strong>
            <span>Staff library</span>
          </div>
          <button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
            <X size={20} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          <span className="nav-label">Workspace</span>
          {navItems.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={section === label ? 'active' : ''}
              onClick={() => {
                setSection(label)
                setSidebarOpen(false)
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {label === 'Uploads' && <span className="nav-count">3</span>}
            </button>
          ))}
        </nav>

        <div className="collection-nav">
          <div className="nav-label-row">
            <span className="nav-label">Collections</span>
            <button aria-label="Create collection">+</button>
          </div>
          {collections.slice(0, 4).map((collection) => (
            <button key={collection.name} onClick={() => setSection('Collections')}>
              <span className="collection-dot" style={{ background: collection.color }} />
              <span>{collection.name}</span>
              <span className="collection-count">{collection.count}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="storage-label">
            <span>Storage</span>
            <strong>48.2 GB of 500 GB</strong>
          </div>
          <div className="storage-track"><span /></div>
          <button className="team-link" onClick={() => setSection('Team')}>
            <Users size={18} /> Team & access
          </button>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close menu" />}

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-leading">
            <button className="menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open menu"><Menu /></button>
            <div>
              <span className="eyebrow">AO Media Library</span>
              <h1>{section}</h1>
            </div>
          </div>
          <div className="topbar-actions">
            <div className="global-search">
              <Search size={18} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search photos, videos, tags…" />
              <kbd>⌘ K</kbd>
            </div>
            <button className="upload-button" onClick={() => setUploadOpen(true)}><Upload size={18} /> Upload</button>
            <div className="profile-wrap">
              <button className="avatar-button" onClick={() => setProfileOpen((open) => !open)} aria-expanded={profileOpen}>
                <span>{user?.initials ?? 'AO'}</span><ChevronDown size={14} />
              </button>
              {profileOpen && (
                <div className="profile-menu">
                  <div><strong>{user?.email}</strong><span>{authStatus === 'demo' ? 'Preview session' : 'Authenticated staff'}</span></div>
                  <button><Settings size={16} /> Account settings</button>
                  <button onClick={() => void endSession()}><LogOut size={16} /> Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>

        {authStatus === 'demo' && (
          <div className="preview-banner"><Sparkles size={16} /><span><strong>Preview mode</strong> — changes stay in this browser until the S3 API is connected.</span></div>
        )}
        {storageError && (
          <div className="storage-error"><span>{storageError}</span><button onClick={() => void refreshMedia()}>Try again</button></div>
        )}

        <section className="content-area">
          {section === 'Library' || section === 'Favorites' ? (
            <>
              <div className="summary-row">
                <SummaryCard icon={FileImage} label="Media files" value="1,284" detail="62 added this month" />
                <SummaryCard icon={FolderClosed} label="Collections" value="18" detail="Across 10 rivers" />
                <SummaryCard icon={HardDrive} label="Storage used" value="9.6%" detail="48.2 GB of 500 GB" />
              </div>

              <div className="section-heading">
                <div>
                  <h2>{section === 'Favorites' ? 'Favorite media' : 'All media'}</h2>
                  <p>{storageLoading ? 'Loading private S3 library…' : `${visibleMedia.length} items shown · Updated moments ago`}</p>
                </div>
                <div className="media-tools">
                  <div className="filter-tabs" role="group" aria-label="Filter by media type">
                    {(['all', 'photo', 'video'] as const).map((value) => (
                      <button key={value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>
                        {value === 'all' ? 'All' : value === 'photo' ? 'Photos' : 'Videos'}
                      </button>
                    ))}
                  </div>
                  <button className="icon-button labeled"><SlidersHorizontal size={17} /> Filter</button>
                  <div className="view-toggle">
                    <button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="Grid view"><Grid2X2 size={17} /></button>
                    <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="List view"><List size={18} /></button>
                  </div>
                </div>
              </div>

              {selected.size > 0 && (
                <div className="selection-bar">
                  <strong>{selected.size} selected</strong>
                  <button><Download size={16} /> Download</button>
                  <button><Archive size={16} /> Move</button>
                  <button onClick={() => setSelected(new Set())}>Clear</button>
                </div>
              )}

              {visibleMedia.length ? (
                <div className={`media-grid media-grid--${view}`}>
                  {visibleMedia.map((item) => (
                    <MediaCard
                      key={item.id}
                      item={item}
                      listView={view === 'list'}
                      selected={selected.has(item.id)}
                      onSelect={() => toggleSelected(item.id)}
                      onFavorite={() => toggleFavorite(item.id)}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState query={query} section={section} onClear={() => { setQuery(''); setKind('all') }} />
              )}
            </>
          ) : (
            <SectionPlaceholder section={section} onUpload={() => setUploadOpen(true)} />
          )}
        </section>
      </main>

      {uploadOpen && (
        <UploadModal
          connected={mediaApiConfigured}
          onClose={() => setUploadOpen(false)}
          onAdd={(items) => {
            setMedia((current) => [...items, ...current])
            setUploadOpen(false)
            setSection('Library')
          }}
          onUpload={async (files) => {
            for (const file of files) await uploadMedia(file)
            await refreshMedia()
            setUploadOpen(false)
            setSection('Library')
          }}
        />
      )}
    </div>
  )
}

function SummaryCard({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  return <article className="summary-card"><div className="summary-icon"><Icon size={20} /></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>
}

function MediaCard({ item, listView, selected, onSelect, onFavorite }: { item: MediaItem; listView: boolean; selected: boolean; onSelect: () => void; onFavorite: () => void }) {
  return (
    <article className={`media-card ${selected ? 'selected' : ''}`}>
      <div className="media-preview">
        {item.kind === 'video' ? <video src={item.src} muted preload="metadata" /> : <img src={item.src} alt="" />}
        <label className="select-control"><input type="checkbox" checked={selected} onChange={onSelect} /><span /></label>
        <button className={`favorite-button ${item.favorite ? 'active' : ''}`} onClick={onFavorite} aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}><Heart size={17} fill={item.favorite ? 'currentColor' : 'none'} /></button>
        {item.kind === 'video' && <span className="video-badge"><Play size={13} fill="currentColor" /> Video</span>}
      </div>
      <div className="media-info">
        <div className="media-title-row"><div><strong>{item.name}</strong><span>{item.collection}</span></div><button aria-label="More actions"><MoreHorizontal size={19} /></button></div>
        <div className="tag-row">{item.tags.slice(0, listView ? 3 : 2).map((tag) => <span key={tag}>{tag}</span>)}</div>
        <div className="media-meta"><span>{item.dimensions}</span><span>{item.size}</span><span>{item.uploaded}</span></div>
      </div>
    </article>
  )
}

function UploadModal({ connected, onClose, onAdd, onUpload }: { connected: boolean; onClose: () => void; onAdd: (items: MediaItem[]) => void; onUpload: (files: File[]) => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return
    setFiles((current) => [...current, ...Array.from(incoming)])
  }

  const addToPreview = () => {
    const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const items = files.map<MediaItem>((file, index) => ({
      id: `local-${Date.now()}-${index}`,
      name: file.name,
      kind: file.type.startsWith('video/') ? 'video' : 'photo',
      src: URL.createObjectURL(file),
      collection: 'Unsorted uploads',
      dimensions: file.type.startsWith('video/') ? 'Video preview' : 'Image preview',
      size: `${Math.max(file.size / 1024 / 1024, 0.1).toFixed(1)} MB`,
      uploaded: now,
      tags: ['new'],
    }))
    onAdd(items)
  }

  const submitFiles = async () => {
    if (!connected) return addToPreview()
    setUploading(true)
    setError(null)
    try {
      await onUpload(files)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed.')
      setUploading(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
        <header><div><span className="eyebrow">Add to library</span><h2 id="upload-title">Upload media</h2></div><button onClick={onClose} aria-label="Close upload"><X /></button></header>
        <div
          className={`drop-zone ${dragging ? 'dragging' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files) }}
        >
          <div className="drop-icon"><Upload size={24} /></div>
          <strong>Drop photos and videos here</strong>
          <p>JPG, PNG, WebP, HEIC, MP4 or MOV</p>
          <button onClick={() => inputRef.current?.click()}>Choose files</button>
          <input ref={inputRef} type="file" accept="image/*,video/*" multiple hidden onChange={(event) => addFiles(event.target.files)} />
        </div>
        {files.length > 0 && <div className="file-queue">{files.map((file, index) => <div key={`${file.name}-${index}`}><FileImage size={17} /><span><strong>{file.name}</strong><small>{Math.max(file.size / 1024 / 1024, 0.1).toFixed(1)} MB</small></span><button onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}><X size={16} /></button></div>)}</div>}
        <div className="upload-note"><ShieldCheck size={17} /><span>{connected ? 'Files upload directly to private S3 storage using a five-minute authorization.' : 'Preview mode keeps selected files in this browser. Configure the media API to enable private S3 uploads.'}</span></div>
        {error && <p className="upload-error">{error}</p>}
        <footer><button className="secondary" onClick={onClose} disabled={uploading}>Cancel</button><button className="primary" disabled={!files.length || uploading} onClick={() => void submitFiles()}>{uploading ? 'Uploading…' : connected ? `Upload ${files.length || ''} file${files.length === 1 ? '' : 's'}` : `Add ${files.length || ''} to preview`}</button></footer>
      </section>
    </div>
  )
}

function EmptyState({ query, section, onClear }: { query: string; section: Section; onClear: () => void }) {
  return <div className="empty-state"><Search size={28} /><h3>No media found</h3><p>{query ? `Nothing matches “${query}”.` : `There are no items in ${section.toLowerCase()} yet.`}</p><button onClick={onClear}>Clear filters</button></div>
}

function SectionPlaceholder({ section, onUpload }: { section: Section; onUpload: () => void }) {
  const copy: Record<'Collections' | 'Uploads' | 'Trash' | 'Team', { title: string; body: string; icon: LucideIcon }> = {
    Collections: { title: 'Organize media into collections', body: 'Group photos and videos by river, season, campaign, or trip.', icon: FolderClosed },
    Uploads: { title: 'Upload activity', body: 'Active, completed, and failed uploads will appear here.', icon: Upload },
    Trash: { title: 'Trash is empty', body: 'Deleted media will remain recoverable here before permanent removal.', icon: Trash2 },
    Team: { title: 'Team and access', body: 'Manage staff accounts and permissions through the secure admin service.', icon: Users },
  }
  const entry = copy[section as keyof typeof copy]
  const Icon = entry.icon
  return <div className="placeholder-panel"><div className="placeholder-icon"><Icon size={26} /></div><span className="eyebrow">{section}</span><h2>{entry.title}</h2><p>{entry.body}</p>{section === 'Uploads' && <button className="upload-button" onClick={onUpload}><Upload size={17} /> Upload media</button>}</div>
}

function LoadingScreen() {
  return <div className="standalone-screen"><div className="loading-mark"><img src="/ao-logo.webp" alt="All-Outdoors" /><span /></div><p>Opening your media library…</p></div>
}

function SignInScreen() {
  return (
    <div className="auth-screen">
      <div className="auth-photo" />
      <main className="auth-panel">
        <div className="auth-brand"><img src="/ao-logo.webp" alt="All-Outdoors" /><span>Media Portal</span></div>
        <div className="auth-copy"><span className="eyebrow">Staff access</span><h1>Your river stories,<br />all in one place.</h1><p>Search, organize, and share the photos and videos that tell the All-Outdoors story.</p><button onClick={() => void beginSignIn()}>Continue to secure sign in <span>→</span></button><small><ShieldCheck size={15} /> Protected by Amazon Cognito and multi-factor authentication</small></div>
        <footer>All-Outdoors California Whitewater Rafting · Internal use only</footer>
      </main>
    </div>
  )
}

function ConfigurationScreen() {
  return <div className="standalone-screen configuration"><img src="/ao-logo.webp" alt="All-Outdoors" /><div className="configuration-icon"><Settings /></div><h1>Portal configuration required</h1><p>Add the Cognito application values to the deployment environment before opening staff access.</p><code>Copy .env.example to .env.local for local setup</code><a href="https://github.com/ClickRefresh/ao-media-portal">View setup instructions</a></div>
}

export default App
