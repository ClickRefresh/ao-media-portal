import { fetchAuthSession } from 'aws-amplify/auth'
import type { MediaItem } from './media'

const configuredApiUrl = import.meta.env.VITE_API_BASE_URL?.trim()

export const mediaApiConfigured = Boolean(
  configuredApiUrl && !configuredApiUrl.startsWith('replace-'),
)

const apiBaseUrl = configuredApiUrl?.replace(/\/$/, '')

type ApiMedia = {
  key: string
  name: string
  size: number
  uploadedAt: string | null
  kind: 'photo' | 'video'
  previewUrl: string
}

type UploadAuthorization = {
  key: string
  url: string
  fields: Record<string, string>
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
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.message ?? 'The media service request failed.')
  }
  return payload as T
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(bytes / 1024, 0.1).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export async function listMedia(): Promise<MediaItem[]> {
  const result = await authorizedRequest<{ items: ApiMedia[] }>('/media')
  return result.items.map((item) => ({
    id: item.key,
    key: item.key,
    bytes: item.size,
    name: item.name,
    kind: item.kind,
    src: item.previewUrl,
    collection: 'Unsorted uploads',
    dimensions: item.kind === 'video' ? 'Video' : 'Image',
    size: formatBytes(item.size),
    uploaded: item.uploadedAt
      ? new Date(item.uploadedAt).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : 'Unknown',
    tags: ['s3'],
  }))
}

export async function uploadMedia(file: File): Promise<string> {
  const authorization = await authorizedRequest<UploadAuthorization>('/media/upload', {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      size: file.size,
    }),
  })

  const form = new FormData()
  Object.entries(authorization.fields).forEach(([name, value]) => form.append(name, value))
  form.append('file', file)
  const upload = await fetch(authorization.url, { method: 'POST', body: form })
  if (!upload.ok) throw new Error(`S3 rejected ${file.name}.`)
  return authorization.key
}

export async function getDownloadUrl(key: string): Promise<string> {
  const result = await authorizedRequest<{ url: string }>(
    `/media/download?key=${encodeURIComponent(key)}`,
  )
  return result.url
}
