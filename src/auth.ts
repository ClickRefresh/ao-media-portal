import 'aws-amplify/auth/enable-oauth-listener'
import { Amplify } from 'aws-amplify'
import {
  fetchUserAttributes,
  getCurrentUser,
  signInWithRedirect,
  signOut,
} from 'aws-amplify/auth'

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID?.trim()
const userPoolClientId = import.meta.env.VITE_COGNITO_CLIENT_ID?.trim()
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN?.trim()
const redirectUri = import.meta.env.VITE_COGNITO_REDIRECT_URI?.trim()
const logoutUri = import.meta.env.VITE_COGNITO_LOGOUT_URI?.trim()

export const demoMode =
  import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE !== 'false'

export const cognitoConfigured = Boolean(
  userPoolId &&
    userPoolClientId &&
    cognitoDomain &&
    redirectUri &&
    logoutUri &&
    !userPoolClientId?.startsWith('replace-'),
)

if (cognitoConfigured) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: userPoolId!,
        userPoolClientId: userPoolClientId!,
        loginWith: {
          email: true,
          oauth: {
            domain: cognitoDomain!.replace(/^https?:\/\//, ''),
            scopes: ['openid', 'email', 'profile'],
            redirectSignIn: [redirectUri!],
            redirectSignOut: [logoutUri!],
            responseType: 'code',
          },
        },
        signUpVerificationMethod: 'code',
        userAttributes: {
          email: { required: true },
        },
        passwordFormat: {
          minLength: 14,
          requireLowercase: true,
          requireUppercase: true,
          requireNumbers: true,
          requireSpecialCharacters: true,
        },
      },
    },
  })
}

export type PortalUser = {
  username: string
  email: string
  initials: string
}

export async function getPortalUser(): Promise<PortalUser | null> {
  try {
    const currentUser = await getCurrentUser()
    const attributes = await fetchUserAttributes()
    const email = attributes.email ?? currentUser.username
    const initials = email.slice(0, 2).toUpperCase()

    return { username: currentUser.username, email, initials }
  } catch {
    return null
  }
}

export async function beginSignIn() {
  await signInWithRedirect()
}

export async function endSession() {
  await signOut({ global: true })
}
