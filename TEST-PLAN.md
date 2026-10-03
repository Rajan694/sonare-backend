# Sonare Backend Test Plan & Traceability Matrix

This document maps all backend test IDs to their specifications, assertions, and target endpoints/modules.

---

## 1. Authentication & Session Management

| Test ID             | Method / Scope               | Description & Assertions                                                          |
| :------------------ | :--------------------------- | :-------------------------------------------------------------------------------- |
| `BE-AUTH-001`       | `POST /api/v1/auth/register` | Registers new user; returns 201 with accessToken, refreshToken, and user object.  |
| `BE-AUTH-002`       | `POST /api/v1/auth/register` | Rejects registration with missing email (400 BAD_REQUEST).                        |
| `BE-AUTH-003`       | `POST /api/v1/auth/register` | Rejects registration with missing password (400 BAD_REQUEST).                     |
| `BE-AUTH-004`       | `POST /api/v1/auth/register` | Rejects registration with missing displayName (400 BAD_REQUEST).                  |
| `BE-AUTH-005`       | `POST /api/v1/auth/register` | Rejects duplicate email registration with 409 CONFLICT.                           |
| `BE-AUTH-006`       | `POST /api/v1/auth/login`    | Validates credentials; returns 200 with tokens and user profile.                  |
| `BE-AUTH-007`       | `POST /api/v1/auth/login`    | Rejects non-existent email with 401 UNAUTHORIZED.                                 |
| `BE-AUTH-008`       | `POST /api/v1/auth/login`    | Rejects invalid password with 401 UNAUTHORIZED.                                   |
| `BE-AUTH-009`       | `POST /api/v1/auth/login`    | Rejects login missing email with 400 BAD_REQUEST.                                 |
| `BE-AUTH-010`       | `POST /api/v1/auth/login`    | Rejects login missing password with 400 BAD_REQUEST.                              |
| `BE-AUTH-011`       | `POST /api/v1/auth/refresh`  | Rotates refreshToken, issues new accessToken, revokes previous refreshToken.      |
| `BE-AUTH-012`       | `POST /api/v1/auth/refresh`  | Rejects refresh request missing refreshToken with 400 BAD_REQUEST.                |
| `BE-AUTH-013`       | `POST /api/v1/auth/refresh`  | Rejects invalid or expired refresh token with 401 UNAUTHORIZED.                   |
| `BE-AUTH-014`       | `POST /api/v1/auth/refresh`  | Rejects refresh attempt for deleted user with 401 UNAUTHORIZED.                   |
| `BE-AUTH-015`       | `POST /api/v1/auth/logout`   | Revokes refresh token in database and returns ok: true.                           |
| `BE-AUTH-016`       | `POST /api/v1/auth/logout`   | Gracefully handles empty logout request without error.                            |
| `BE-AUTH-017`       | `requireAuth` middleware     | Rejects requests with missing Authorization header (401 UNAUTHORIZED).            |
| `BE-AUTH-018`       | `requireAuth` middleware     | Rejects requests with non-Bearer Authorization scheme (401 UNAUTHORIZED).         |
| `BE-AUTH-019`       | `requireAuth` middleware     | Rejects requests with invalid JWT structure or signature (401 UNAUTHORIZED).      |
| `BE-AUTH-020`       | `signAccessToken`            | Generates valid signed JWT access token.                                          |
| `BE-AUTH-021`       | `generateRefreshToken`       | Generates cryptographically strong random hex refresh token string.               |
| `BE-AUTH-EXTRA-001` | `POST /api/v1/auth/login`    | Handles corrupted password hash in DB gracefully with 401 UNAUTHORIZED.           |
| `BE-AUTH-EXTRA-002` | `requireAuth` middleware     | Rejects expired access token with 401 UNAUTHORIZED.                               |
| `BE-AUTH-EXTRA-003` | `requireAuth` middleware     | Rejects token signed with unrecognized secret with 401 UNAUTHORIZED.              |
| `BE-AUTH-EXTRA-004` | `POST /api/v1/auth/logout`   | Handles empty request body idempotently.                                          |
| `BE-AUTH-BR-001`    | `POST /api/v1/auth/refresh`  | Verifies user lookup failure path during refresh rotation.                        |
| `BE-AUTH-BR-002`    | `requireAuth` middleware     | Verifies user payload attachment to Express request object.                       |
| `BE-AUTH-SEC-001`   | `POST /api/v1/auth/register` | Stored refresh token is the sha256 of the one returned to the client.             |
| `BE-AUTH-SEC-002`   | `POST /api/v1/auth/login`    | Sixth wrong password for the same email in 15 minutes gives 429 with Retry-After. |
| `BE-AUTH-SEC-003`   | `POST /api/v1/auth/login`    | A successful login resets the failed-attempt counter.                             |
| `BE-SEC-001`        | CORS                         | Allows `http://localhost:<port>` origins outside production.                      |
| `BE-SEC-002`        | CORS                         | `http://localhost.evil.com` gets no CORS header and no 500.                       |
| `BE-SEC-003`        | CORS                         | Requests without an Origin header (mobile, curl) work.                            |
| `BE-SEC-004`        | helmet                       | Security headers are set; cross-origin resource policy stays open for media.      |
| `BE-SEC-005`        | error handler                | Unexpected errors return a generic 500 message, never the internal one.           |
| `BE-SEC-006`        | error handler                | A malformed JSON body gets 400 BAD_REQUEST.                                       |
| `BE-SEC-007`        | `GET /api/v1/healthz`        | Answers within 4 s with `piped: down` when Piped hangs.                           |
| `BE-SEC-008`        | `GET /api/v1/healthz`        | Answers within 4 s when the TCP connect to Piped never completes.                 |

