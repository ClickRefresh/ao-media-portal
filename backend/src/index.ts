import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

const bucketName = process.env.BUCKET_NAME
const s3 = new S3Client({})
const mediaPrefix = 'media/'
const maxUploadBytes = 5 * 1024 * 1024 * 1024
const allowedContentTypes = /^(image\/(jpeg|png|webp|heic|heif)|video\/(mp4|quicktime))$/

type UploadRequest = {
  fileName?: string
  contentType?: string
  size?: number
}

const response = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const safeFileName = (value: string) => {
  const parts = value.split(/[\\/]/)
  const base = parts.at(-1) ?? 'upload'
  return base.normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 180)
}

const requireBucket = () => {
  if (!bucketName) throw new Error('BUCKET_NAME is not configured')
  return bucketName
}

const listMedia = async () => {
  const bucket = requireBucket()
  const result = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: mediaPrefix,
    MaxKeys: 100,
  }))

  const items = await Promise.all(
    (result.Contents ?? [])
      .filter((object) => object.Key && object.Size !== 0)
      .map(async (object) => {
        const key = object.Key!
        const name = key.split('/').at(-1) ?? key
        const previewUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn: 15 * 60 },
        )

        return {
          key,
          name,
          size: object.Size ?? 0,
          uploadedAt: object.LastModified?.toISOString() ?? null,
          kind: /\.(mp4|mov)$/i.test(name) ? 'video' : 'photo',
          previewUrl,
        }
      }),
  )

  return response(200, { items, nextToken: result.NextContinuationToken ?? null })
}

const createUpload = async (body: string | undefined, subject: string) => {
  const bucket = requireBucket()
  const input = JSON.parse(body ?? '{}') as UploadRequest
  const fileName = safeFileName(input.fileName ?? '')
  const contentType = input.contentType ?? ''
  const size = Number(input.size)

  if (!fileName || !allowedContentTypes.test(contentType)) {
    return response(400, { message: 'Unsupported file type.' })
  }
  if (!Number.isFinite(size) || size <= 0 || size > maxUploadBytes) {
    return response(400, { message: 'Files must be between 1 byte and 5 GB.' })
  }

  const now = new Date()
  const key = `${mediaPrefix}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}-${fileName}`
  const upload = await createPresignedPost(s3, {
    Bucket: bucket,
    Key: key,
    Expires: 5 * 60,
    Fields: {
      'Content-Type': contentType,
      'x-amz-meta-original-name': fileName,
      'x-amz-meta-uploaded-by': subject,
    },
    Conditions: [
      ['content-length-range', 1, size],
      ['eq', '$Content-Type', contentType],
    ],
  })

  return response(200, { key, ...upload })
}

const createDownload = async (key: string | undefined) => {
  const bucket = requireBucket()
  if (!key?.startsWith(mediaPrefix) || key.includes('..')) {
    return response(400, { message: 'Invalid media key.' })
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safeFileName(key.split('/').at(-1) ?? 'download')}"`,
    }),
    { expiresIn: 5 * 60 },
  )
  return response(200, { url })
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  try {
    const route = event.requestContext.routeKey
    if (route === 'GET /media') return await listMedia()
    if (route === 'POST /media/upload') {
      const subject = event.requestContext.authorizer?.jwt?.claims.sub ?? 'unknown'
      return await createUpload(event.body, String(subject))
    }
    if (route === 'GET /media/download') {
      return await createDownload(event.queryStringParameters?.key)
    }
    return response(404, { message: 'Not found.' })
  } catch (error) {
    console.error(error)
    return response(500, { message: 'The media service could not complete the request.' })
  }
}
