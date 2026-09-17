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
- Production-safe configuration gate when Cognito variables are missing

## Local setup

1. Install the project dependencies with `pnpm install`.
2. Copy `.env.example` to `.env.local`.
3. Fill in the non-secret Cognito application configuration.
4. Start the development server with `pnpm dev`.

Local development starts in preview mode unless `VITE_DEMO_MODE=false` is set. Preview changes remain in the browser and do not upload to S3.

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
