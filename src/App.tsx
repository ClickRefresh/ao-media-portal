import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
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
  Pencil,
  Play,
  RotateCcw,
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
import {
  getDownloadUrl,
  listMedia,
  mediaApiConfigured,
  restoreMedia,
  trashMedia,
  updateMediaMetadata,
  uploadMedia,
} from './api'
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

const formatStorage = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes ? 1 : 0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

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
  const [activeCollection, setActiveCollection] = useState<string | null>(null)
  const [media, setMedia] = useState<MediaItem[]>(() =>
    mediaApiConfigured ? [] : initialMedia,
  )
  const [trashItems, setTrashItems] = useState<MediaItem[]>([])
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | MediaKind>('all')
  const [view, setView] = useState<ViewMode>('grid')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [activeMenu, setActiveMenu] = useState<string | null>(null)
  const [editItem, setEditItem] = useState<MediaItem | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
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

  const refreshTrash = useCallback(async () => {
    if (!mediaApiConfigured) return
    try {
      setTrashItems(await listMedia('trash'))
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to load Trash.')
    }
  }, [])

  useEffect(() => {
    // The S3 library is external state and is synchronized after authentication.
    if (authStatus === 'signed-in') {
      // oxlint-disable-next-line react/set-state-in-effect
      void refreshMedia()
      // oxlint-disable-next-line react/set-state-in-effect
      void refreshTrash()
    }
  }, [authStatus, refreshMedia, refreshTrash])

  const visibleMedia = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const sectionItems = section === 'Trash' ? trashItems : media
    return sectionItems.filter((item) => {
      const matchesSection = section !== 'Favorites' || item.favorite
      const matchesCollection = section !== 'Collections' || !activeCollection || item.collection === activeCollection
      const matchesKind = kind === 'all' || item.kind === kind
      const searchable = [item.name, item.collection, item.caption ?? '', ...item.tags].join(' ').toLowerCase()
      return matchesSection && matchesCollection && matchesKind && (!normalized || searchable.includes(normalized))
    })
  }, [activeCollection, kind, media, query, section, trashItems])
  const storedBytes = useMemo(() => media.reduce((total, item) => total + (item.bytes ?? 0), 0), [media])
  const collectionCount = useMemo(() => new Set(media.map((item) => item.collection)).size, [media])
  const sidebarCollections = useMemo(() => {
    if (!mediaApiConfigured) return collections

    const counts = new Map<string, number>()
    media.forEach((item) => counts.set(item.collection, (counts.get(item.collection) ?? 0) + 1))
    const fallbackColors = ['#2d6f92', '#3e6f52', '#985240', '#7e663a']

    return Array.from(counts, ([name, count], index) => ({
      name,
      count,
      color: collections.find((collection) => collection.name === name)?.color
        ?? fallbackColors[index % fallbackColors.length],
    }))
  }, [media])

  const toggleFavorite = async (item: MediaItem) => {
    const favorite = !item.favorite
    setMedia((items) => items.map((current) => current.id === item.id ? { ...current, favorite } : current))
    if (!item.key || !mediaApiConfigured) return
    try {
      await updateMediaMetadata(item.key, { favorite })
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to update this favorite.')
      await refreshMedia()
    }
  }

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const refreshAllMedia = async () => {
    await Promise.all([refreshMedia(), refreshTrash()])
  }

  const downloadItem = async (item: MediaItem) => {
    if (!item.key) return
    setStorageError(null)
    setActiveMenu(null)
    try {
      const url = await getDownloadUrl(item.key)
      const link = document.createElement('a')
      link.href = url
      link.download = item.name
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to download this file.')
    }
  }

  const moveItem = async (item: MediaItem, restore: boolean) => {
    if (!item.key || actionLoading) return
    setActionLoading(true)
    setStorageError(null)
    setActiveMenu(null)
    try {
      if (restore) await restoreMedia(item.key)
      else await trashMedia(item.key)
      setSelected((current) => {
        const next = new Set(current)
        next.delete(item.id)
        return next
      })
      await refreshAllMedia()
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to move this file.')
    } finally {
      setActionLoading(false)
    }
  }

  const actOnSelected = async (action: 'download' | 'trash' | 'restore') => {
    const source = section === 'Trash' ? trashItems : media
    const items = source.filter((item) => selected.has(item.id))
    if (!items.length || actionLoading) return

    if (action === 'download') {
      for (const item of items) await downloadItem(item)
      return
    }

    setActionLoading(true)
    setStorageError(null)
    try {
      for (const item of items) {
        if (!item.key) continue
        if (action === 'restore') await restoreMedia(item.key)
        else await trashMedia(item.key)
      }
      setSelected(new Set())
      await refreshAllMedia()
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to move the selected files.')
    } finally {
      setActionLoading(false)
    }
  }

  const saveMetadata = async (item: MediaItem, updates: { displayName: string; collection: string; tags: string[]; caption: string }) => {
    if (!item.key || actionLoading) return
    setActionLoading(true)
    setStorageError(null)
    try {
      await updateMediaMetadata(item.key, updates)
      await refreshAllMedia()
      setEditItem(null)
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to save media details.')
    } finally {
      setActionLoading(false)
    }
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
                setActiveCollection(null)
                setSelected(new Set())
                setActiveMenu(null)
                setSidebarOpen(false)
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="collection-nav">
          <div className="nav-label-row">
            <span className="nav-label">Collections</span>
          </div>
          {sidebarCollections.slice(0, 4).map((collection) => (
            <button key={collection.name} className={section === 'Collections' && activeCollection === collection.name ? 'active' : ''} onClick={() => { setSection('Collections'); setActiveCollection(collection.name); setSelected(new Set()); setActiveMenu(null) }}>
              <span className="collection-dot" style={{ background: collection.color }} />
              <span>{collection.name}</span>
              <span className="collection-count">{collection.count}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="storage-label">
            <span>Storage</span>
            <strong>{mediaApiConfigured ? `${formatStorage(storedBytes)} stored` : '48.2 GB of 500 GB'}</strong>
          </div>
          {!mediaApiConfigured && <div className="storage-track"><span /></div>}
          <button className="team-link" onClick={() => { setSection('Team'); setSelected(new Set()); setActiveMenu(null) }}>
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
          {section === 'Library' || section === 'Collections' || section === 'Favorites' || section === 'Trash' ? (
            <>
              {(section === 'Library' || section === 'Favorites') && (
                <div className="summary-row">
                  <SummaryCard icon={FileImage} label="Media files" value={mediaApiConfigured ? String(media.length) : '1,284'} detail={mediaApiConfigured ? 'Private S3 objects' : '62 added this month'} />
                  <SummaryCard icon={FolderClosed} label="Collections" value={mediaApiConfigured ? String(collectionCount) : '18'} detail={mediaApiConfigured ? 'In the current library' : 'Across 10 rivers'} />
                  <SummaryCard icon={HardDrive} label="Storage used" value={mediaApiConfigured ? formatStorage(storedBytes) : '9.6%'} detail={mediaApiConfigured ? 'Current loaded objects' : '48.2 GB of 500 GB'} />
                </div>
              )}

              <div className="section-heading">
                <div>
                  <h2>{section === 'Favorites' ? 'Favorite media' : section === 'Trash' ? 'Recoverable media' : section === 'Collections' ? activeCollection ?? 'All collections' : 'All media'}</h2>
                  <p>{storageLoading ? 'Loading private S3 library…' : `${visibleMedia.length} items shown · ${section === 'Trash' ? 'Restore items to return them to the library' : 'Updated moments ago'}`}</p>
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
                  {section !== 'Trash' && <button disabled={actionLoading} onClick={() => void actOnSelected('download')}><Download size={16} /> Download</button>}
                  <button disabled={actionLoading} onClick={() => void actOnSelected(section === 'Trash' ? 'restore' : 'trash')}>
                    {section === 'Trash' ? <RotateCcw size={16} /> : <Trash2 size={16} />}
                    {section === 'Trash' ? 'Restore' : 'Move to trash'}
                  </button>
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
                      onFavorite={() => void toggleFavorite(item)}
                      menuOpen={activeMenu === item.id}
                      inTrash={section === 'Trash'}
                      disabled={actionLoading}
                      onToggleMenu={() => setActiveMenu((current) => current === item.id ? null : item.id)}
                      onDownload={() => void downloadItem(item)}
                      onEdit={() => { setActiveMenu(null); setEditItem(item) }}
                      onTrash={() => void moveItem(item, false)}
                      onRestore={() => void moveItem(item, true)}
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
            try {
              for (const file of files) await uploadMedia(file)
            } finally {
              await refreshMedia()
            }
            setUploadOpen(false)
            setSection('Library')
          }}
        />
      )}

      {editItem && (
        <MetadataModal
          item={editItem}
          collectionNames={sidebarCollections.map((collection) => collection.name)}
          saving={actionLoading}
          onClose={() => setEditItem(null)}
          onSave={(updates) => void saveMetadata(editItem, updates)}
        />
      )}
    </div>
  )
}

