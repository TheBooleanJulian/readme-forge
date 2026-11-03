// readme-forge on Cloudflare Workers (replaces the Express server.js that ran on Zeabur).
//
//   POST /api/generate   { owner, repo, token? } → { text, owner, repo } | { error }
//   GET  /healthz        liveness + whether the gateway binding is present
//   everything else      public/index.html (static assets)
//
// No model keys here: the prompt goes to thebooleanjulian-llm over the LLM service binding. Public repos use the
// `readme-generate` use case; private repos (read with the visitor's own token) use `readme-generate-private`,
// which the gateway never routes to the free pool. Per-visitor rate limit: GENERATE_LIMIT binding (by IP).

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
'![Version](https://img.shields.io/badge/version-0.1.0-00D4C8)',
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
'**Done**',
'',
'- [x] Core feature working',
'',
'**Planned / Suggestions**',
'',
'- Next thing planned or a concrete gap worth addressing',
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
    var res = await fetch(downloadUrl, { headers: { 'User-Agent': 'readme-forge' } });
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

// Returns { context, isPrivate }: the prompt's REPO DATA block, and whether GitHub says the repo is private.
export async function buildRepoContext(owner, repo, token) {
  var base = 'https://api.github.com/repos/' + owner + '/' + repo;

  var results = await Promise.all([
    ghFetch(base, token),
    ghFetch(base + '/languages', token),
    ghFetch(base + '/contents', token).catch(function() { return []; }),
    ghFetch(base + '/commits?per_page=30', token).catch(function() { return []; }),
    ghFetch(base + '/tags?per_page=5', token).catch(function() { return []; })
  ]);
  var meta = results[0];
  var languages = results[1];
  var contents = results[2];
  var commits = results[3];
  var tags = results[4];

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

  var latestTag = (Array.isArray(tags) && tags.length && tags[0].name) ? tags[0].name : null;

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

  var context = [
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
    'LATEST GIT TAG: ' + (latestTag ? latestTag : '(no tags found — infer a reasonable version from commit history/changelog instead)'),
    '',
    'COMMIT HISTORY (most recent 30, oldest last):',
    commitLogBlock,
    '',
    'EXISTING README (for reference only, reuse real facts/content from it, do not just copy structure):',
    existingReadme ? existingReadme.slice(0, 4000) : '(no existing README found)'
  ].join('\n');

  return { context: context, isPrivate: meta.private === true };
}

export function buildPrompt(repoContext) {
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
    "- Version badge: if LATEST GIT TAG is present, use that exact tag (strip a leading 'v' for the badge number, e.g. tag v2.3.0 -> badge text 2.3.0) — this is a real release, state it as-is. If no tag was found, infer a reasonable unofficial version from the commit history: look for conventional-commit prefixes (feat:, fix:, breaking/BREAKING CHANGE) to reason about major/minor/patch, or if commits aren't conventional-style, estimate from how many distinct feature groups appear in your Changelog (start around 0.1.0 for a young repo). Update the badge text accordingly. Never fabricate a precise-looking version with no basis — when inferring, keep it a round, defensible number.\n" +
    "- Roadmap: split '## Status / Roadmap' into a 'Done' list (checked items evidently working, based on real features/config found) and a 'Planned / Suggestions' list. For suggestions, only list concrete, evidenced gaps — e.g. no test files found, no CI config, no .env.example despite env vars in code, no error handling visible, no LICENSE file despite a license badge. Do not invent a feature roadmap or business-y suggestions with no evidence. If genuinely nothing concrete to suggest, keep it to 1-2 modest items rather than padding.\n" +
    "- Output ONLY the final README.md markdown. No preamble, no commentary, no code fence wrapping the whole output.\n\n" +
    "REPO DATA:\n" + repoContext;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function generate(request, env) {
  if (!env.LLM) return json({ error: 'Server is missing the LLM gateway binding.' }, 500);

  var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.GENERATE_LIMIT) {
    var limit = await env.GENERATE_LIMIT.limit({ key: ip });
    if (!limit.success) return json({ error: 'Too many README generations from this IP. Try again later.' }, 429);
  }

  var body = await request.json().catch(function() { return null; });
  var owner = body && body.owner;
  var repo = body && body.repo;
  var token = body && body.token;

  if (typeof owner !== 'string' || typeof repo !== 'string' || !REPO_NAME_RE.test(owner) || !REPO_NAME_RE.test(repo)) {
    return json({ error: 'Invalid owner/repo.' }, 400);
  }
  if (token && typeof token !== 'string') {
    return json({ error: 'Invalid token.' }, 400);
  }

  try {
    var built = await buildRepoContext(owner, repo, token);
    var res = await env.LLM.fetch('https://llm/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TBJ-Service': 'readme-forge',
        'X-TBJ-Use-Case': built.isPrivate ? 'readme-generate-private' : 'readme-generate'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: buildPrompt(built.context) }], max_tokens: 4000 })
    });
    var data = await res.json().catch(function() { return null; });
    if (!res.ok) {
      var code = (data && data.error && data.error.code) || res.status;
      console.log(JSON.stringify({ svc: 'readme-forge', gateway_status: res.status, code: code, trace: res.headers.get('x-tbj-trace-id') }));
      return json({ error: 'README generation failed (' + code + '). Try again in a minute.' }, 502);
    }

    var md = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    md = md.replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '');
    return json({ text: md, owner: owner, repo: repo });
  } catch (err) {
    return json({ error: err.message || 'Something went wrong.' }, 502);
  }
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    if (url.pathname === '/api/generate') {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      return generate(request, env);
    }
    if (url.pathname === '/healthz') {
      return json({ status: 'pass', gateway: env.LLM ? 'bound' : 'missing' });
    }
    return env.ASSETS.fetch(request);
  }
};