### Email verification & password reset

| Test ID        | Method / Scope                          | Description & Assertions                                                                 |
| :------------- | :-------------------------------------- | :--------------------------------------------------------------------------------------- |
| `BE-EMAIL-001` | `POST /api/v1/auth/register`            | Sends a verify link; lowercases the email; DB stores only the sha256 of the token.       |
| `BE-EMAIL-002` | `POST /api/v1/auth/register`            | Still returns 201 when the email cannot be sent.                                         |
| `BE-EMAIL-003` | `POST /api/v1/auth/verify-email`        | Marks the account verified (seen in /me and login); the link works once.                 |
| `BE-EMAIL-004` | `POST /api/v1/auth/verify-email`        | Expired or unknown token gives 400 INVALID_TOKEN.                                        |
| `BE-EMAIL-005` | `POST /api/v1/auth/resend-verification` | New link replaces the old one; 4th request in an hour gives 429.                         |
| `BE-EMAIL-006` | `POST /api/v1/auth/resend-verification` | Verified account gets alreadyVerified and no email.                                      |
| `BE-EMAIL-007` | `POST /api/v1/auth/forgot-password`     | Unknown email still answers ok and sends nothing.                                        |
| `BE-EMAIL-008` | `POST /api/v1/auth/reset-password`      | New password works, old fails, refresh tokens revoked, email verified, token single-use. |
| `BE-EMAIL-009` | `POST /api/v1/auth/reset-password`      | Invalid token changes neither the password nor the sessions.                             |
| `BE-EMAIL-010` | register / reset-password               | Passwords under 8 characters give 400.                                                   |
| `BE-EMAIL-011` | `POST /api/v1/auth/forgot-password`     | 4th request for one email in an hour gives 429.                                          |
| `BE-EMAIL-012` | `POST /api/v1/auth/login`               | Finds accounts stored with mixed-case emails.                                            |

---

## 2. Catalog & Discovery

| Test ID           | Method / Scope                       | Description & Assertions                                                                   |
| :---------------- | :----------------------------------- | :----------------------------------------------------------------------------------------- |
| `BE-CATALOG-001`  | `GET /api/v1/healthz`                | Reports db, redis and piped status plus the package version; 200 while the database is up. |
| `BE-CATALOG-002`  | `GET /api/v1/healthz`                | Piped down is reported as `piped: down` but the check still returns 200.                   |
| `BE-CATALOG-003`  | `GET /api/v1/discover/made-for-you`  | Returns empty item array for unauthenticated guests.                                       |
| `BE-CATALOG-004`  | `GET /api/v1/search/suggestions`     | Proxies suggestion list from Piped upstream.                                               |
| `BE-CATALOG-005`  | `GET /api/v1/search/suggestions`     | Validates missing query q parameter with 400 BAD_REQUEST.                                  |
| `BE-CATALOG-006`  | `GET /api/v1/search?type=songs`      | Searches songs with filter mapping and cursor pagination.                                  |
| `BE-CATALOG-007`  | `GET /api/v1/search?type=albums`     | Searches albums mapped to normalized album shape.                                          |
| `BE-CATALOG-008`  | `GET /api/v1/search?type=artists`    | Searches artists mapped to normalized artist shape.                                        |
| `BE-CATALOG-009`  | `GET /api/v1/search?type=playlists`  | Searches playlists mapped to album cards.                                                  |
| `BE-CATALOG-010`  | `GET /api/v1/search?type=all`        | Aggregates multi-type search across songs, albums, artists, playlists.                     |
| `BE-CATALOG-011`  | `GET /api/v1/search`                 | Handles cursor decode and forward pagination.                                              |
| `BE-CATALOG-012`  | `GET /api/v1/search`                 | Validates missing q query parameter with 400 BAD_REQUEST.                                  |
| `BE-CATALOG-013`  | `GET /api/v1/tracks/:id`             | Returns normalized track details with authenticated user favourite states.                 |
| `BE-CATALOG-014`  | `GET /api/v1/tracks/:id`             | Handles guest requests with default user state flags.                                      |
| `BE-CATALOG-015`  | `GET /api/v1/tracks/:id`             | Piped failing twice (5xx is retried once) gives 502 UPSTREAM_ERROR.                        |
| `BE-CATALOG-015B` | `GET /api/v1/tracks/:id`             | Piped unreachable (connection refused) gives 502 UPSTREAM_UNAVAILABLE.                     |
| `BE-CATALOG-016`  | `GET /api/v1/tracks/:id/peaks`       | Returns audio waveform peak levels array.                                                  |
| `BE-CATALOG-017`  | `GET /api/v1/albums/:id`             | Returns normalized album details.                                                          |
| `BE-CATALOG-018`  | `GET /api/v1/albums/:id/tracks`      | Returns track list inside playlist/album.                                                  |
| `BE-CATALOG-019`  | `GET /api/v1/artists/:id`            | Returns artist channel metadata with following state.                                      |
| `BE-CATALOG-020`  | `GET /api/v1/artists/:id/top-tracks` | Returns top tracks for artist channel.                                                     |
| `BE-CATALOG-021`  | `GET /api/v1/artists/:id/albums`     | Returns albums list from artist channel tab.                                               |
| `BE-CATALOG-022`  | `GET /api/v1/playlists/:id`          | Returns public playlist metadata.                                                          |
| `BE-CAT-EDGE-001` | `GET /api/v1/artists/:id/albums`     | Handles cursor pagination for artist channel releases.                                     |
| `BE-CAT-EDGE-002` | `GET /api/v1/albums/:id/tracks`      | Handles cursor pagination for album tracks.                                                |
| `BE-CAT-EDGE-003` | `GET /api/v1/playlists/:id/tracks`   | Handles cursor pagination for playlist tracks.                                             |