function SummaryCard({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  return <article className="summary-card"><div className="summary-icon"><Icon size={20} /></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>
}

function MediaCard({ item, listView, selected, menuOpen, inTrash, disabled, onSelect, onFavorite, onToggleMenu, onDownload, onEdit, onTrash, onRestore }: { item: MediaItem; listView: boolean; selected: boolean; menuOpen: boolean; inTrash: boolean; disabled: boolean; onSelect: () => void; onFavorite: () => void; onToggleMenu: () => void; onDownload: () => void; onEdit: () => void; onTrash: () => void; onRestore: () => void }) {
  return (
    <article className={`media-card ${selected ? 'selected' : ''}`}>
      <div className="media-preview">
        {item.kind === 'video' ? <video src={item.src} muted preload="metadata" /> : <img src={item.src} alt="" />}
        <label className="select-control"><input type="checkbox" checked={selected} onChange={onSelect} /><span /></label>
        {!inTrash && <button className={`favorite-button ${item.favorite ? 'active' : ''}`} onClick={onFavorite} aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}><Heart size={17} fill={item.favorite ? 'currentColor' : 'none'} /></button>}
        {item.kind === 'video' && <span className="video-badge"><Play size={13} fill="currentColor" /> Video</span>}
      </div>
      <div className="media-info">
        <div className="media-title-row">
          <div><strong>{item.name}</strong><span>{item.collection}</span></div>
          <button aria-label="More actions" aria-expanded={menuOpen} onClick={onToggleMenu}><MoreHorizontal size={19} /></button>
        </div>
        {menuOpen && (
          <div className="media-actions-menu">
            {!inTrash && <button disabled={disabled} onClick={onDownload}><Download size={15} /> Download</button>}
            {!inTrash && <button disabled={disabled} onClick={onEdit}><Pencil size={15} /> Edit details</button>}
            <button disabled={disabled} onClick={inTrash ? onRestore : onTrash}>
              {inTrash ? <RotateCcw size={15} /> : <Trash2 size={15} />}
              {inTrash ? 'Restore to library' : 'Move to trash'}
            </button>
          </div>
        )}
        {item.caption && <p className="media-caption">{item.caption}</p>}
        <div className="tag-row">{item.tags.slice(0, listView ? 3 : 2).map((tag) => <span key={tag}>{tag}</span>)}</div>
        <div className="media-meta"><span>{item.dimensions}</span><span>{item.size}</span><span>{item.uploaded}</span></div>
      </div>
    </article>
  )
}

