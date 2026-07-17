const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

var TEMPLATE = [
'<!-- ',
"README TEMPLATE for TheBooleanJulian / Accurova repos.",
"Delete any section that doesn't apply to this project. Keep it tight.",
"Sections marked [optional] are only for public/shared repos.",
'-->',
'',
'<div align="center">',
'',
'# Project Name',
'',
"**One-line pitch: what it does and who it's for.**",
'',
'![Python](https://img.shields.io/badge/-Python-3776AB?logo=python&logoColor=white)',
'![FastAPI](https://img.shields.io/badge/-FastAPI-009688?logo=fastapi&logoColor=white)',
'![SQLite](https://img.shields.io/badge/-SQLite-003B57?logo=sqlite&logoColor=white)',
'![Zeabur](https://img.shields.io/badge/-Zeabur-6C5CE7)',
'![License](https://img.shields.io/badge/license-MIT-00D4C8.svg)',
'',
'</div>',
'',
'---',
'',
'![Hero screenshot](assets/hero.png)',
'',
'## What it does',
'',
"2-4 sentences on the problem solved, who it's for, what makes it worth using.",
'',
'## Features',
'',
'- Feature one',
'- Feature two',
'',
'## Tech Stack',
'',
'| Layer | Choice |',
'|---|---|',
'| Backend | FastAPI + SQLite |',
'| Frontend | Single-file HTML / React + Vite |',
'| Bot | python-telegram-bot (polling) |',
'| AI | Claude API |',
'| Hosting | Zeabur (GitHub CI/CD, feature -> dev -> main) |',
'',
'## Quick Start',
'',
'```bash',
'git clone <repo>',
'cd <repo>',
'pip install -r requirements.txt',
'cp .env.example .env',
'python main.py',
'```',
'',
'## Configuration',
'',
'| Variable | Required | Description |',
'|---|---|---|',
'',
'## Project Structure',
'',
'```',
'repo-name/',
'|-- main.py',
'|-- static/',
'`-- requirements.txt',
'```',
'',
'## Deployment',
'',
'Deployed on Zeabur via GitHub Actions CI/CD. Push to main triggers deploy.',
'',
'## Status / Roadmap',
'',
'- [x] Core feature working',
'- [ ] Next thing planned',
'',
'## Changelog',
'',
"Summarised from commit history, most recent first. Not a full log.",
'',
'- **[recent period]** — summary of what changed',
'',
'## License',
'',
'MIT, or note if private/client-facing.',
'',
'---',
'',
'<div align="center">',
'<sub>Built by <a href="https://github.com/TheBooleanJulian">@TheBooleanJulian</a></sub>',
'</div>'
].join('\n');

var IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
var HERO_NAME = /(hero|screenshot|demo|preview|banner|cover)/i;
var ASSET_DIRS = ['assets', 'docs', '.github', 'screenshots', 'images', 'img'];
var REPO_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

async function ghFetch(url, token) {
  var headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'readme-forge' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var res = await fetch(url, { headers: headers });
  if (!res.ok) {
    if (res.status === 404) throw new Error("Repo not found (404). Check the URL, or add a token if it's private.");
    if (res.status === 403) throw new Error('GitHub API rate-limited (403). Add a personal access token to continue.');
    throw new Error('GitHub API error: ' + res.status);
  }
  return res.json();
}

async function tryFetchRaw(downloadUrl) {
  try {
    var res = await fetch(downloadUrl);
    if (!res.ok) return null;
    var text = await res.text();
    return text.length > 6000 ? text.slice(0, 6000) + '\n...[truncated]' : text;
  } catch (e) { return null; }
}

function pickHeroImage(entries) {
  var images = entries.filter(function(f) { return f.type === 'file' && IMAGE_EXT.test(f.name); });
  if (!images.length) return null;
  var named = images.filter(function(f) { return HERO_NAME.test(f.name); });
  return named[0] || images[0];
}