---

## 3. Streaming & Audio Relay

| Test ID             | Method / Scope                              | Description & Assertions                                       |
| :------------------ | :------------------------------------------ | :------------------------------------------------------------- |
| `BE-STREAM-001`     | `GET /api/v1/tracks/:id/stream`             | Returns signed stream relay URL with bitrate and expiration.   |
| `BE-STREAM-002`     | `GET /api/v1/tracks/:id/stream?quality=low` | Selects lowest bitrate audio tier.                             |
| `BE-STREAM-003`     | `GET /api/v1/tracks/:id/stream?format=mp4a` | Selects AAC format audio stream.                               |
| `BE-STREAM-004`     | `GET /api/v1/tracks/:id/stream`             | Returns 503 NO_AUDIO_STREAM if no streams available.           |
| `BE-STREAM-005`     | `GET /api/v1/stream/:token`                 | Streams audio chunks to client with content-type header.       |
| `BE-STREAM-006`     | `GET /api/v1/stream/:token`                 | Forwards Range request header and returns 206 Partial Content. |
| `BE-STREAM-007`     | `GET /api/v1/stream/:token`                 | Rejects tampered or invalid stream token with error.           |
| `BE-STREAM-MID-001` | `GET /api/v1/stream/:token`                 | Refreshes dead stream URL from upstream on mid-stream 403.     |
| `BE-STREAM-MID-002` | `GET /api/v1/stream/:token`                 | Returns 502 UPSTREAM_ERROR when media upstream errors out.     |

---

## 4. Lyrics & Overrides

| Test ID          | Method / Scope                           | Description & Assertions                                           |
| :--------------- | :--------------------------------------- | :----------------------------------------------------------------- |
| `BE-LYRICS-001`  | `GET /api/v1/tracks/:id/lyrics`          | Fetches synchronized lyrics from LRCLIB provider.                  |
| `BE-LYRICS-002`  | `GET /api/v1/tracks/:id/lyrics`          | Returns plain unsynced lyrics when synced timestamps are absent.   |
| `BE-LYRICS-003`  | `GET /api/v1/tracks/:id/lyrics`          | Returns 404 NOT_FOUND when no lyrics exist.                        |
| `BE-LYRICS-004`  | `POST /api/v1/tracks/:id/lyrics`         | Stores custom user lyrics override in database.                    |
| `BE-LYRICS-005`  | `PATCH /api/v1/tracks/:id/lyrics/offset` | Updates user playback offset in milliseconds.                      |
| `BE-LYRICS-006`  | `DELETE /api/v1/tracks/:id/lyrics`       | Clears custom lyrics override for user.                            |
| `BE-LYR-COV-001` | `parseLrc`                               | Parses LRC string with offset tags and millisecond precision.      |
| `BE-LYR-COV-002` | `LyricsResolver.resolve`                 | Resolves lyrics via LRCLIB search fuzzy matching.                  |
| `BE-LYR-COV-003` | `LyricsResolver.resolve`                 | Falls back to Genius search attribution when LRCLIB has no lyrics. |
| `BE-LYR-COV-004` | `getDbLyricsOverride`                    | Handles undefined user id gracefully.                              |

---

## 5. User Personal Library & Preferences