function MetadataModal({ item, collectionNames, saving, onClose, onSave }: { item: MediaItem; collectionNames: string[]; saving: boolean; onClose: () => void; onSave: (updates: { displayName: string; collection: string; tags: string[]; caption: string }) => void }) {
  const [displayName, setDisplayName] = useState(item.name)
  const [collection, setCollection] = useState(item.collection)
  const [tags, setTags] = useState(item.tags.join(', '))
  const [caption, setCaption] = useState(item.caption ?? '')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const cleanTags = tags.split(',').map((tag) => tag.trim()).filter(Boolean)
    onSave({ displayName: displayName.trim(), collection: collection.trim(), tags: cleanTags, caption: caption.trim() })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) onClose() }}>
      <form className="metadata-modal" onSubmit={submit}>
        <header><div><span className="eyebrow">Library details</span><h2>Edit media</h2></div><button type="button" onClick={onClose} disabled={saving} aria-label="Close editor"><X /></button></header>
        <label><span>Display name</span><input required maxLength={180} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label><span>Collection</span><input required maxLength={80} list="collection-options" value={collection} onChange={(event) => setCollection(event.target.value)} /><datalist id="collection-options">{collectionNames.map((name) => <option key={name} value={name} />)}</datalist></label>
        <label><span>Tags <small>Separate with commas; up to 10</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="rafting, summer, website" /></label>
        <label><span>Caption</span><textarea maxLength={1000} rows={4} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Add context, location, people, or usage notes…" /></label>
        <footer><button type="button" className="secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="primary" disabled={saving || !displayName.trim() || !collection.trim()}>{saving ? 'Saving…' : 'Save details'}</button></footer>
      </form>
    </div>
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