async function findHeroImage(base, token, rootContents) {
  var rootHit = pickHeroImage(Array.isArray(rootContents) ? rootContents : []);
  if (rootHit) return rootHit.path;

  var dirCandidates = Array.isArray(rootContents)
    ? rootContents.filter(function(f) { return f.type === 'dir' && ASSET_DIRS.indexOf(f.name.toLowerCase()) !== -1; })
    : [];

  for (var i = 0; i < dirCandidates.length; i++) {
    try {
      var dirContents = await ghFetch(base + '/contents/' + dirCandidates[i].path, token);
      var hit = pickHeroImage(Array.isArray(dirContents) ? dirContents : []);
      if (hit) return hit.path;
    } catch (e) { /* skip unreadable dir */ }
  }
  return null;
}

async function buildRepoContext(owner, repo, token) {
  var base = 'https://api.github.com/repos/' + owner + '/' + repo;

  var results = await Promise.all([
    ghFetch(base, token),
    ghFetch(base + '/languages', token),
    ghFetch(base + '/contents', token).catch(function() { return []; }),
    ghFetch(base + '/commits?per_page=30', token).catch(function() { return []; })
  ]);
  var meta = results[0];
  var languages = results[1];
  var contents = results[2];
  var commits = results[3];

  var fileNames = Array.isArray(contents) ? contents.map(function(f) { return f.name; }) : [];

  var wantFiles = ['package.json', 'requirements.txt', 'pyproject.toml', 'Dockerfile', 'docker-compose.yml', 'main.py', 'app.py'];
  var fileFetches = Array.isArray(contents) ? contents.filter(function(f) { return wantFiles.indexOf(f.name) !== -1 && f.download_url; }) : [];
  var fileContents = {};
  await Promise.all(fileFetches.map(async function(f) {
    var txt = await tryFetchRaw(f.download_url);
    if (txt) fileContents[f.name] = txt;
  }));

  var existingReadme = null;
  try {
    var readmeMeta = await ghFetch(base + '/readme', token);
    if (readmeMeta.download_url) {
      existingReadme = await tryFetchRaw(readmeMeta.download_url);
    }
  } catch (e) { /* no readme, fine */ }

  var heroImagePath = null;
  try {
    heroImagePath = await findHeroImage(base, token, contents);
  } catch (e) { /* no hero image found, fine */ }

  var commitLogBlock = '(no commit history available)';
  if (Array.isArray(commits) && commits.length) {
    commitLogBlock = commits.map(function(c) {
      var msg = (c.commit && c.commit.message ? c.commit.message.split('\n')[0] : '').slice(0, 120);
      var date = (c.commit && c.commit.author && c.commit.author.date) ? c.commit.author.date.slice(0, 10) : '';
      return date + ' — ' + msg;
    }).join('\n');
  }

  var detectedFilesBlock = '';
  for (var name in fileContents) {
    detectedFilesBlock += '--- ' + name + ' ---\n' + fileContents[name] + '\n\n';
  }
  if (!detectedFilesBlock) detectedFilesBlock = '(none found in root)';

  return [
    'REPO METADATA:',
    '- Name: ' + meta.name,
    '- Description: ' + (meta.description || '(none set)'),
    '- Default branch: ' + meta.default_branch,
    '- Homepage: ' + (meta.homepage || '(none)'),
    '- Topics: ' + ((meta.topics && meta.topics.join(', ')) || '(none)'),
    '- Private: ' + meta.private,
    '- Languages detected: ' + (Object.keys(languages).join(', ') || 'unknown'),
    '',
    'ROOT FILE LISTING:',
    fileNames.join(', ') || '(could not list, may be empty or private)',
    '',
    'DETECTED CONFIG/ENTRY FILES:',
    detectedFilesBlock,
    '',
    'HERO IMAGE: ' + (heroImagePath ? heroImagePath : '(no screenshot/hero/demo/banner image found in root, assets/, docs/, .github/, screenshots/, images/, or img/)'),
    '',
    'COMMIT HISTORY (most recent 30, oldest last):',
    commitLogBlock,
    '',
    'EXISTING README (for reference only, reuse real facts/content from it, do not just copy structure):',
    existingReadme ? existingReadme.slice(0, 4000) : '(no existing README found)'
  ].join('\n');
}

