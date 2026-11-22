// Disposable Windows CI only. All profile contents and credentials are fictional.
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {_electron} from 'playwright';

if (process.platform !== 'win32' || process.env.CI !== 'true') throw Error('Disposable Windows CI only.');
const [phase, candidateArg, manifestArg] = process.argv.slice(2);
const candidate = resolve(candidateArg), manifestFile = resolve(manifestArg);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const release = JSON.parse(Buffer.from(manifest.payload, 'base64'));
let executable;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tree = (root, prefix = '') => Object.fromEntries(readdirSync(root, {withFileTypes: true}).flatMap(entry => {
  const name = prefix + entry.name;
  return entry.isDirectory() ? Object.entries(tree(join(root, entry.name), name + '/')) : [[name, digest(readFileSync(join(root, entry.name)))]];
}));
let app;
async function open() {
  assert.ok(existsSync(executable), 'The installed executable is missing: ' + executable);
  app = await _electron.launch({executablePath: executable, timeout: 60000});
  const page = await app.firstWindow();
  return page;
}
function snapshot(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'household.sqlite'), {readOnly: true});
  try {
    return {content: db.prepare('SELECT content FROM household_preview WHERE id=1').get().content,
      settings: db.prepare('SELECT key,value FROM household_settings ORDER BY key').all().map(row => ({...row})),
      setup: digest(readFileSync(join(dataDir, 'ostrow-clan-setup.bin')))};
  } finally { db.close(); }
}