| Test ID           | Method / Scope                                | Description & Assertions                                      |
| :---------------- | :-------------------------------------------- | :------------------------------------------------------------ |
| `BE-ME-001`       | `GET /api/v1/me`                              | Returns authenticated user profile.                           |
| `BE-ME-002`       | `GET /api/v1/me/library/tracks`               | Returns user favourited tracks sorted.                        |
| `BE-ME-003`       | `GET /api/v1/me/library/albums`               | Resolves user saved albums from catalog cache.                |
| `BE-ME-004`       | `GET /api/v1/me/library/artists`              | Resolves followed artists from channel cache.                 |
| `BE-ME-005`       | `GET /api/v1/me/library/genres`               | Returns library genres payload.                               |
| `BE-ME-006`       | `GET /api/v1/me/favourites/tracks`            | Returns favourited tracks list.                               |
| `BE-ME-007`       | `PUT /api/v1/me/favourites/tracks/:id`        | Adds track to favourites.                                     |
| `BE-ME-008`       | `DELETE /api/v1/me/favourites/tracks/:id`     | Removes track from favourites.                                |
| `BE-ME-009`       | `GET /api/v1/me/favourites/albums`            | Returns saved favourite albums.                               |
| `BE-ME-010`       | `PUT /api/v1/me/favourites/albums/:id`        | Adds album to favourites.                                     |
| `BE-ME-011`       | `DELETE /api/v1/me/favourites/albums/:id`     | Removes album from favourites.                                |
| `BE-ME-012`       | `GET /api/v1/me/library/artists`              | Returns list of followed artists.                             |
| `BE-ME-013`       | `PUT /api/v1/me/following/artists/:id`        | Follows an artist channel.                                    |
| `BE-ME-014`       | `DELETE /api/v1/me/following/artists/:id`     | Unfollows an artist channel.                                  |
| `BE-ME-015`       | `GET /api/v1/me/recently-played`              | Returns hydrated play history.                                |
| `BE-ME-016`       | `POST /api/v1/me/sync`                        | Syncs play history events and favourites idempotently.        |
| `BE-ME-017`       | `GET /api/v1/me/most-played`                  | Aggregates playback history counts.                           |
| `BE-ME-018`       | `GET /api/v1/me/playlists`                    | Lists user created playlists with track counts.               |
| `BE-ME-019`       | `POST /api/v1/me/playlists`                   | Creates new playlist with custom title and description.       |
| `BE-ME-020`       | `GET /api/v1/me/playlists/:id`                | Returns playlist details and track listing.                   |
| `BE-ME-021`       | `PATCH /api/v1/me/playlists/:id`              | Updates playlist name and metadata.                           |
| `BE-ME-022`       | `DELETE /api/v1/me/playlists/:id`             | Deletes user playlist.                                        |
| `BE-ME-023`       | `POST /api/v1/me/playlists/:id/tracks`        | Adds tracks to playlist.                                      |
| `BE-ME-024`       | `DELETE /api/v1/me/playlists/:id/tracks`      | Removes track from playlist by ID.                            |
| `BE-ME-025`       | `PATCH /api/v1/me/playlists/:id/tracks/order` | Reorders tracks in playlist.                                  |
| `BE-ME-026`       | `GET /api/v1/me/settings`                     | Returns user audio and playback settings.                     |
| `BE-ME-027`       | `PUT /api/v1/me/settings`                     | Updates user equalizer and streaming preferences.             |
| `BE-ME-028`       | `GET /api/v1/me/player-state`                 | Restores persisted playback queue and position.               |
| `BE-ME-029`       | `PUT /api/v1/me/player-state`                 | Saves current player state and queue.                         |
| `BE-ME-EXTRA-001` | `GET /api/v1/me/playlists/:id`                | Returns 404 for missing playlist.                             |
| `BE-ME-EXTRA-002` | `PATCH /api/v1/me/playlists/:id`              | Returns 404 when attempting to edit another user's playlist.  |
| `BE-ME-EXTRA-003` | `DELETE /api/v1/me/playlists/:id`             | Returns 200 idempotently when playlist is not found.          |
| `BE-ME-EXTRA-004` | `POST /api/v1/me/playlists`                   | Rejects empty playlist name with 400 BAD_REQUEST.             |
| `BE-ME-EXTRA-005` | `POST /api/v1/me/playlists/:id/tracks`        | Rejects non-array track IDs payload with 400 BAD_REQUEST.     |
| `BE-ME-EXTRA-006` | `PATCH /api/v1/me/playlists/:id/tracks/order` | Rejects missing from/to reorder indices with 400 BAD_REQUEST. |
| `BE-ME-EXTRA-007` | `GET /api/v1/me/library/genres`               | Verifies genres placeholder response format.                  |
| `BE-ME-EXTRA-008` | `GET /api/v1/me/new-releases`                 | Verifies new releases payload format.                         |
| `BE-ME-BR-001`    | `PATCH /api/v1/me/playlists/:id`              | Updates description when title is unchanged.                  |
| `BE-ME-BR-002`    | `PATCH /api/v1/me/playlists/:id/tracks/order` | Returns 404 for non-existent playlist.                        |
| `BE-ME-BR-003`    | `DELETE /api/v1/me/playlists/:id/tracks`      | Handles local track IDs removal.                              |
| `BE-ME-BR2-001`   | `POST /api/v1/me/playlists/:id/tracks`        | Adds local track format IDs to playlist.                      |
| `BE-EXP-001`      | `POST /api/v1/me/playlists`                   | Creates offline-kind playlists.                               |
| `BE-EXP-002`      | `DELETE /api/v1/me/playlists/:id/tracks`      | Deletes tracks by numerical index position.                   |
| `BE-EXP-003`      | `DELETE /api/v1/me/playlists/:id/tracks`      | Returns 404 when modifying playlist owned by another user.    |
| `BE-EXP-004`      | `PUT /api/v1/me/settings`                     | Updates normalization, gapless, and offline settings.         |
| `BE-EXP-005`      | `PUT /api/v1/me/settings`                     | Handles empty changes object gracefully.                      |
| `BE-EXP-006`      | `PUT /api/v1/me/settings`                     | Normalizes lossless quality setting to high.                  |
| `BE-EXP-007`      | `PUT /api/v1/me/player-state`                 | Handles shuffle and repeat modes.                             |
| `BE-SETT-001`     | `PUT /api/v1/me/settings`                     | Updates download format preference.                           |
| `BE-SETT-002`     | `PUT /api/v1/me/player-state`                 | Saves local trackRef player state.                            |
| `BE-SYNC-001`     | `POST /api/v1/me/sync`                        | Syncs multiple favourite items idempotently.                  |
| `BE-SYNC-002`     | `GET /api/v1/me/library/tracks`               | Sorts tracks by title ascending and descending.               |
| `BE-SYNC-003`     | `GET /api/v1/me/library/tracks`               | Sorts tracks by playCount.                                    |

---

## 6. Admin Panel & System Configuration