function buildPrompt(repoContext) {
  return "You are generating a README.md for a GitHub repo, strictly following the template below. This is for TheBooleanJulian's (Julian) repo fleet, mostly Python/FastAPI/SQLite backends, single-file HTML frontends, Telegram bots (python-telegram-bot, polling), React/Vite frontends, deployed on Zeabur via GitHub CI/CD (feature -> dev -> main branching).\n\n" +
    "TEMPLATE TO FOLLOW:\n" + TEMPLATE + "\n\n" +
    "RULES:\n" +
    "- Follow the template's section order and structure exactly, but DELETE any section that genuinely doesn't apply to this repo (e.g. no Telegram section if there's no bot, no Deployment section if there's no evidence of Zeabur/CI, no Project Structure tree if it's a true single-file tool).\n" +
    "- Fill in real details inferred from the repo data below. Do not invent features, env vars, or stats that aren't evidenced by the file listing, config files, or existing README.\n" +
    "- Keep the tech stack table only to what's actually detected.\n" +
    "- Keep badges relevant to the actual stack detected, don't include a badge for a language/framework with no evidence.\n" +
    '- Write a tight, concrete "What it does" paragraph and a real features list based on the existing README and file names if available.\n' +
    "- If there's no existing README and the file listing is sparse, keep sections short rather than padding with generic filler, leave placeholder brackets like [describe X] only where truly nothing can be inferred.\n" +
    "- Hero image: use the HERO IMAGE path given in REPO DATA below verbatim in the image markdown (e.g. ![Hero screenshot](<path>)). If HERO IMAGE says none was found, DELETE the hero image line entirely, do not invent or guess a path like assets/hero.png.\n" +
    "- Changelog: read COMMIT HISTORY and write 3-8 bullets that SUMMARISE the real work into meaningful, grouped entries (e.g. group several related commits into one bullet about what actually changed from a user's perspective). Do not just copy raw commit messages 1:1, skip trivial commits (typo fixes, merge commits, 'wip', formatting-only). Order most recent first. If COMMIT HISTORY says none available, delete the whole Changelog section.\n" +
    "- Output ONLY the final README.md markdown. No preamble, no commentary, no code fence wrapping the whole output.\n\n" +
    "REPO DATA:\n" + repoContext;
}

app.use(express.json({ limit: '100kb' }));
app.use(express.static(__dirname, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

var generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many README generations from this IP. Try again later.' }
});

app.post('/api/generate', generateLimiter, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY.' });
  }

  var owner = req.body && req.body.owner;
  var repo = req.body && req.body.repo;
  var token = req.body && req.body.token;

  if (typeof owner !== 'string' || typeof repo !== 'string' || !REPO_NAME_RE.test(owner) || !REPO_NAME_RE.test(repo)) {
    return res.status(400).json({ error: 'Invalid owner/repo.' });
  }
  if (token && typeof token !== 'string') {
    return res.status(400).json({ error: 'Invalid token.' });
  }

  try {
    var repoContext = await buildRepoContext(owner, repo, token);
    var prompt = buildPrompt(repoContext);

    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    var data = await response.json();
    if (!response.ok) {
      var message = (data && data.error && data.error.message) || ('Claude API error: ' + response.status);
      return res.status(response.status).json({ error: message });
    }

    var textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text);
    var md = textBlocks.join('\n').trim();
    md = md.replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '');

    res.json({ text: md, owner: owner, repo: repo });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Something went wrong.' });
  }
});

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('readme-forge listening on port ' + PORT);
});
