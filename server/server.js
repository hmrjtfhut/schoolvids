/*
Simple Express server that accepts authenticated uploads from the frontend
Stores uploads locally temporarily, then uploads to Google Drive (single trusted account).

Environment variables required (set these before running):
- PORT (optional, default 3000)
- FIREBASE_ADMIN_SA_PATH : path to Firebase service account JSON (for verifying ID tokens)
- GOOGLE_OAUTH_CREDENTIALS_PATH : path to OAuth2 client credentials JSON (client_id/client_secret)
- GOOGLE_OAUTH_TOKEN_PATH : path to previously saved token.json with refresh_token (see get_token.js)
- DRIVE_SHARED_ID : (optional) ID of the Shared Drive to place uploads into
- MAX_FILE_SIZE_BYTES : optional override for max upload size (default 512MB)

Notes:
- This is a PoC. For production, secure env and secrets, and validate thoroughly.
*/

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const {google} = require('googleapis');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, {recursive:true});

// Basic config
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_BYTES || (512 * 1024 * 1024)); // 512MB default
const ALLOWED_MIMES = [
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'
];

// Multer for handling multipart uploads and temporary local storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\- _]/g, '_');
    cb(null, safeName);
  }
});
const upload = multer({
  storage,
  limits: {fileSize: MAX_FILE_SIZE},
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type'));
  }
});

// Rate limiting: e.g., 10 uploads per 15 minutes per IP
const limiter = rateLimit({windowMs: 15 * 60 * 1000, max: 20});

const app = express();
app.use(cors());
app.use(express.json());
app.use(limiter);

// Initialize Firebase Admin for token verification
if (!process.env.FIREBASE_ADMIN_SA_PATH) {
  console.error('FIREBASE_ADMIN_SA_PATH not set. Exiting.');
  process.exit(1);
}
const sa = require(process.env.FIREBASE_ADMIN_SA_PATH);
admin.initializeApp({credential: admin.credential.cert(sa)});

// Initialize Google OAuth2 client (uses saved token.json)
if (!process.env.GOOGLE_OAUTH_CREDENTIALS_PATH || !process.env.GOOGLE_OAUTH_TOKEN_PATH) {
  console.error('GOOGLE_OAUTH_CREDENTIALS_PATH or GOOGLE_OAUTH_TOKEN_PATH not set. Exiting.');
  process.exit(1);
}
const credentials = require(process.env.GOOGLE_OAUTH_CREDENTIALS_PATH);
const {client_secret, client_id, redirect_uris} = credentials.installed || credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
const token = require(process.env.GOOGLE_OAUTH_TOKEN_PATH);
oAuth2Client.setCredentials(token);
const drive = google.drive({version:'v3', auth: oAuth2Client});
const SHARED_DRIVE_ID = process.env.DRIVE_SHARED_ID || null;

// Middleware: verify Firebase ID token in Authorization header
async function verifyToken(req, res, next) {
  const authHeader = req.get('Authorization') || '';
  const m = authHeader.match(/^Bearer (.*)$/);
  if (!m) return res.status(401).send('Missing Authorization Bearer token');
  const idToken = m[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    // attach basic info
    req.user = {uid: decoded.uid, email: decoded.email, name: decoded.name || ''};
    next();
  } catch (err) {
    console.error('Token error', err);
    res.status(401).send('Invalid token');
  }
}