| Test ID            | Method / Scope                                          | Description & Assertions                                                      |
| :----------------- | :------------------------------------------------------ | :---------------------------------------------------------------------------- |
| `BE-ADMIN-001`     | `POST /api/v1/admin/login`                              | Admin login returns JWT admin token.                                          |
| `BE-ADMIN-002`     | `POST /api/v1/admin/login`                              | Rejects invalid admin credentials with 401 INVALID_CREDENTIALS.               |
| `BE-ADMIN-003`     | `POST /api/v1/admin/login`                              | Rejects missing username or password with 400 BAD_REQUEST.                    |
| `BE-ADMIN-004`     | `GET /api/v1/admin/me`                                  | Returns admin profile when authenticated.                                     |
| `BE-ADMIN-005`     | `GET /api/v1/admin/me`                                  | Rejects regular user access tokens with 401 UNAUTHORIZED.                     |
| `BE-ADMIN-006`     | `POST /api/v1/admin/password`                           | Changes admin password, bumps tokenVersion and invalidates old sessions.      |
| `BE-ADMIN-007`     | `POST /api/v1/admin/password`                           | Rejects incorrect current password with 400 WRONG_PASSWORD.                   |
| `BE-ADMIN-008`     | `GET /api/v1/admin/config`                              | Returns all system settings with current and fallback values.                 |
| `BE-ADMIN-009`     | `PUT /api/v1/admin/config/:key`                         | Rejects unrecognized setting key with 404 NOT_FOUND.                          |
| `BE-ADMIN-010`     | `PUT /api/v1/admin/config/:key`                         | Rejects invalid setting URL value with 400 BAD_REQUEST.                       |
| `BE-ADMIN-011`     | `GET /api/v1/admin/analytics/overview`                  | Aggregates daily analytics, play counts, and user metrics.                    |
| `BE-ADMIN-012`     | `GET /api/v1/admin/analytics/requests`                  | Aggregates request volume, latency percentiles (p50, p95), and route metrics. |
| `BE-ADMIN-013`     | `GET /api/v1/admin/errors`                              | Returns paginated error logs with totals and breakdown by source.             |
| `BE-ADMIN-014`     | `DELETE /api/v1/admin/errors/:id`                       | Deletes specific error log entry.                                             |
| `BE-ADM-EXTRA-001` | `PUT /api/v1/admin/config/:key`                         | Updates valid piped.apiUrl setting.                                           |
| `BE-ADM-EXTRA-002` | `PUT /api/v1/admin/config/:key`                         | Resets setting to fallback value by passing null.                             |
| `BE-ADM-EXTRA-003` | `DELETE /api/v1/admin/errors/:id`                       | Returns 404 for non-existent error ID.                                        |
| `BE-ADM-EXTRA-004` | `DELETE /api/v1/admin/errors/:id`                       | Returns 400 for non-integer ID parameter.                                     |
| `BE-ADM-EXTRA-005` | `GET /api/v1/admin/analytics/overview`                  | Accepts custom window days query parameter.                                   |
| `BE-ADM-EXTRA-006` | `GET /api/v1/admin/analytics/requests`                  | Accepts custom window hours query parameter.                                  |
| `BE-ADM-CFG-001`   | `GET /api/v1/admin/config/piped.extractorCommit/latest` | Queries latest NewPipeExtractor commit from GitHub API.                       |
| `BE-ADM-CFG-002`   | `PUT /api/v1/admin/config/piped.extractorCommit`        | Saves valid commit hash to system configuration.                              |
| `BE-ADM-SEC-001`   | `POST /api/v1/admin/login`                              | Enforces rate limiting lockout after 5 consecutive failures.                  |
| `BE-ADM-SEC-002`   | `POST /api/v1/admin/password`                           | Rejects new password identical to current password.                           |
| `BE-ADM-SEC-003`   | `POST /api/v1/admin/password`                           | Rejects short new password (<8 characters).                                   |
| `BE-ADM-SEC-004`   | `GET /api/v1/admin/errors`                              | Filters error logs by source and text search query.                           |
| `BE-ADM-COV-001`   | `PUT /api/v1/admin/config/:key`                         | Rejects unparseable setting value.                                            |
| `BE-ADM-COV-002`   | `GET /api/v1/admin/analytics/overview`                  | Accepts timezone query parameter.                                             |
| `BE-ADM-BR-001`    | `requireAdmin` middleware                               | Handles database errors during admin authentication.                          |

---

## 7. App Routes & Image Proxy

