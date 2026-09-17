# AO Media Portal

Private media library for All-Outdoors staff. The portal will use Amazon Cognito for authentication and private Amazon S3 storage for photos and videos.

## Technology

- React
- TypeScript
- Vite
- Amazon Cognito managed login
- Private Amazon S3 storage

## Local setup

1. Install the project dependencies with `pnpm install`.
2. Copy `.env.example` to `.env.local`.
3. Fill in the non-secret AWS application configuration.
4. Start the development server with `pnpm dev`.

Environment files are ignored by Git. Never commit passwords, private keys, AWS access keys, or tokens.

## Checks

- `pnpm lint`
- `pnpm build`
