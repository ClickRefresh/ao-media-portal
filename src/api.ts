import { fetchAuthSession } from 'aws-amplify/auth'
import { createSHA256 } from 'hash-wasm'
import type { MediaItem } from './media'

const configuredApiUrl = import.meta.env.VITE_API_BASE_URL?.trim()

export const mediaApiConfigured = Boolean(
  configuredApiUrl && !configuredApiUrl.startsWith('replace-'),
)

const apiBaseUrl = configuredApiUrl?.replace(/\/$/, '')

type ApiMedia = {
  key: string
  name: string
  originalName: string
  size: number
  uploadedAt: string | null
  kind: 'photo' | 'video'
  previewUrl: string
  collection: string
  tags: string[]
  caption: string
  favorite: boolean
}

type UploadAuthorization = {
  key: string
  fingerprint: string
  url: string
  fields: Record<string, string>
}

type ApiErrorPayload = {
  message?: string
  code?: string
  duplicate?: { name?: string }
}

const authorizedRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
  if (!apiBaseUrl) throw new Error('The media API is not configured.')
  const session = await fetchAuthSession()
  const token = session.tokens?.accessToken?.toString()
  if (!token) throw new Error('Your session has expired. Please sign in again.')

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  const payload = await response.json().catch(() => ({})) as ApiErrorPayload
  if (!response.ok) {
    if (payload.code === 'DUPLICATE' || payload.code === 'DUPLICATE_PENDING') {
      const existingName = payload.duplicate?.name
      throw new Error(existingName
        ? `“${existingName}” is already in the media library.`
        : payload.message ?? 'This file is already in the media library.')
    }
    throw new Error(payload.message ?? 'The media service request failed.')
  }
  return payload as T
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(bytes / 1024, 0.1).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export async function listMedia(scope: 'library' | 'trash' = 'library'): Promise<MediaItem[]> {
  const result = await authorizedRequest<{ items: ApiMedia[] }>(scope === 'trash' ? '/media/trash' : '/media')
  return result.items.map((item) => ({
    id: item.key,
    key: item.key,
    bytes: item.size,
    name: item.name,
    kind: item.kind,
    src: item.previewUrl,
    collection: item.collection,
    dimensions: item.kind === 'video' ? 'Video' : 'Image',
    size: formatBytes(item.size),
    uploaded: item.uploadedAt
      ? new Date(item.uploadedAt).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : 'Unknown',
    tags: item.tags,
    caption: item.caption,
    favorite: item.favorite,
  }))
}

export async function uploadMedia(file: File): Promise<string> {
  const hasher = await createSHA256()
  hasher.init()
  const chunkSize = 4 * 1024 * 1024
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = await file.slice(offset, Math.min(offset + chunkSize, file.size)).arrayBuffer()
    hasher.update(new Uint8Array(chunk))
  }
  const fingerprint = hasher.digest('hex')

  const authorization = await authorizedRequest<UploadAuthorization>('/media/upload', {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      fingerprint,
    }),
  })

  const form = new FormData()
  Object.entries(authorization.fields).forEach(([name, value]) => form.append(name, value))
  form.append('file', file)
  const upload = await fetch(authorization.url, { method: 'POST', body: form })
  if (!upload.ok) throw new Error(`S3 rejected ${file.name}.`)

  await authorizedRequest('/media/upload/complete', {
    method: 'POST',
    body: JSON.stringify({ key: authorization.key, fingerprint: authorization.fingerprint }),
  })
  return authorization.key
}

export async function getDownloadUrl(key: string): Promise<string> {
  const result = await authorizedRequest<{ url: string }>(
    `/media/download?key=${encodeURIComponent(key)}`,
  )
  return result.url
}

export async function trashMedia(key: string): Promise<void> {
  await authorizedRequest('/media/trash', {
    method: 'POST',
    body: JSON.stringify({ key }),
  })
}

export async function restoreMedia(key: string): Promise<void> {
  await authorizedRequest('/media/restore', {
    method: 'POST',
    body: JSON.stringify({ key }),
  })
}

export type MediaMetadataUpdate = {
  displayName?: string
  collection?: string
  tags?: string[]
  caption?: string
  favorite?: boolean
}

export async function updateMediaMetadata(key: string, updates: MediaMetadataUpdate): Promise<void> {
  await authorizedRequest('/media/metadata', {
    method: 'PATCH',
    body: JSON.stringify({ key, ...updates }),
  })
}