| Test ID         | Method / Scope                            | Description & Assertions                                   |
| :-------------- | :---------------------------------------- | :--------------------------------------------------------- |
| `BE-APP-001`    | `GET /api/v1/trending`                    | Returns filtered trending music tracks.                    |
| `BE-APP-002`    | `GET /api/v1/tracks/:id/artwork`          | Redirects to standard track artwork thumbnail.             |
| `BE-APP-003`    | `GET /api/v1/tracks/:id/artwork?size=640` | Redirects to large artwork thumbnail.                      |
| `BE-APP-004`    | `GET /api/v1/albums/:id/artwork`          | Redirects to proxy album cover artwork route.              |
| `BE-APP-005`    | `GET /api/v1/artists/:id/artwork`         | Redirects to artist avatar artwork image route.            |
| `BE-APP-006`    | `GET /api/v1/image/:token`                | Proxies image buffer with headers from upstream.           |
| `BE-APP-007`    | `GET /api/v1/image/:token`                | Returns 502 when image upstream fails.                     |
| `BE-APP-008`    | `GET /api/v1/lyrics/search`               | Queries LRCLIB search endpoint.                            |
| `BE-APP-009`    | `GET /api/v1/lyrics/search`               | Rejects missing track parameter with 400 BAD_REQUEST.      |
| `BE-APP-010`    | Route Not Found                           | Returns 404 NOT_FOUND for unmatched endpoints.             |
| `BE-APP-011`    | `GET /api/v1/stream/:token`               | Handles 416 range past end with proper total size header.  |
| `BE-ERR-001`    | `POST /api/v1/client-errors`              | Accepts crash report from web client.                      |
| `BE-ERR-002`    | `POST /api/v1/client-errors`              | Accepts warning report from linux client.                  |
| `BE-ERR-003`    | `POST /api/v1/client-errors`              | Rejects invalid source name with 400 BAD_REQUEST.          |
| `BE-ERR-004`    | `POST /api/v1/client-errors`              | Rejects missing error message with 400 BAD_REQUEST.        |
| `BE-ERR-005`    | `POST /api/v1/client-errors`              | Rejects excessive context keys (>20) with 400 BAD_REQUEST. |
| `BE-ERR-BR-001` | Error handling                            | Handles invalid tokens returning 403 FORBIDDEN.            |
| `BE-RESIL-001`  | Stream token                              | Verifies signing with custom TTL.                          |
| `BE-RESIL-002`  | Stream range                              | Tests audio slice Range request header.                    |
| `BE-RESIL-003`  | Single stream                             | Tests track with single audio stream format.               |
| `BE-RESIL-004`  | High quality                              | Tests quality=high stream resolution.                      |
| `BE-RESIL-005`  | Normal quality                            | Tests quality=normal stream resolution.                    |
| `BE-RESIL-006`  | Muxed stream                              | Tests fallback to muxed video stream.                      |
| `BE-RESIL-007`  | Dynamic albums                            | Tests search fallback when channel releases tab is absent. |

---

## 8. Unit, Database, Normalization & Utility Suites

### IDs Helpers

| Test ID      | Description                                |
| :----------- | :----------------------------------------- |
| `BE-IDS-001` | Extracts YouTube ID from prefixed string.  |
| `BE-IDS-002` | Throws error when string lacks yt: prefix. |
| `BE-IDS-003` | Adds local: prefix.                        |
| `BE-IDS-004` | Adds sonare: prefix.                       |
| `BE-IDS-005` | Adds yt: prefix.                           |
| `BE-IDS-006` | Parses channel URL patterns.               |
| `BE-IDS-007` | Returns null for invalid channel URL.      |
| `BE-IDS-008` | Extracts artist ID from URL.               |
| `BE-IDS-009` | Extracts playlist list ID from URL.        |
| `BE-IDS-010` | Returns null when list param is absent.    |

### Data Normalization

| Test ID            | Description                                    |
| :----------------- | :--------------------------------------------- |
| `BE-NORM-001`      | Attaches user metadata fields to tracks.       |
| `BE-NORM-002`      | Generates proxy image route URL.               |
| `BE-NORM-003`      | Normalizes full Piped stream to track shape.   |
| `BE-NORM-004`      | Handles track with missing uploader.           |
| `BE-NORM-005`      | Converts search item to track shape.           |
| `BE-NORM-006`      | Converts search channel to artist shape.       |
| `BE-NORM-007`      | Converts search playlist to album shape.       |
| `BE-NORM-008`      | Normalizes channel tab album item.             |
| `BE-NORM-009`      | Normalizes channel object to artist view.      |
| `BE-NORM-010`      | Normalizes playlist object to full album view. |
| `BE-NORM-011`      | Looks up thumbnail cache.                      |
| `BE-NORM-HELP-001` | Handles null artist name fallback.             |
| `BE-NORM-HELP-002` | Handles unknown channel ID fallback.           |
| `BE-NORM-HELP-003` | Parses release year from description.          |
| `BE-NORM-HELP-004` | Credits top uploader in compilation albums.    |
| `BE-NORM-HELP-005` | Maps AAC and FLAC codec strings.               |

### Core Utilities

| Test ID            | Description                              |
| :----------------- | :--------------------------------------- |
| `BE-PURE-001`      | Signs and verifies stream token payload. |
| `BE-PURE-002`      | Rejects expired stream token.            |
| `BE-PURE-003`      | Rejects tampered stream token signature. |
| `BE-PURE-004`      | Rejects malformed token format.          |
| `BE-PURE-005`      | BadRequestError properties.              |
| `BE-PURE-006`      | NoAudioStreamError properties.           |
| `BE-PURE-007`      | UpstreamError properties.                |
| `BE-PURE-008`      | Waveform fallback generation.            |
| `BE-PURE-009`      | Parses LRC lyrics lines and timestamps.  |
| `BE-PURE-010`      | Strips metadata tags from lyrics.        |
| `BE-PURE-011`      | Rate limiter hit and window reset.       |
| `BE-ERR-CLASS-001` | BadRequestError instantiation.           |
| `BE-ERR-CLASS-002` | BadRequestError default message.         |
| `BE-ERR-CLASS-003` | NoAudioStreamError default message.      |
| `BE-ERR-CLASS-004` | NoAudioStreamError custom message.       |
| `BE-ERR-CLASS-005` | UpstreamError default unreachable.       |
| `BE-ERR-CLASS-006` | UpstreamError unreachable flag.          |
| `BE-ERR-CLASS-007` | UpstreamError name check.                |
| `BE-ERR-CLASS-008` | Error inheritance checks.                |
| `BE-ERR-CLASS-009` | `StreamTokenError`                       | Has status 403 and code FORBIDDEN. |
| `BE-RATE-001`      | Rate limiter allows hits under limit.    |
| `BE-RATE-002`      | Rate limiter blocks hits over limit.     |
| `BE-RATE-003`      | Rate limiter reset method.               |
| `BE-RATE-004`      | Rate limiter IP isolation.               |