// Upload endpoint
app.post('/upload', verifyToken, upload.single('video'), async (req, res) => {
  // Validate presence
  if (!req.file) return res.status(400).send('No file uploaded');

  // Additional metadata from client
  const {title = req.file.originalname, uploaderName, uploaderEmail, district, timestamp} = req.body;

  // Enforce that uploaderEmail matches verified token email
  if (uploaderEmail && req.user && uploaderEmail !== req.user.email) {
    // Not necessarily fatal, but log and enforce
    console.warn('Uploader email mismatch:', uploaderEmail, req.user.email);
    return res.status(403).send('Uploader email mismatch');
  }

  // Build folder path: /DistrictName/UserEmail/VideoTitle/
  try {
    const districtFolderId = await ensureFolderExists(null, district || 'unknown_district');
    const userFolderId = await ensureFolderExists(districtFolderId, uploaderEmail || req.user.email || 'unknown_user');
    const videoFolderId = await ensureFolderExists(userFolderId, sanitizeFilename(title || req.file.originalname));

    // Upload the video file to Drive under videoFolderId
    const fileMetadata = {
      name: req.file.originalname,
      parents: [videoFolderId]
    };
    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path)
    };
    const createRes = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, name',
      supportsAllDrives: true
    });
    const driveFileId = createRes.data.id;

    // Create metadata JSON and upload it as well
    const metadata = {
      uploaderName: uploaderName || req.user.name || '',
      uploaderEmail: uploaderEmail || req.user.email || '',
      uploadTime: timestamp || new Date().toISOString(),
      title: title || req.file.originalname,
      driveFileId
    };
    const metadataPath = path.join(UPLOAD_DIR, `${driveFileId}.metadata.json`);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    await drive.files.create({
      requestBody: {name: `${driveFileId}.metadata.json`, parents: [videoFolderId], mimeType: 'application/json'},
      media: {mimeType: 'application/json', body: fs.createReadStream(metadataPath)},
      fields: 'id',
      supportsAllDrives: true
    });

    // Remove local files to save space
    try { fs.unlinkSync(req.file.path); fs.unlinkSync(metadataPath); } catch (e) {}

    // Return info to client — include an embed/view URL
    const embedUrl = `https://drive.google.com/file/d/${driveFileId}/preview`;
    res.json({status: 'ok', driveFileId, embedUrl});
  } catch (err) {
    console.error('Upload processing failed', err);
    res.status(500).send('Upload failed: ' + err.message);
  }
});

// Simple listing endpoint — lists recent videos for a district (searches folders)
app.get('/list', async (req, res) => {
  const district = req.query.district;
  if (!district) return res.status(400).send('district query required');

  try {
    // Find district folder
    const q = `mimeType='application/vnd.google-apps.folder' and name='${escapeQuery(district)}' and trashed=false` + (SHARED_DRIVE_ID ? '' : '');
    const found = await drive.files.list({q, spaces: 'drive', fields: 'files(id,name,parents)', includeItemsFromAllDrives: true, supportsAllDrives: true});
    if (!found.data.files || found.data.files.length === 0) return res.json([]);
    const districtId = found.data.files[0].id;
    // find video files under the district recursively would be more complex. For simplicity, list files with parents under district using a query matching the name pattern and mimeType not folder.
    const fileQ = `'${districtId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed=false`;
    const files = await drive.files.list({q: fileQ, fields: 'files(id,name,parents,webViewLink)', includeItemsFromAllDrives: true, supportsAllDrives: true});
    const items = (files.data.files || []).map(f => ({
      title: f.name,
      driveFileId: f.id,
      embedUrl: `https://drive.google.com/file/d/${f.id}/preview`,
      webViewLink: f.webViewLink || ''
    }));
    res.json(items);
  } catch (err) {
    console.error('List failed', err);
    res.status(500).send('List failed');
  }
});

app.listen(PORT, () => console.log('Server listening on', PORT));

// ---------------- helpers ----------------
function sanitizeFilename(name) {
  if (!name) return 'untitled';
  return name.replace(/[\/:*?"<>|]/g, '_').slice(0, 200);
}

function escapeQuery(s) {
  return s.replace(/'/g, "\\'");
}

// Ensure a folder with `name` exists under parentId (if parentId null, create/lookup at drive root or shared drive root)
async function ensureFolderExists(parentId, name) {
  // Build query depending on parent
  let q;
  if (parentId) {
    q = `mimeType='application/vnd.google-apps.folder' and name='${escapeQuery(name)}' and '${parentId}' in parents and trashed=false`;
  } else if (SHARED_DRIVE_ID) {
    // top-level folder inside the shared drive
    q = `mimeType='application/vnd.google-apps.folder' and name='${escapeQuery(name)}' and trashed=false and '${SHARED_DRIVE_ID}' in parents`;
  } else {
    q = `mimeType='application/vnd.google-apps.folder' and name='${escapeQuery(name)}' and trashed=false`;
  }

  const resp = await drive.files.list({q, fields: 'files(id,name)', includeItemsFromAllDrives: true, supportsAllDrives: true});
  if (resp.data.files && resp.data.files.length > 0) return resp.data.files[0].id;

  // create folder
  const fileMetadata = {name, mimeType: 'application/vnd.google-apps.folder'};
  if (parentId) fileMetadata.parents = [parentId];
  else if (SHARED_DRIVE_ID) fileMetadata.parents = [SHARED_DRIVE_ID];

  const created = await drive.files.create({requestBody: fileMetadata, fields: 'id', supportsAllDrives: true});
  return created.data.id;
}
