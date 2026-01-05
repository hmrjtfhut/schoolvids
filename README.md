District Video Upload — Proof of Concept

Overview
- Single-file frontend `index.html` (Firebase Auth + Google Sign-In)
- Node.js backend `server/server.js` accepts authenticated uploads, saves temporarily, uploads to Google Drive under a single trusted account
- Domain-restricted access: only Google accounts at `wlsstudents.org` allowed by frontend check

Quick start (backend)
1. Clone repo and install dependencies in `server/`:

   cd server
   npm install

2. Prepare Firebase:
- Create a Firebase project and enable Google Authentication.
- Obtain the Firebase config and paste into `index.html`'s `firebaseConfig` (client-side safe keys).
- Create a Firebase service account JSON for admin operations and download it.
- Set `FIREBASE_ADMIN_SA_PATH` to the path of that JSON.

3. Prepare Google Drive OAuth credentials (trusted account)
- In Google Cloud Console, create OAuth client credentials (Desktop or Web), download the `credentials.json`.
- Set `GOOGLE_OAUTH_CREDENTIALS_PATH` to that file path.
- Run the helper to get a token (one-time) and store the JSON output as `token.json` and set `GOOGLE_OAUTH_TOKEN_PATH` to that path:

   cd server
   set GOOGLE_OAUTH_CREDENTIALS_PATH=path\\to\\credentials.json
   node get_token.js

- Use the printed token JSON and save it to a file (e.g., `token.json`).

4. (Optional) Use a Shared Drive: set `DRIVE_SHARED_ID` to the Shared Drive ID. Otherwise files go to the trusted account's Drive.

5. Environment variables (example on Windows PowerShell):

   $env:FIREBASE_ADMIN_SA_PATH = 'C:\path\to\firebase-service-account.json'
   $env:GOOGLE_OAUTH_CREDENTIALS_PATH = 'C:\path\to\credentials.json'
   $env:GOOGLE_OAUTH_TOKEN_PATH = 'C:\path\to\token.json'
   $env:DRIVE_SHARED_ID = '0Axxx...'
   npm start

6. Open `index.html` in a static host (or Firebase Hosting) and configure `BACKEND_UPLOAD_URL`/`BACKEND_LIST_URL` accordingly.

Frontend notes
- The frontend uses Firebase Auth (client) to sign in and obtain an ID token.
- The ID token is sent in `Authorization: Bearer <token>` header to the backend; the backend verifies it with Firebase Admin.
- The client enforces email domain `wlsstudents.org`. Backend also ensures the email in metadata matches verified token.
- Upload progress shown is for the browser -> backend upload (XHR). Server->Drive progress is not streamed to the client in this PoC.

Security & limitations
- Do NOT store secrets in the frontend. The Drive OAuth client and token are only used on the server.
- This is a PoC. For real deployments: use HTTPS, restrict CORS, harden rate-limits, scan uploads, and consider resumable uploads for large files.

Files created
- index.html
- server/server.js
- server/package.json
- server/get_token.js
- .gitignore
- README.md

Next steps (suggested)
- Configure Firebase Hosting to serve `index.html` and set the allowed origin.
- Optionally add a small admin UI to set video visibility or moderate content.
- Improve listing endpoint to recursively list videos inside district/user folders.