### Configuration

| Test ID          | Description                                                                   |
| :--------------- | :---------------------------------------------------------------------------- |
| `BE-CONF-001`    | Parses TCP PostgreSQL URL.                                                    |
| `BE-CONF-002`    | Parses Unix socket PostgreSQL URL.                                            |
| `BE-CONF-003`    | Parses URL with default port.                                                 |
| `BE-CONF-004`    | Validates environment variables schema.                                       |
| `BE-CONF-005`    | `assertProductionConfig` accepts a complete production config.                |
| `BE-CONF-006`    | `assertProductionConfig` rejects the dev or a short JWT_SECRET in production. |
| `BE-CONF-007`    | `assertProductionConfig` rejects missing SMTP_USER / SMTP_PASS in production. |
| `BE-CONF-008`    | `assertProductionConfig` rejects a non-https APP_URL in production.           |
| `BE-CONF-009`    | `assertProductionConfig` skips all checks outside production.                 |
| `BE-CONF-010`    | `parseTrustProxy` maps TRUST_PROXY to Express's `trust proxy` value.          |
| `BE-MAIL-001`    | `verifyEmailMessage` has the subject and the link in text and html.           |
| `BE-MAIL-002`    | `resetPasswordMessage` has the subject and the link in text and html.         |
| `BE-SYS-001`     | Normalizes and validates configuration URLs.                                  |
| `BE-SYS-002`     | Validates commit hash format.                                                 |
| `BE-SYS-003`     | Describes all available settings.                                             |
| `BE-SYS-004`     | Saves configuration to database.                                              |
| `BE-SYS-005`     | Tests live Piped API health check.                                            |
| `BE-SYS-006`     | Reports down status when health check fails.                                  |
| `BE-SYS-007`     | Fetches latest commit from GitHub API.                                        |
| `BE-SYS-COV-001` | Validates commit existence via GitHub API.                                    |
| `BE-SYS-COV-002` | Reports 404 for non-existent commit.                                          |

### Upstream Clients

| Test ID              | Description                                |
| :------------------- | :----------------------------------------- |
| `BE-UPS-001`         | Piped search client.                       |
| `BE-UPS-002`         | Piped search nextpage client.              |
| `BE-UPS-003`         | Piped getStream client.                    |
| `BE-UPS-004`         | Piped playlist client.                     |
| `BE-UPS-005`         | Piped channel client.                      |
| `BE-UPS-006`         | Piped suggestions client.                  |
| `BE-UPS-007`         | Piped upstream 500 error handling.         |
| `BE-UPS-008`         | Piped upstream network connection failure. |
| `BE-UPS-009`         | Lrclib get lyrics happy path.              |
| `BE-UPS-010`         | Lrclib get lyrics 404 clean handling.      |
| `BE-UPS-011`         | Lrclib search endpoint.                    |
| `BE-UPS-012`         | Genius search client.                      |
| `BE-UPS-013`         | Genius song details client.                |
| `BE-PIPED-EXTRA-001` | Piped trending with custom region.         |
| `BE-PIPED-EXTRA-002` | Piped playlist nextpage pagination.        |

### Cache Layer

| Test ID            | Description                                  |
| :----------------- | :------------------------------------------- |
| `BE-CACHE-001`     | CachedPiped stream caching.                  |
| `BE-CACHE-002`     | CachedPiped playlist caching.                |
| `BE-CACHE-003`     | CachedPiped channel caching.                 |
| `BE-CACHE-004`     | PermanentCache lyrics storage and retrieval. |
| `BE-CACHE-005`     | PermanentCache peaks storage and retrieval.  |
| `BE-CACHE-DEG-001` | Cache fallback on Redis degradation.         |
| `BE-CACHE-DEG-002` | CachedPiped trending method export.          |

### Telemetry & Logging

| Test ID            | Description                                       |
| :----------------- | :------------------------------------------------ |
| `BE-TELEM-001`     | Extracts client name from X-Sonare-Client header. |
| `BE-TELEM-002`     | Aggregates repeated errors in burst buffer.       |
| `BE-TELEM-003`     | Flushes error buffer to PostgreSQL.               |
| `BE-TELEM-COV-001` | Handles long error message truncation.            |
| `BE-TELEM-COV-002` | Idempotent telemetry worker startup.              |

### Database & Schema

