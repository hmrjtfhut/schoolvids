/*
Helper to obtain and store OAuth2 token for the trusted Google account.
Run: `node get_token.js` and follow the printed URL, paste back the code.
This creates the token JSON at the path you choose below and can be used by server.js

Requires: set environment variable GOOGLE_OAUTH_CREDENTIALS_PATH to the client credentials file path
*/
const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');

if (!process.env.GOOGLE_OAUTH_CREDENTIALS_PATH) {
  console.error('Set GOOGLE_OAUTH_CREDENTIALS_PATH to the client credentials JSON path');
  process.exit(1);
}
const creds = require(process.env.GOOGLE_OAUTH_CREDENTIALS_PATH);
const {client_secret, client_id, redirect_uris} = creds.installed || creds.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.metadata'];

const rl = readline.createInterface({input: process.stdin, output: process.stdout});

const authUrl = oAuth2Client.generateAuthUrl({access_type: 'offline', scope: SCOPES});
console.log('Authorize this app by visiting this url:', authUrl);
rl.question('Enter the code from that page here: ', async (code) => {
  rl.close();
  try {
    const r = await oAuth2Client.getToken(code);
    console.log('Token acquired. Save to a file and set GOOGLE_OAUTH_TOKEN_PATH to that path.');
    console.log(JSON.stringify(r.tokens, null, 2));
  } catch (err) {
    console.error('Error retrieving token', err);
  }
});
