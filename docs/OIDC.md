# NextCloud sign-in — the checklist to run against the real server

**This has never run against NextCloud. It has run against a conforming provider.** The two are different
claims and this page used to make only the pessimistic one.

`test/oidc-endtoend.test.mjs` starts a minimal OpenID Connect provider and drives the whole flow over real
HTTP with real redirects: the app fetches the discovery document and uses the endpoint paths it publishes, the
authorize redirect carries PKCE and a state, the callback exchanges the code with a verifier the provider checks
against the challenge, `userinfo` maps onto a pre-registered person, and three refusals hold — an identity
nobody put on the roster, a tampered `state`, and a replayed callback. The discovery fallback is exercised too:
pointed at a provider with no well-known document, the app logs the failure and degrades to NextCloud's layout
rather than breaking.

**So what is left unverified is NextCloud specifically**, and that is not a formality. Its endpoint paths, its
claim names, whether it returns `name` or `preferred_username`, whether it honours PKCE, what it does with an
unknown `scope` — every one is a property of their server, and a provider written to the spec tests this app
rather than theirs. Work through this list once, on the real instance, before you rely on it. Until then,
admin-issued invite links are a fully working sign-in path and need none of this.

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

## 2. Endpoints come from discovery — you should not have to edit code

The app asks the instance where its endpoints are:

```
GET {issuer}/.well-known/openid-configuration
```

and uses the `authorization_endpoint`, `token_endpoint` and `userinfo_endpoint` it publishes. The document is
cached for 10 minutes, so this is not a request per sign-in, and rotating the IdP's endpoints does not need a
restart. Check what your instance publishes with:

```bash
curl -s https://cloud.4water.org/.well-known/openid-configuration | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.issuer);console.log(o.authorization_endpoint);console.log(o.token_endpoint);console.log(o.userinfo_endpoint)})"
```

**Every discovered endpoint must be on the same origin as `OIDC_ISSUER`, over https.** This is not tidiness:
the token endpoint is where `OIDC_CLIENT_SECRET` gets posted, so a document naming another host would hand
your secret to that host. `OIDC_ISSUER` is something you configured; the document is a network response, and
the two are not equally trustworthy. A document that fails the check — wrong origin, plain http, or an
`issuer` field that disagrees with `OIDC_ISSUER` — is discarded whole. `localhost` over http is exempt so a
developer can run a test IdP.

If discovery cannot be read at all, the app **falls back** to NextCloud's usual layout
(`{issuer}/apps/oidc/{authorize,token,userinfo}`) rather than locking every volunteer out over a missing
well-known route — and says so on **`/status`**, with the reason. If that line reads "guessing NextCloud's
usual addresses", discovery is broken and you are one NextCloud upgrade away from a sign-in outage. Fix it
rather than living on the fallback.

Nothing here requires editing `src/auth.mjs`. If your instance publishes endpoints the app rejects, that is a
finding worth reporting, not a constant to change.

## 3. Walk the flow and check each property

| Check | How | Expected |
|---|---|---|
| The button appears | Open `/signin` | "Sign in with NextCloud" is shown |
| Discovery works | Open `/status` as a planner | "reads the identity provider's own endpoint list", not "guessing" |
| The endpoints are the published ones | Inspect the redirect URL | Its path matches `authorization_endpoint` from §2 |
| PKCE is sent | Inspect the redirect URL | `code_challenge_method=S256` and a `code_challenge` present |
| The challenge is a hash | Compare to the cookie | `code_challenge` must NOT equal the verifier |
| State round-trips | Complete a sign-in | Lands on `/` signed in |
| A tampered state fails | Edit `state` in the callback URL | 400, no session issued |
| A replayed callback fails | Reuse the same callback URL twice | Second attempt refused |
| Unknown users are refused | Sign in as someone not on the roster | Redirected to `/signin?unknown=1`, no account created |
| A pre-registered person is adopted | Add them in Admin with their NextCloud email first, then sign in | Signed in, linked to that existing record |
| **Does NextCloud send `email_verified`, and can a user edit their own address?** | Read the `userinfo` response during the sign-in above; then check whether a normal user can change their email in NextCloud's own settings | Ideally the claim is present. If it is absent **and** users can set their own address, see below — this is the one row that can turn the refusal above into nothing |

**"Unknown users are refused" is a deliberate security property, not an oversight:** anyone in 4water's
NextCloud instance could otherwise appear on the schedule. An admin adds the person's email first; their first
sign-in claims that record — the last row above.

**And that adoption step is where the refusal can be undone, which is why the `email_verified` row is on the
list.** Refusing to *create* a person stops a stranger appearing as a new name. It says nothing about a stranger
arriving as an *existing* one: adoption matches on the address NextCloud sends, so if a user can type any address
into their own profile and NextCloud passes it on unqualified, anyone in the instance can claim any
pre-registered record — and inherit whatever roles it already carries. A planner or administrator who has been
added but has not signed in yet is the highest-value window.

`linkIdentity` now refuses outright when NextCloud says `email_verified: false`. When the claim is **absent** it
still adopts, deliberately: refusing would lock out every pre-registered volunteer on an instance that simply
omits it, and nobody has asked 4water's NextCloud yet. It logs a warning each time, so the assumption is at
least visible. **Answer that checklist row and this stops being an open question.** If the claim is absent and
users can edit their own addresses, invite links are the safe way to onboard — they carry a secret an admin
issued rather than an address a stranger can assert.

(This paragraph used to open "That seventh row", which pointed at the tampered-state check two rows above the
one it describes. An ordinal into a table is a reference that breaks the next time somebody inserts a row, and
breaks silently, so the rows are named here instead.)

## 4. Things that will look like bugs and are not

- **A volunteer who changes their NextCloud display name keeps their name here.** The roster name is 4water's,
  not NextCloud's; it is only used as a fallback when adopting a new record.
- **Signing out does not sign them out of NextCloud.** There is no single-logout; the session cookie is
  cleared and that is all. Say so if anyone asks.
- **A NextCloud outage blocks OIDC sign-in but not invite links.** If nobody can get in, issue an invite to a
  planner as the way back — worth knowing before you need it.
- **Sessions last 30 days, and the CSRF token lasts exactly as long.** A volunteer entering availability once a
  season should not be logged out mid-form. This line used to add "the CSRF token is short-lived; that is what
  carries the protection", which was simply untrue — the token is sixteen random bytes minted once, with no
  timestamp, carried inside the same cookie. What carries the protection is that the cookie is `HttpOnly` and
  signed, so the token cannot be read by script, and the CSP admits no third-party script to try; `SameSite=Lax`
  is the second lock. Rotating the token would *break* the thing the long session is for, by invalidating the
  form on any page left open. If you are auditing this, audit those properties — not a lifetime that was never
  short.

## 5. If you turn this off again

Blank the four `OIDC_*` variables and restart. Existing volunteers keep their accounts — `auth_provider` and
`auth_subject` stay on the record — so re-enabling later picks up where it left off with no re-linking.
