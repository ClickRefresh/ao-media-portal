# AO Media Portal

Private media library for All-Outdoors staff. The portal uses Amazon Cognito for authentication and will use private Amazon S3 storage for photos and videos.

## Technology

- React
- TypeScript
- Vite
- Amazon Cognito managed login
- Private Amazon S3 storage

## Current portal features

- Responsive staff dashboard using the All-Outdoors brand
- Photo/video grid and list views
- Search and media-type filters
- Favorites and multi-select controls
- Drag-and-drop upload preview
- Cognito OAuth authorization-code flow with PKCE
- Cognito-protected S3 API for private listings, previews, uploads, and downloads
- Production-safe configuration gate when Cognito variables are missing

## Local setup

1. Install the project dependencies with `pnpm install`.
2. Copy `.env.example` to `.env.local`.
3. Fill in the non-secret Cognito application configuration.
4. Start the development server with `pnpm dev`.

Local development starts in preview mode unless `VITE_DEMO_MODE=false` is set. Preview changes remain in the browser and do not upload to S3.

## Private S3 API

The `backend/` directory contains an AWS SAM application that deploys an HTTP API and Lambda function in `us-west-2`. API Gateway validates the Cognito access token before Lambda can list objects or issue short-lived S3 authorizations. The browser never receives AWS credentials and the bucket remains private.

The API currently provides:

- `GET /media` — lists the first 100 media objects with 15-minute private preview URLs
- `POST /media/upload` — creates a five-minute presigned S3 POST, limited to the requested file size and supported photo/video content types
- `GET /media/download?key=...` — creates a five-minute private download URL

### Deploy

1. Install the AWS CLI and AWS SAM CLI, and authenticate them to AWS account `543872465939`.
2. In `backend/`, run `pnpm install` and `sam build`.
3. Copy `samconfig.toml.example` to `samconfig.toml`.
4. Run `sam deploy --guided` and review the IAM changeset before approving it.
5. Copy the `MediaApiUrl` stack output into `VITE_API_BASE_URL` in the frontend environment.
6. Apply `backend/s3-cors.json` to the bucket's **Permissions → Cross-origin resource sharing (CORS)** setting.

The current production API stack is `ao-media-portal-api-prod`, with endpoint `https://prdd7g3j20.execute-api.us-west-2.amazonaws.com`.

The deployment targets bucket `aorafting-media-library-prod-543872465939-us-west-2-an`, user pool `us-west-2_CGSGfnrmt`, and app client `25eqamg53fjhvppqhk36s94jih`. Change the SAM parameters if any of these resources are renamed.

## Cognito integration

The portal connects directly to the existing Cognito user pool; it does not use or copy the console's sample React application. Required values:

- User pool ID
- SPA app-client ID
- Managed-login domain (`auth.aorafting.net`)
- Callback URL (`https://media.aorafting.net/auth/callback`)
- Sign-out URL (`https://media.aorafting.net/`)

These values are public application identifiers, not AWS credentials. Authentication uses the authorization-code flow and Cognito's hosted passkey/TOTP screens.

Environment files are ignored by Git. Never commit passwords, private keys, AWS access keys, or tokens.

## Checks

- `pnpm lint`
- `pnpm build`