| Test ID            | Description                                   |
| :----------------- | :-------------------------------------------- |
| `BE-DB-001`        | Users table insert and query.                 |
| `BE-DB-002`        | Refresh tokens table cascading delete.        |
| `BE-DB-003`        | Favourite tracks table operations.            |
| `BE-DB-004`        | Favourite albums table operations.            |
| `BE-DB-005`        | Artist follows table operations.              |
| `BE-DB-006`        | Play history recording and count aggregation. |
| `BE-DB-007`        | Playlist and playlist_tracks ordering.        |
| `BE-DB-008`        | User settings persistence.                    |
| `BE-DB-009`        | Player state persistence.                     |
| `BE-DB-010`        | Lyrics overrides storage.                     |
| `BE-DB-011`        | Admin user token version increment.           |
| `BE-DB-012`        | Error logs table insert.                      |
| `BE-DB-013`        | Request logs table insert.                    |
| `BE-DB-014`        | System configuration table insert.            |
| `BE-DB-015`        | getUserTrackDataMap batching.                 |
| `BE-DB-016`        | hydrateTracks formatting.                     |
| `BE-DB-INT-001`    | Enforces email unique constraint.             |
| `BE-DB-INT-002`    | Verifies user deletion cascade.               |
| `BE-DB-VERIFY-001` | Verifies database connection check.           |
| `BE-SCH-001`       | Users schema definition.                      |
| `BE-SCH-002`       | RefreshTokens schema definition.              |
| `BE-SCH-003`       | FavouriteTracks schema definition.            |
| `BE-SCH-004`       | FavouriteAlbums schema definition.            |
| `BE-SCH-005`       | ArtistFollows schema definition.              |
| `BE-SCH-006`       | PlayHistory schema definition.                |
| `BE-SCH-007`       | Playlists schema definition.                  |
| `BE-SCH-008`       | PlaylistTracks schema definition.             |
| `BE-SCH-009`       | UserSettings schema definition.               |
| `BE-SCH-010`       | PlayerState schema definition.                |
| `BE-SCH-011`       | LyricsOverrides schema definition.            |
| `BE-SCH-012`       | AdminUsers schema definition.                 |
| `BE-SCH-013`       | SystemConfiguration schema definition.        |
| `BE-SCH-014`       | RequestLogs schema definition.                |
| `BE-SCH-015`       | ErrorLogs schema definition.                  |
| `BE-HYDR-001`      | Empty tracks hydration.                       |
| `BE-HYDR-002`      | Local track hydration.                        |
| `BE-HYDR-003`      | Guest track fields default values.            |
| `BE-HYDR-004`      | Empty map handling.                           |
| `BE-HYDR-005`      | Undefined user map handling.                  |

### Admin Auth

| Test ID          | Description                               |
| :--------------- | :---------------------------------------- |
| `BE-ADMAUTH-001` | Admin JWT token signing and verification. |
| `BE-ADMAUTH-002` | requireAdmin middleware export check.     |

### Peaks Extraction

| Test ID        | Description                                    |
| :------------- | :--------------------------------------------- |
| `BE-PEAKS-001` | Bounded floating point peak levels generation. |
| `BE-PEAKS-002` | Deterministic waveform generation.             |
| `BE-PEAKS-003` | Synthetic peak fallback.                       |

## 9. Request validation

Every body and query is checked with zod (`src/validation.ts`); a bad request gets 400 `BAD_REQUEST`
with the first problem as the message, and nothing is written.

| Test ID      | Method / Scope                                | Description & Assertions                                                     |
| :----------- | :-------------------------------------------- | :--------------------------------------------------------------------------- |
| `BE-VAL-001` | `POST /api/v1/me/playlists`                   | Name over 100 characters → 400 with the length message; no playlist created. |
| `BE-VAL-002` | `PATCH /api/v1/me/playlists/:id`              | Description over 500 characters → 400; stored description unchanged.         |
| `BE-VAL-003` | `POST /api/v1/me/playlists/:id/tracks`        | An empty track id → 400; no tracks added.                                    |
| `BE-VAL-004` | `DELETE /api/v1/me/playlists/:id/tracks`      | Negative index → 400; the playlist keeps its track.                          |
| `BE-VAL-005` | `PATCH /api/v1/me/playlists/:id/tracks/order` | Non-numeric `from` → 400.                                                    |
| `BE-VAL-006` | `PUT /api/v1/me/settings`                     | Unknown `streamQuality` → 400; the stored value stays.                       |
| `BE-VAL-007` | `PUT /api/v1/me/player-state`                 | Unknown `repeat` mode → 400; no state row written.                           |
| `BE-VAL-008` | `POST /api/v1/me/sync`                        | A play without `at` → 400; none of the plays recorded.                       |
| `BE-VAL-009` | `GET /api/v1/me/recently-played`              | Non-numeric `limit` → 400.                                                   |
| `BE-VAL-010` | `GET /api/v1/me/library/tracks`               | Unknown `sort` → 400.                                                        |
| `BE-VAL-011` | `GET /api/v1/me/most-played`                  | `limit=0` → 400 "Must be at least 1".                                        |
| `BE-VAL-012` | `POST /api/v1/tracks/:id/lyrics`              | Neither `lrc` nor `plain` → 400 "Send lrc or plain lyrics".                  |
| `BE-VAL-013` | `PATCH /api/v1/tracks/:id/lyrics/offset`      | Non-numeric `offsetMs` → 400 "offsetMs must be a number".                    |
| `BE-VAL-014` | `GET /api/v1/tracks/:id/lyrics`               | Unknown `prefer` → 400.                                                      |
| `BE-VAL-015` | `GET /api/v1/search`                          | Unknown `type` → 400.                                                        |
| `BE-VAL-016` | `GET /api/v1/search`                          | `q` over 200 characters → 400 with the length message.                       |
| `BE-VAL-017` | `GET /api/v1/search/suggestions`              | Blank `q` → 400 "Missing query parameter: q".                                |
| `BE-VAL-018` | `GET /api/v1/trending`                        | `limit=500` → 400 "Must be at most 100".                                     |
| `BE-VAL-019` | `GET /api/v1/trending`                        | `region=India` → 400 "region must be a two-letter country code".             |
| `BE-VAL-020` | `POST /api/v1/auth/logout`                    | Non-string `refreshToken` → 400.                                             |
