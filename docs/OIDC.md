# NextCloud sign-in — the checklist to run against the real server

**This is the one part of the app that has never been executed against anything real.** There was no
NextCloud instance available while it was written, so the flow is built to specification and unit-tested with
an injected `fetch` — the shape of the requests is verified, the server's actual answers are not.

Work through this list once, on the real instance, before you rely on it. Until then, admin-issued invite
links are a fully working sign-in path and need none of this.

## 1. Register the app in NextCloud

NextCloud's OIDC provider lives in the **OIDC Identity Provider** app (`user_oidc` is the *client* side and
is not what you want here). Register a client with:

- **Redirect URI:** `https://plan-cph.4water.org/auth/callback` — exactly this, including the scheme. A
  mismatch is the single most common failure and NextCloud will say only "invalid redirect".
- **Flow:** authorization code, with PKCE enabled.
- **Scopes:** `openid profile email`.

Put the values in `.env`:

```
OIDC_ISSUER=https://cloud.4water.org
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_REDIRECT_URI=https://plan-cph.4water.org/auth/callback
```

With any one of those blank, the sign-in page silently does not offer NextCloud. That is deliberate — a
half-configured OIDC button that always errors is worse than no button — but it also means **a typo shows up
as a missing button, not an error message.** If the button is absent, check for an empty variable first.

## 2. Verify the endpoint paths

⚠ **Most likely thing to be wrong.** The code assumes:

- authorize: `{issuer}/apps/oidc/authorize`
- token: `{issuer}/apps/oidc/token`
- userinfo: `{issuer}/apps/oidc/userinfo`

Confirm against the instance's own discovery document:

```bash
curl -s https://cloud.4water.org/.well-known/openid-configuration | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.authorization_endpoint);console.log(o.token_endpoint);console.log(o.userinfo_endpoint)})"
```

If they differ, fix the three URL builders in `src/auth.mjs` (`beginOidc` and `completeOidc`). A proper
discovery-document fetch would be the tidier answer and is a reasonable follow-up; three constants were the
honest choice while none of it could be tested.

## 3. Walk the flow and check each property

| Check | How | Expected |
|---|---|---|
| The button appears | Open `/signin` | "Sign in with NextCloud" is shown |
| PKCE is sent | Inspect the redirect URL | `code_challenge_method=S256` and a `code_challenge` present |
| The challenge is a hash | Compare to the cookie | `code_challenge` must NOT equal the verifier |
| State round-trips | Complete a sign-in | Lands on `/` signed in |
| A tampered state fails | Edit `state` in the callback URL | 400, no session issued |
| A replayed callback fails | Reuse the same callback URL twice | Second attempt refused |
| Unknown users are refused | Sign in as someone not on the roster | Redirected to `/signin?unknown=1`, no account created |
| A pre-registered person is adopted | Add them in Admin with their NextCloud email first, then sign in | Signed in, linked to that existing record |

That seventh row is a deliberate security property, not an oversight: **anyone in 4water's NextCloud instance
could otherwise appear on the schedule.** An admin adds the person's email first; their first sign-in claims
that record.

## 4. Things that will look like bugs and are not

- **A volunteer who changes their NextCloud display name keeps their name here.** The roster name is 4water's,
  not NextCloud's; it is only used as a fallback when adopting a new record.
- **Signing out does not sign them out of NextCloud.** There is no single-logout; the session cookie is
  cleared and that is all. Say so if anyone asks.
- **A NextCloud outage blocks OIDC sign-in but not invite links.** If nobody can get in, issue an invite to a
  planner as the way back — worth knowing before you need it.
- **Sessions last 30 days.** A volunteer entering availability once a season should not be logged out
  mid-form. The CSRF token is per-session and short-lived; that is what carries the protection.

## 5. If you turn this off again

Blank the four `OIDC_*` variables and restart. Existing volunteers keep their accounts — `auth_provider` and
`auth_subject` stay on the record — so re-enabling later picks up where it left off with no re-linking.