try {
  executable = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-ChildItem ($env:LOCALAPPDATA + '\\Programs') -Filter 'Ostrow Clan.exe' -Recurse | Select-Object -First 1 -ExpandProperty FullName"], {encoding: 'utf8'}).trim();
  assert.ok(executable, 'The baseline did not install its executable');
  console.log('Installed executable found');
  if (phase === 'seed') {
  let page = await open();
  await page.waitForURL('file:///**/setup.html', {timeout: 30000});
  const location = await app.evaluate(({app, safeStorage}) => {
    const req = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
    const fs = req('node:fs'), path = req('node:path'), crypto = req('node:crypto');
    const {DatabaseSync} = req('node:sqlite');
    const {emptyState} = req(path.join(app.getAppPath(), 'src/sample.mjs'));
    const dataDir = app.getPath('userData');
    const {privateKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const setup = {google: {url: 'https://docs.google.com/spreadsheets/d/syntheticWindowsOnly9876543210/edit',
      key: JSON.stringify({type: 'service_account', client_email: 'test@synthetic.iam.gserviceaccount.com',
        private_key: privateKey.export({type: 'pkcs8', format: 'pem'})})}, plaid: null};
    fs.writeFileSync(path.join(dataDir, 'ostrow-clan-setup.bin'), safeStorage.encryptString(JSON.stringify(setup)).toString('base64'));
    const state = {...emptyState('household'), onboardingComplete: true, onboardingTourComplete: true};
    state.categories[0].name = 'My saved category';
    state.budgets = [{categoryId: 'mortgage', month: '2026-11', cents: 123456}];
    state.plans = [{id: 'existing-plan', name: 'My saved project', type: 'house', priority: 'priority', cost: 65432,
      reserved: 12345, status: 'saving', date: '', notes: 'Keep my notes', revision: 9,
      advanced: {enabled: true, stage: 'initial', tasks: [{id: 'existing-task', title: 'Keep my task', done: false, deadline: '', visibleStage: 'all', advanceTo: ''}], costItems: []}}];
    state.accounts = [{id: 'synthetic-checking', name: 'Checking', nickname: 'My saved nickname', type: 'checking', balance: 125000}];
    state.transactions = [{id: 'saved-transaction', date: '2026-11-01', merchant: 'Fictional merchant', amount: -1234,
      accountId: 'synthetic-checking', categoryId: 'mortgage', kind: 'purchase'}];
    state.rules = [{key: 'fictional merchant', merchant: 'Fictional merchant', categoryId: 'mortgage'}];
    const db = new DatabaseSync(path.join(dataDir, 'household.sqlite'));
    db.exec('CREATE TABLE household_preview (id INTEGER PRIMARY KEY,content TEXT NOT NULL)');
    db.prepare('INSERT INTO household_preview VALUES (1,?)').run(JSON.stringify(state)); db.close();
    const source = path.join(app.getPath('documents'), 'Ostrow Clan', 'Customize with Codex');
    fs.appendFileSync(path.join(source, 'public/styles.css'), '\n/* MY CUSTOM STYLE MUST SURVIVE */\n');
    fs.writeFileSync(path.join(source, 'my-custom-note.txt'), 'Keep my custom files');
    return {dataDir, source};
  });
  await app.close(); app = null;
  page = await open(); await page.waitForURL('http://127.0.0.1:*/**', {timeout: 45000});
  const before = snapshot(location.dataDir), sourceBefore = tree(location.source);
  await app.close(); app = null;
  writeFileSync('synthetic-profile.json', JSON.stringify({location, before, sourceBefore}));
  console.log('Synthetic populated profile and modified source saved');
  } else {
  assert.equal(phase, 'verify');
  const {location, before, sourceBefore} = JSON.parse(readFileSync('synthetic-profile.json', 'utf8'));
  let page = await open(); await page.waitForURL('http://127.0.0.1:*/**', {timeout: 45000});
  await page.getByRole('link', {name: 'Settings', exact: true}).click();
  await page.getByRole('heading', {name: 'App updates', exact: true}).waitFor();
  assert.deepEqual(snapshot(location.dataDir), before);
  assert.deepEqual(tree(location.source), sourceBefore);
  assert.ok(existsSync(join(location.dataDir, 'backups', 'before-' + release.version, 'manifest.json')));
  const installerInfo = await app.evaluate(({app}) => ({version: app.getVersion(), packaged: app.isPackaged}));
  assert.equal(installerInfo.version, release.version); assert.equal(installerInfo.packaged, true);
  const guidePath = join(location.source, '..', 'START-HERE.txt');
  const guide = readFileSync(guidePath).toString('utf16le');
  assert.ok(guide.includes(location.source));
  await page.screenshot({path: 'windows-update-settings.png'});

  // Baseline 0.1.1 had no updater. Exercise the shipped candidate controller
  // with an older-version adapter against its real signed installer and helper.
  const result = await app.evaluate(async ({app}, {manifest, version}) => {
    const req = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
    const fs = req('node:fs'), path = req('node:path');
    const {AppUpdater} = req(path.join(app.getAppPath(), 'desktop/updater.mjs'));
    const {updatePolicy} = req(path.join(app.getAppPath(), 'desktop/update-policy.mjs'));
    const {ensureUpgradeBackup} = req(path.join(app.getAppPath(), 'desktop/upgrade-backup.mjs'));
    const {launchWindowsInstaller} = req(path.join(app.getAppPath(), 'desktop/update-installer.mjs'));
    const config = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'desktop/release.json')));
    const dataDir = app.getPath('userData'), phases = [];
    const options = {version: '0.1.1', config, dataDir,
      fetcher: async (url, options) => url.endsWith('/update.json') ? Response.json(manifest) : fetch(url, options)};
    const custom = new AppUpdater({...options, canInstall: () => false,
      launchInstall: async () => { throw Error('Custom installer guard failed'); }});
    await custom.check({automatic: true});
    if (custom.info().phase !== 'ready') throw Error('Signed real download failed: ' + JSON.stringify(custom.info()));
    await custom.install();
    if (!custom.info().error?.includes('custom build')) throw Error('Custom build was not blocked');
    const exported = JSON.parse(fs.readFileSync(path.join(app.getPath('documents'), 'Ostrow Clan', 'Customize with Codex', 'package.json')));
    if (updatePolicy(exported, {packaged: true, platform: 'win32'}).canInstall) throw Error('Editable source can accept official installs');
    const updater = new AppUpdater({...options,
      onChange: state => phases.push(state.phase),
      prepareInstall: release => ensureUpgradeBackup(dataDir, release.version, {attempt: true}),
      launchInstall: async (installer, release, installing) => {
        await launchWindowsInstaller({dataDir, installer, release});
        installing(); setTimeout(() => app.quit(), 250);
      }});
    await updater.check(); await updater.download(); await updater.install();
    if (updater.info().phase !== 'installing') throw Error('Helper handoff failed: ' + JSON.stringify(updater.info()));
    return {phases, targetVersion: version, customBlocked: true};
  }, {manifest, version: release.version});
  app = null;
  const statusPath = join(location.dataDir, 'updates', 'install-status.json');
  let complete = false;
  for (let n = 0; n < 180; n++) {
    try {
      const status = JSON.parse(readFileSync(statusPath, 'utf8'));
      if (status.phase === 'failed') throw Error('Native helper failed');
      if (status.phase === 'complete') { assert.equal(status.version, release.version); complete = true; break; }
    } catch (error) { if (error.message === 'Native helper failed') throw error; }
    await sleep(1000);
  }
  assert.equal(complete, true, 'Updated app did not reopen and acknowledge startup');
  const visible = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process -Name 'Ostrow Clan' | Where-Object MainWindowHandle -ne 0 | Select-Object -ExpandProperty Id"], {encoding: 'utf8'}).trim();
  assert.ok(visible, 'Reopened app has no visible window');
  assert.deepEqual(snapshot(location.dataDir), before);
  assert.deepEqual(tree(location.source), sourceBefore);
  const report = {version: release.version, baseline: '0.1.1', actualInstallerUpgrade: true, dataPreserved: true,
    protectedSetupPreserved: true, modifiedSourcePreserved: true, customBlocked: true,
    signedDownload: true, realInstallerAndHelper: true, visibleAutomaticReopen: true,
    updaterHopUsesOlderVersionAdapter: true, phases: [...new Set(result.phases)]};
  writeFileSync('windows-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  }
} finally {
  if (app) try { await app.close(); } catch {}
  spawnSync('taskkill.exe', ['/F', '/IM', 'Ostrow Clan.exe'], {stdio: 'ignore'});
}
