/**
 * Makes a minimal 1-token API call to fetch real rate-limit headers from Anthropic.
 * Parses `anthropic-ratelimit-unified-*` headers (used for Claude.ai OAuth subscribers).
 * Writes result to ~/.claude/last-response-headers.json for token-reader.js.
 */
'use strict';

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const https = require('https');

const CLAUDE_DIR   = path.join(os.homedir(), '.claude');
const CREDS_FILE   = path.join(CLAUDE_DIR, '.credentials.json');
const HEADERS_FILE = path.join(CLAUDE_DIR, 'last-response-headers.json');

function getAccessToken() {
  const raw   = fs.readFileSync(CREDS_FILE, 'utf8').replace(/^﻿/, '');
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (oauth && oauth.accessToken) return { token: oauth.accessToken, type: 'bearer', expiresAt: oauth.expiresAt };
  if (creds.apiKey) return { token: creds.apiKey, type: 'apikey' };
  throw new Error('No credentials in ~/.claude/.credentials.json');
}

function callApi(auth) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: '0' }],
    });

    const reqHeaders = {
      'Content-Type':       'application/json',
      'anthropic-version':  '2023-06-01',
      'Content-Length':     Buffer.byteLength(body),
    };
    if (auth.type === 'bearer') reqHeaders['Authorization'] = `Bearer ${auth.token}`;
    else                        reqHeaders['x-api-key']     = auth.token;

    const req = https.request(
      { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: reqHeaders },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function parseUnifiedHeaders(rawHeaders) {
  // Claude.ai OAuth uses anthropic-ratelimit-unified-* instead of x-ratelimit-*
  const claim = rawHeaders['anthropic-ratelimit-unified-representative-claim'] || 'five_hour';
  const key   = claim === 'five_hour' ? '5h' : '7d';

  const utilization = parseFloat(rawHeaders[`anthropic-ratelimit-unified-${key}-utilization`] || '0');
  const resetEpoch  = parseInt(rawHeaders[`anthropic-ratelimit-unified-${key}-reset`] || '0', 10);
  const resetAt     = resetEpoch ? new Date(resetEpoch * 1000).toISOString() : null;
  const windowLabel = claim === 'five_hour' ? '5-hour' : '7-day';

  return { utilization, resetAt, resetEpoch, windowLabel, claim };
}

async function run(silent) {
  const auth   = getAccessToken();
  const result = await callApi(auth);

  if (result.status !== 200) throw new Error(`API returned HTTP ${result.status}`);

  const h = result.headers;

  // Try unified headers (OAuth / Claude.ai subscription)
  if (h['anthropic-ratelimit-unified-representative-claim']) {
    const parsed = parseUnifiedHeaders(h);

    // Preserve sessionStartUtilization from the first fetch this session
    let sessionStart = parsed.utilization;
    try {
      const existing = JSON.parse(fs.readFileSync(HEADERS_FILE, 'utf8'));
      // If reset epoch matches (same window), keep the original start
      if (existing.resetEpoch === parsed.resetEpoch && existing.sessionStartUtilization !== undefined) {
        sessionStart = existing.sessionStartUtilization;
      }
    } catch (_) {}

    const cached = {
      source:                  'unified',
      windowLabel:             parsed.windowLabel,
      utilization:             parsed.utilization,
      sessionStartUtilization: sessionStart,
      resetAt:                 parsed.resetAt,
      resetEpoch:              parsed.resetEpoch,
    };
    fs.writeFileSync(HEADERS_FILE, JSON.stringify(cached, null, 2));
    if (!silent) {
      console.log(`Rate limit (${parsed.windowLabel} window): ${Math.round(parsed.utilization * 100)}% used`);
      if (parsed.resetAt) {
        const mins = Math.round((parsed.resetEpoch * 1000 - Date.now()) / 60000);
        console.log(`Resets in: ${Math.floor(mins / 60)}h ${mins % 60}min  (${parsed.resetAt})`);
      }
    }
    return cached;
  }

  // Fallback: standard x-ratelimit-* headers (API key users)
  const remaining = parseInt(h['x-ratelimit-remaining-tokens'] || h['x-ratelimit-remaining-input-tokens'] || '0', 10);
  const limit     = parseInt(h['x-ratelimit-limit-tokens']     || h['x-ratelimit-limit-input-tokens']     || '0', 10);
  if (limit) {
    const cached = { source: 'ratelimit', remaining, limit, resetAt: h['x-ratelimit-reset-tokens'] || null };
    fs.writeFileSync(HEADERS_FILE, JSON.stringify(cached, null, 2));
    if (!silent) console.log(`Rate limit: ${Math.round((1 - remaining / limit) * 100)}% used (${remaining}/${limit})`);
    return cached;
  }

  throw new Error('No rate-limit headers found in API response');
}

module.exports = { run };

if (require.main === module) {
  run(false).catch(err => { console.error('Error:', err.message); process.exit(1); });
}
