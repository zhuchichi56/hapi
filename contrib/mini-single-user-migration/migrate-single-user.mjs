#!/usr/bin/env node
/**
 * HAPI WWX single-user migration helper for macOS.
 *
 * The default paths describe the deployed Mini. Tests and a dry run may use
 * HAPI_MIGRATION_* overrides. This file deliberately never prints credential
 * contents. Web authentication is read only in memory for migration checks.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const env = process.env
const cfg = {
    legacyHome: env.HAPI_MIGRATION_LEGACY_HOME || '/Users/hapi-wwx',
    newHome: env.HAPI_MIGRATION_NEW_HOME || '/Users/zhuhe',
    projectHome: env.HAPI_MIGRATION_PROJECT_HOME || '/Users/zhuhe/.local/lib/hapi-mini/projects/wwx/home',
    canonicalCwd: env.HAPI_MIGRATION_CWD || '/Users/zhuhe/Workspaces/wwx',
    plistDir: env.HAPI_MIGRATION_PLIST_DIR || '/Library/LaunchDaemons',
    isoRoot: env.HAPI_MIGRATION_ISO_ROOT || '/Library/Application Support/HAPI-WWX-Isolation',
    backupRoot: env.HAPI_MIGRATION_BACKUP_ROOT || '/var/root/hapi-wwx-migration',
    oldUser: env.HAPI_MIGRATION_OLD_USER || 'hapi-wwx',
    newUser: env.HAPI_MIGRATION_NEW_USER || 'zhuhe',
    oldUid: Number(env.HAPI_MIGRATION_OLD_UID || 560),
    newUid: Number(env.HAPI_MIGRATION_NEW_UID || 501),
    hubPort: Number(env.HAPI_MIGRATION_HUB_PORT || 3026),
    proxyPort: Number(env.HAPI_MIGRATION_PROXY_PORT || 4126),
}

const labels = ['run.hapi.wwx.proxy', 'run.hapi.wwx.hub', 'run.hapi.wwx.runner']
const plistPaths = labels.map((label) => path.join(cfg.plistDir, `${label}.plist`))
const wrapperSource = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hapi-single-user-run')
const wrapperTarget = path.join(cfg.isoRoot, 'bin', 'hapi-tenant-run')
const pathKeys = new Set(['path', 'homeDir', 'happyHomeDir', 'cwd', 'workspaceRoot', 'rollout_path'])
// Migrate the service and project data, not a macOS login profile. Everything
// else (including Library, Mail and Documents) stays untouched in the old home.
const migratedHomeRoots = ['.hapi', '.codex', '.claude', '.claude.json', 'work']

function isExcludedHomePath(root, file) {
    const relative = path.relative(root, file)
    return relative !== '' && !migratedHomeRoots.includes(relative.split(path.sep)[0])
}

function die(message, code = 1) {
    console.error(`ERROR: ${message}`)
    process.exitCode = code
    throw new Error(message)
}

function log(message) {
    console.log(message)
}

function exists(p) {
    try { fs.accessSync(p); return true } catch { return false }
}

function isDir(p) {
    try { return fs.statSync(p).isDirectory() } catch { return false }
}

function shell(tool, args, options = {}) {
    return execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', options.stdioErr || 'pipe'], ...options }).trim()
}

function tryShell(tool, args, options = {}) {
    const r = spawnSync(tool, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', options.stdioErr || 'pipe'], ...options })
    return { status: r.status ?? 1, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() }
}

function timestamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function safeRelative(root, file) {
    const rel = path.relative(root, file)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path escapes root: ${file}`)
    return rel || '.'
}

function mapPath(value) {
    if (typeof value !== 'string') return value
    if (value.startsWith(cfg.legacyHome + path.sep) && isExcludedHomePath(cfg.legacyHome, value)) return value
    const oldWork = path.join(cfg.legacyHome, 'work')
    const oldHapi = path.join(cfg.legacyHome, '.hapi')
    if (value === oldWork || value.startsWith(`${oldWork}${path.sep}`)) return cfg.canonicalCwd + value.slice(oldWork.length)
    if (value === oldHapi || value.startsWith(`${oldHapi}${path.sep}`)) return path.join(cfg.projectHome, '.hapi') + value.slice(oldHapi.length)
    if (value === cfg.legacyHome || value.startsWith(`${cfg.legacyHome}${path.sep}`)) return cfg.projectHome + value.slice(cfg.legacyHome.length)
    return value
}

function rewriteStructured(value, key = '') {
    if (Array.isArray(value)) return value.map((v) => rewriteStructured(v, key))
    if (value && typeof value === 'object') {
        const out = {}
        for (const [k, v] of Object.entries(value)) out[k] = k === 'homeDir' && v === cfg.legacyHome ? cfg.newHome : pathKeys.has(k) ? mapPath(v) : rewriteStructured(v, k)
        return out
    }
    return pathKeys.has(key) ? mapPath(value) : value
}

function transformJsonFile(file) {
    let parsed
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return false }
    const rewritten = rewriteStructured(parsed)
    const text = JSON.stringify(rewritten, null, 2) + '\n'
    if (text === fs.readFileSync(file, 'utf8')) return false
    fs.writeFileSync(file, text, { mode: fs.statSync(file).mode & 0o777 })
    return true
}

function sqlQuote(value) {
    return `'${String(value).replaceAll("'", "''")}'`
}

function sqliteExec(db, sql, extra = []) {
    const result = tryShell('/usr/bin/sqlite3', ['-readonly', db, ...extra, sql])
    if (result.status !== 0) throw new Error(`sqlite3 failed for ${db}: ${result.stderr || result.stdout}`)
    return result.stdout
}

function sqliteBackup(source, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    try { fs.unlinkSync(destination) } catch {}
    const sql = `.backup ${sqlQuote(destination)}`
    const r = tryShell('/usr/bin/sqlite3', [source, sql])
    if (r.status !== 0) throw new Error(`SQLite backup failed for ${source}: ${r.stderr || r.stdout}`)
    // Offline backups have no WAL/SHM sidecars. Leave each snapshot standalone.
    shell('/usr/bin/sqlite3', [destination, 'PRAGMA journal_mode=DELETE;'])
}

function sqliteIntegrity(db) {
    const out = sqliteExec(db, 'PRAGMA integrity_check;')
    return out.trim() === 'ok'
}

function sqliteStructuredRewrite(db) {
    let tables
    try { tables = sqliteExec(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';").split(/\r?\n/).filter(Boolean) } catch { return 0 }
    let changed = 0
    for (const table of tables) {
        const columns = sqliteExec(db, `PRAGMA table_info(${sqlQuote(table)});`).split(/\r?\n/).filter(Boolean).map((line) => line.split('|')[1]).filter(Boolean)
        if (['sessions', 'machines'].includes(table) && columns.includes('metadata') && columns.includes('id')) {
            const rows = JSON.parse(sqliteExec(db, `SELECT id,metadata FROM "${table}";`, ['-json']) || '[]')
            for (const row of rows) {
                if (!row.metadata) continue
                const original = JSON.parse(row.metadata)
                const metadata = JSON.stringify(rewriteStructured(original))
                if (metadata !== JSON.stringify(original)) {
                    shell('/usr/bin/sqlite3', [db, `UPDATE "${table}" SET metadata=${sqlQuote(metadata)},metadata_version=metadata_version+1 WHERE id=${sqlQuote(row.id)};`])
                    changed++
                }
            }
        }
        for (const column of columns) {
            if (table !== 'threads' || !['cwd', 'rollout_path'].includes(column)) continue
            const ident = '"' + column.replaceAll('"', '""') + '"'
            const tableIdent = '"' + table.replaceAll('"', '""') + '"'
            const oldHome = sqlQuote(cfg.legacyHome)
            const oldWork = sqlQuote(path.join(cfg.legacyHome, 'work'))
            const newHome = sqlQuote(cfg.projectHome)
            const newWork = sqlQuote(cfg.canonicalCwd)
            const selectedPaths = migratedHomeRoots.map(root => path.join(cfg.legacyHome, root))
            const selectedWhere = [`${ident}=${oldHome}`, ...selectedPaths.map(root => `(${ident}=${sqlQuote(root)} OR ${ident} LIKE ${sqlQuote(root + '/%')})`)].join(' OR ')
            const sql = `UPDATE ${tableIdent} SET ${ident}=CASE WHEN ${ident}=${oldWork} OR ${ident} LIKE ${sqlQuote(path.join(cfg.legacyHome, 'work') + '/%')} THEN ${newWork} || substr(${ident}, ${path.join(cfg.legacyHome, 'work').length + 1}) WHEN ${ident}=${oldHome} OR ${ident} LIKE ${sqlQuote(cfg.legacyHome + '/%')} THEN ${newHome} || substr(${ident}, ${cfg.legacyHome.length + 1}) ELSE ${ident} END WHERE ${ident} IS NOT NULL AND (${selectedWhere}); SELECT changes();`
            const r = tryShell('/usr/bin/sqlite3', [db, sql])
            if (r.status !== 0) throw new Error(`SQLite structured path rewrite failed for ${db}: ${r.stderr || r.stdout}`)
            const count = Number(r.stdout || 0)
            changed += Number.isFinite(count) ? count : 0
        }
    }
    return changed
}

function findFiles(root) {
    const out = []
    if (!isDir(root)) return out
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name)
            if (isExcludedHomePath(root, p)) continue
            if (entry.isSymbolicLink()) continue
            if (entry.isDirectory()) walk(p)
            else if (entry.isFile()) out.push(p)
        }
    }
    walk(root)
    return out
}

function copyTree(source, destination) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
    const entries = fs.readdirSync(source).filter(name => migratedHomeRoots.includes(name))
    if (!entries.length) throw new Error('No HAPI/Agent/project data found to copy')
    // Enumerate only approved service roots. rsync never receives Library or
    // any other macOS profile directory as a source to inspect.
    const r = tryShell('/usr/bin/rsync', ['-aE', '--', ...entries.map(name => path.join(source, name)), destination + path.sep])
    if (r.status !== 0) throw new Error(`copy failed: ${r.stderr}`)
}

function copySqliteDatabases(sourceRoot, destinationRoot, backupRoot) {
    const copied = []
    for (const source of findFiles(sourceRoot)) {
        if (!/\.(db|sqlite|sqlite3)$/i.test(source)) continue
        const rel = safeRelative(sourceRoot, source)
        const destination = path.join(destinationRoot, rel)
        const backup = path.join(backupRoot, 'sqlite', rel)
        for (const sidecar of ['-wal', '-shm']) { try { fs.unlinkSync(destination + sidecar) } catch {} }
        sqliteBackup(source, destination)
        sqliteBackup(source, backup)
        if (!sqliteIntegrity(destination) || !sqliteIntegrity(backup)) throw new Error(`SQLite integrity_check failed: ${rel}`)
        copied.push(rel)
    }
    return copied
}

function rewriteCopiedMetadata(root) {
    let jsonChanged = 0
    let sqliteChanged = 0
    for (const file of findFiles(root)) {
        // History JSON/JSONL and arbitrary project files remain byte-for-byte intact.
        if (file === path.join(root, '.hapi', 'settings.json') && transformJsonFile(file)) jsonChanged++
        if (/\.(db|sqlite|sqlite3)$/i.test(file)) sqliteChanged += sqliteStructuredRewrite(file)
    }
    return { jsonChanged, sqliteChanged }
}

function plistXml(file) {
    const r = tryShell('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', file])
    if (r.status !== 0) throw new Error(`cannot parse plist ${file}: ${r.stderr || r.stdout}`)
    return r.stdout
}

function transformedPlist(file) {
    let xml = plistXml(file)
    const userRe = new RegExp(`(<key>UserName</key>\\s*<string>)${cfg.oldUser}(</string>)`)
    if (!userRe.test(xml)) throw new Error(`${file} does not contain expected UserName=${cfg.oldUser}`)
    xml = xml.replace(userRe, `$1${cfg.newUser}$2`)
    xml = xml.replaceAll(cfg.legacyHome, cfg.projectHome)
    xml = xml.replaceAll(path.join(cfg.projectHome, 'work'), cfg.canonicalCwd)
    xml = xml.replace(new RegExp(`(<key>HOME</key>\\s*<string>)${cfg.projectHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(</string>)`, 'g'), `$1${cfg.newHome}$2`)
    return xml
}

function backupPlists(backupDir) {
    fs.mkdirSync(path.join(backupDir, 'plists'), { recursive: true, mode: 0o700 })
    for (const file of plistPaths) {
        if (!exists(file)) throw new Error(`missing LaunchDaemon plist: ${file}`)
        fs.copyFileSync(file, path.join(backupDir, 'plists', path.basename(file)))
    }
}

function installTransformedPlists(backupDir) {
    for (const file of plistPaths) {
        const xml = transformedPlist(file)
        const temp = `${file}.migration-${process.pid}.tmp`
        fs.writeFileSync(temp, xml, { mode: 0o644 })
        const lint = tryShell('/usr/bin/plutil', ['-lint', temp])
        if (lint.status !== 0) { fs.unlinkSync(temp); throw new Error(`transformed plist failed lint: ${file}`) }
        fs.renameSync(temp, file)
        try { fs.chownSync(file, 0, 0) } catch {}
        fs.chmodSync(file, 0o644)
    }
    fs.writeFileSync(path.join(backupDir, 'plists', 'transformed.ok'), `${new Date().toISOString()}\n`, { mode: 0o600 })
}

function restorePlists(backupDir) {
    for (const file of plistPaths) {
        const backup = path.join(backupDir, 'plists', path.basename(file))
        if (!exists(backup)) throw new Error(`missing plist backup: ${backup}`)
        fs.copyFileSync(backup, file)
        try { fs.chownSync(file, 0, 0) } catch {}
        fs.chmodSync(file, 0o644)
    }
}

function launchctl(action, target) {
    if (action === 'bootout' && tryShell('/bin/launchctl', ['print', `system/${target}`]).status !== 0) return
    const r = tryShell('/bin/launchctl', action === 'bootout' ? ['bootout', `system/${target}`] : ['bootstrap', 'system', path.join(cfg.plistDir, `${target}.plist`)], { stdioErr: 'pipe' })
    if (r.status !== 0 && !/already bootstrapped|No such process|Could not find service/.test(r.stderr)) throw new Error(`launchctl ${action} ${target} failed: ${r.stderr || r.stdout}`)
}

function stopServices() {
    for (const label of [...labels].reverse()) launchctl('bootout', label)
}

function startServices() {
    for (const label of ['run.hapi.wwx.proxy', 'run.hapi.wwx.hub', 'run.hapi.wwx.runner']) launchctl('bootstrap', label)
}

function servicePids() {
    const result = {}
    for (const label of labels) {
        const r = tryShell('/bin/launchctl', ['print', `system/${label}`])
        if (r.status !== 0) { result[label] = null; continue }
        const m = r.stdout.match(/\bpid\s*=\s*(\d+)/)
        result[label] = m ? Number(m[1]) : null
    }
    return result
}

function verifyServiceUsers() {
    const pids = servicePids()
    const rows = []
    let ok = true
    for (const [label, pid] of Object.entries(pids)) {
        if (!pid) { rows.push({ label, pid, uid: null, ok: false }); ok = false; continue }
        const r = tryShell('/bin/ps', ['-p', String(pid), '-o', 'uid='])
        const uid = Number(r.stdout)
        const good = uid === cfg.newUid
        rows.push({ label, pid, uid: Number.isFinite(uid) ? uid : null, ok: good })
        if (!good) ok = false
    }
    return { ok, rows }
}

function tableSchema(db) {
    const tables = sqliteExec(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';").split(/\r?\n/).filter(Boolean)
    return tables.map((table) => ({ table, columns: sqliteExec(db, `PRAGMA table_info(${sqlQuote(table)});`).split(/\r?\n/).filter(Boolean).map((line) => line.split('|')[1]).filter(Boolean) }))
}

function dbSummary(root) {
    const rows = []
    for (const db of findFiles(root).filter((f) => /\.(db|sqlite|sqlite3)$/i.test(f))) {
        let tables = []
        try { tables = tableSchema(db) } catch { continue }
        let messages = null
        for (const item of tables) {
            if (/message/i.test(item.table) || item.columns.some((c) => /message/i.test(c))) {
                const table = '"' + item.table.replaceAll('"', '""') + '"'
                const r = tryShell('/usr/bin/sqlite3', ['-readonly', db, `SELECT count(*) FROM ${table};`])
                if (r.status === 0) messages = (messages ?? 0) + Number(r.stdout || 0)
            }
        }
        rows.push({ file: safeRelative(root, db), integrity: sqliteIntegrity(db), messages })
    }
    return rows
}

function checkReport() {
    const report = {
        mode: 'check',
        sideEffects: false,
        platform: process.platform,
        runningUid: typeof process.getuid === 'function' ? process.getuid() : null,
        expected: { oldUser: cfg.oldUser, oldUid: cfg.oldUid, newUser: cfg.newUser, newUid: cfg.newUid, labels },
        paths: {
            legacyHome: { path: cfg.legacyHome, exists: exists(cfg.legacyHome), directory: isDir(cfg.legacyHome) },
            projectHome: { path: cfg.projectHome, exists: exists(cfg.projectHome), directory: isDir(cfg.projectHome) },
            canonicalCwd: { path: cfg.canonicalCwd, exists: exists(cfg.canonicalCwd), directory: isDir(cfg.canonicalCwd) },
            plists: Object.fromEntries(plistPaths.map((p) => [p, exists(p)])),
        },
        taskScan: { count: null, evidence: ['Authenticated task checks run immediately before apply; no database opened by --check.'] },
        warnings: [
            'Authenticated task/history checks run during apply; credentials stay in memory.',
            'No real root apply or attachment/image validation is claimed by this report.',
        ],
    }
    return report
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function authenticatedApi() {
    const registry = JSON.parse(fs.readFileSync(path.join(cfg.newHome, '.local/lib/hapi-mini/data/web-access-codes.json'), 'utf8'))
    const code = registry.codes.find(item => item.namespace === 'wwx')?.code
    if (!code) throw new Error('WWX web access mapping is missing')
    const response = await fetch('http://127.0.0.1:3006/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: code }), signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('WWX web authentication failed')
    const { token } = await response.json()
    return async (route, body) => {
        const r = await fetch('http://127.0.0.1:3006/api' + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) })
        if (!r.ok) throw new Error(`WWX API ${route} failed (${r.status})`)
        return r.json()
    }
}

function hasPendingWork(session) {
    if (session.thinking || Object.keys(session.agentState?.requests || {}).length) return true
    for (const source of [session.agentState, session.metadata]) {
        for (const key of ['backgroundTasks', 'background', 'tasks']) {
            const tasks = source?.[key]
            if (!tasks) continue
            const values = Array.isArray(tasks) ? tasks : typeof tasks === 'object' ? Object.values(tasks) : [tasks]
            const ended = ['completed', 'complete', 'done', 'succeeded', 'success', 'failed', 'cancelled', 'canceled', 'stopped']
            if (values.some(task => task === true || typeof task === 'number' && task > 0 || typeof task === 'string' && !ended.includes(task.toLowerCase()) || typeof task === 'object' && task && !ended.includes(String(task.status || task.state || '').toLowerCase()))) return true
        }
    }
    return false
}

async function readSessions(api) {
    const { sessions } = await api('/sessions')
    if (!Array.isArray(sessions) || !sessions.length) throw new Error('WWX session list is empty or invalid')
    const details = []
    for (const s of sessions) {
        const { session } = await api('/sessions/' + s.id)
        if (!session || hasPendingWork(session)) throw new Error('WWX has unfinished thinking/tool/background work; migration postponed')
        details.push(session)
    }
    const db = path.join(cfg.legacyHome, '.hapi/hapi.db')
    if (exists(db)) {
        const columns = sqliteExec(db, 'PRAGMA table_info(messages);')
        if (columns.includes('|delivery_state|')) {
            const count = Number(sqliteExec(db, "SELECT count(*) FROM messages WHERE invoked_at IS NULL AND delivery_state='queued' AND (local_id IS NOT NULL OR scheduled_at IS NOT NULL);"))
            if (count) throw new Error('WWX has queued or scheduled messages; migration postponed')
        }
    }
    return details
}

function assertSessionWorkspaces(sessions) {
    const work = path.join(cfg.legacyHome, 'work')
    for (const session of sessions) {
        const cwd = session.metadata?.path
        if (typeof cwd === 'string' && cwd !== work && !cwd.startsWith(work + path.sep)) {
            throw new Error(`Session ${session.id} uses a directory outside the migrated project root: ${cwd}`)
        }
    }
}

async function archiveIdleSessions(api, sessions, uid = cfg.oldUid) {
    for (const session of sessions.filter(s => s.active)) await api('/sessions/' + session.id + '/archive', {})
    for (let attempt = 0; attempt < 30; attempt++) {
        let waiting = false
        for (const original of sessions.filter(s => s.active)) {
            const { session } = await api('/sessions/' + original.id)
            if (session.active || hasPendingWork(session)) waiting = true
            if (Number.isSafeInteger(original.metadata?.hostPid)) {
                const p = tryShell('/bin/ps', ['-p', String(original.metadata.hostPid), '-o', 'uid=', '-o', 'comm='])
                if (p.status === 0 && p.stdout.trim().startsWith(String(uid) + ' ') && p.stdout.includes('/opt/hapi-wwx/bin/')) waiting = true
            }
        }
        if (!waiting) return
        await sleep(1000)
    }
    throw new Error('Idle session processes did not finish shutting down')
}

function oldAgentProcesses() {
    const ps = shell('/bin/ps', ['-axo', 'uid=,pid=,comm='])
    return ps.split('\n').filter(line => new RegExp(`^\\s*${cfg.oldUid}\\s`).test(line) && line.includes('/opt/hapi-wwx/bin/'))
}

function inventory(root) {
    const rows = []
    function walk(dir) {
        for (const name of fs.readdirSync(dir).sort()) {
            const file = path.join(dir, name)
            if (isExcludedHomePath(root, file)) continue
            const stat = fs.lstatSync(file), relative = path.relative(root, file)
            if (stat.isSymbolicLink()) rows.push({ path: relative, type: 'link', target: fs.readlinkSync(file) })
            else if (stat.isDirectory()) { rows.push({ path: relative, type: 'directory' }); walk(file) }
            else if (stat.isFile()) {
                const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, 'r')
                try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)) } finally { fs.closeSync(fd) }
                rows.push({ path: relative, type: 'file', bytes: stat.size, hash: hash.digest('hex') })
            }
        }
    }
    walk(root)
    return rows
}

function chownTree(root) {
    function walk(file) {
        if (isExcludedHomePath(root, file)) return
        const stat = fs.lstatSync(file)
        if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of fs.readdirSync(file)) walk(path.join(file, name))
        fs.lchownSync(file, cfg.newUid, 20)
    }
    walk(root)
}

function repairCopiedPaths(sessions) {
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name)
            if (isExcludedHomePath(cfg.projectHome, file)) continue
            if (entry.isSymbolicLink()) {
                const original = fs.readlinkSync(file), mapped = mapPath(original)
                if (original !== mapped) { fs.unlinkSync(file); fs.symlinkSync(mapped, file) }
            } else if (entry.isDirectory()) walk(file)
        }
    }
    walk(cfg.projectHome)
    const claude = path.join(cfg.projectHome, '.claude')
    fs.mkdirSync(claude, { recursive: true, mode: 0o700 })
    const oldConfig = path.join(cfg.projectHome, '.claude.json'), newConfig = path.join(claude, '.claude.json')
    if (exists(oldConfig) && !exists(newConfig)) fs.copyFileSync(oldConfig, newConfig)
    for (const session of sessions) {
        const cwd = session.metadata?.path
        if (typeof cwd !== 'string' || mapPath(cwd) === cwd) continue
        const encoded = value => value.replace(/[^a-zA-Z0-9]/g, '-')
        const oldDir = path.join(claude, 'projects', encoded(cwd)), newDir = path.join(claude, 'projects', encoded(mapPath(cwd)))
        if (isDir(oldDir) && !exists(newDir)) fs.symlinkSync(path.basename(oldDir), newDir)
    }
    for (const name of ['runner.state.json', 'runner.state.json.lock']) {
        const file = path.join(cfg.projectHome, '.hapi', name)
        if (exists(file)) fs.renameSync(file, file + '.pre-migration')
    }
}

function historyDigest(home) {
    const db = path.join(home, '.hapi', 'hapi.db')
    const sessions = JSON.parse(sqliteExec(db, 'SELECT id FROM sessions ORDER BY id;', ['-json']) || '[]').map(s => s.id)
    const messages = sqliteExec(db, 'SELECT id,session_id,content,seq FROM messages ORDER BY id;', ['-json'])
    return { sessions, messagesHash: crypto.createHash('sha256').update(messages).digest('hex'), messages: JSON.parse(messages || '[]').length }
}

async function waitForServices() {
    for (let attempt = 0; attempt < 40; attempt++) {
        const services = verifyServiceUsers()
        if (services.ok) return services
        await sleep(1000)
    }
    throw new Error('The three WWX services did not become healthy as UID 501')
}

function ensureRoot() {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new Error('--apply/--rollback/--finalize require root')
}

function ensureTargetOwner() {
    if (!exists(cfg.newHome)) throw new Error(`new owner home missing: ${cfg.newHome}`)
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        const r = tryShell('/usr/bin/id', ['-u', cfg.newUser])
        if (r.status !== 0 || Number(r.stdout) !== cfg.newUid) throw new Error(`${cfg.newUser} must resolve to UID ${cfg.newUid}`)
    }
}

function writeVerification(backupDir, data) {
    fs.writeFileSync(path.join(backupDir, 'verification.json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

async function applyMigration() {
    ensureRoot()
    ensureTargetOwner()
    if (tryShell('/usr/bin/id', ['-u', cfg.oldUser]).stdout !== String(cfg.oldUid)) throw new Error('Legacy account does not match the recorded UID')
    if (!exists(cfg.legacyHome)) throw new Error(`legacy home missing: ${cfg.legacyHome}`)
    if (fs.lstatSync(cfg.legacyHome).uid !== cfg.oldUid) throw new Error('Legacy home owner has changed; recheck migration state')
    for (const destination of [cfg.projectHome, cfg.canonicalCwd]) {
        try { fs.lstatSync(destination); throw new Error(`Destination already exists: ${destination}`) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    // Catch source access problems before closing any conversation or service.
    // Do not ignore inaccessible HAPI, Codex, Claude or project files.
    for (const name of ['.hapi', '.codex', 'work']) {
        if (!fs.lstatSync(path.join(cfg.legacyHome, name)).isDirectory()) throw new Error(`Required service directory is missing or is a link: ${name}`)
    }
    const retainedInPlace = fs.readdirSync(cfg.legacyHome).filter(name => !migratedHomeRoots.includes(name)).sort()
    log('Checking HAPI, Agent state and project files; the macOS profile stays untouched in the original home.')
    for (const file of findFiles(cfg.legacyHome)) {
        try { const fd = fs.openSync(file, 'r'); fs.closeSync(fd) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const api = await authenticatedApi()
    const sessions = await readSessions(api)
    assertSessionWorkspaces(sessions)
    const backupDir = path.join(cfg.backupRoot, timestamp())
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(cfg.backupRoot, 0o700)
    let stopped = false
    let archived = false
    try {
        backupPlists(backupDir)
        if (exists(wrapperTarget)) fs.copyFileSync(wrapperTarget, path.join(backupDir, 'old-wrapper'))
        fs.writeFileSync(path.join(backupDir, 'plan.json'), JSON.stringify({ cfg, labels, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
        fs.writeFileSync(path.join(backupDir, 'backup-scope.json'), JSON.stringify({ copiedRoots: migratedHomeRoots, retainedInPlace, retainedAt: cfg.legacyHome, reason: 'Service/project migration only. Other macOS profile data is not scanned, copied, chowned or deleted.' }), { mode: 0o600 })
        fs.writeFileSync(path.join(backupDir, 'before-sessions.json'), JSON.stringify(sessions), { mode: 0o600 })
        fs.writeFileSync(path.join(backupDir, 'old-account.txt'), shell('/usr/bin/dscl', ['.', '-read', '/Users/' + cfg.oldUser]), { mode: 0o600 })
        log(`backup directory: ${backupDir}`)
        archived = true
        await archiveIdleSessions(api, sessions)
        const latest = await readSessions(api)
        if (latest.some(s => s.active) || JSON.stringify(latest.map(s => s.id).sort()) !== JSON.stringify(sessions.map(s => s.id).sort())) throw new Error('WWX session state changed during shutdown; retry after new work finishes')
        stopped = true
        stopServices()
        for (let attempt = 0; oldAgentProcesses().length && attempt < 20; attempt++) await sleep(1000)
        if (oldAgentProcesses().length) throw new Error('Old WWX agent processes remain; no unknown process was killed')
        const sourceManifest = inventory(cfg.legacyHome)
        const available = Number(shell('/bin/df', ['-Pk', cfg.newHome]).split('\n').at(-1).trim().split(/\s+/)[3]) * 1024
        const bytes = sourceManifest.reduce((total, file) => total + (file.bytes || 0), 0)
        if (!Number.isFinite(available) || available < bytes * 4 + 1024 ** 3) throw new Error('Insufficient disk space for complete backup and migration')
        copyTree(cfg.legacyHome, path.join(backupDir, 'home'))
        const backupManifest = inventory(path.join(backupDir, 'home'))
        if (JSON.stringify(sourceManifest) !== JSON.stringify(backupManifest)) throw new Error('Service/project backup did not match the source')
        fs.writeFileSync(path.join(backupDir, 'home-manifest.json'), JSON.stringify(sourceManifest), { mode: 0o600 })
        fs.mkdirSync(cfg.projectHome, { recursive: true, mode: 0o700 })
        copyTree(path.join(backupDir, 'home'), cfg.projectHome)
        const sqliteRel = copySqliteDatabases(cfg.legacyHome, cfg.projectHome, backupDir)
        const beforeHistory = historyDigest(cfg.projectHome)
        const rewritten = rewriteCopiedMetadata(cfg.projectHome)
        if (JSON.stringify(beforeHistory) !== JSON.stringify(historyDigest(cfg.projectHome))) throw new Error('Session IDs or message content changed during migration')
        repairCopiedPaths(sessions)
        if (!isDir(path.join(cfg.projectHome, 'work'))) throw new Error('Copied project work directory is missing')
        fs.mkdirSync(path.dirname(cfg.canonicalCwd), { recursive: true, mode: 0o700 })
        fs.symlinkSync(path.join(cfg.projectHome, 'work'), cfg.canonicalCwd)
        for (const dir of [path.dirname(cfg.projectHome), path.dirname(path.dirname(cfg.projectHome))]) fs.chownSync(dir, cfg.newUid, 20)
        chownTree(cfg.projectHome)
        fs.lchownSync(cfg.canonicalCwd, cfg.newUid, 20)
        fs.chmodSync(cfg.projectHome, 0o700)
        fs.mkdirSync(path.dirname(wrapperTarget), { recursive: true, mode: 0o755 })
        fs.copyFileSync(wrapperSource, wrapperTarget)
        try { fs.chownSync(wrapperTarget, 0, 0) } catch {}
        fs.chmodSync(wrapperTarget, 0o555)
        installTransformedPlists(backupDir)
        startServices()
        const services = await waitForServices()
        let runnerOnline = false
        for (let attempt = 0; attempt < 40; attempt++) {
            try {
                const data = await api('/machines')
                runnerOnline = data.machines?.some(machine => machine.id === '1038f411-05fb-454f-a9cd-3c4e226168f0' && machine.active)
                if (runnerOnline) {
                    // The persisted active flag can survive a hub restart before
                    // the runner has registered its Socket.IO RPC handlers.
                    const probe = await api('/machines/1038f411-05fb-454f-a9cd-3c4e226168f0/paths/exists', { paths: [cfg.canonicalCwd] })
                    runnerOnline = probe.exists?.[cfg.canonicalCwd] === true
                }
                if (runnerOnline) break
            } catch { runnerOnline = false }
            await sleep(1000)
        }
        if (!runnerOnline) throw new Error('Migrated WWX runner did not become available through the existing route')
        const dbs = dbSummary(cfg.projectHome)
        const dbOk = dbs.length > 0 && dbs.every((d) => d.integrity)
        if (!dbOk) throw new Error('Migrated database integrity check failed')
        let visible
        for (let attempt = 0; attempt < 30; attempt++) {
            try { visible = await api('/sessions'); break } catch { await sleep(1000) }
        }
        const ids = visible?.sessions?.map(s => s.id).sort()
        if (JSON.stringify(ids) !== JSON.stringify(sessions.map(s => s.id).sort())) throw new Error('Authenticated WWX session IDs did not match')
        const verification = {
            schema: 1,
            appliedAt: new Date().toISOString(),
            backupDir,
            serviceIdentity: services,
            sqlite: { files: sqliteRel, integrity: dbs },
            metadataRewrite: rewritten,
            hubApi: { verified: true, sessions: ids.length },
            projectBackup: { verified: true, copiedRoots: migratedHomeRoots, retainedInPlace, files: sourceManifest.filter(f => f.type === 'file').length, bytes },
            history: beforeHistory,
            dbComplete: dbOk,
            readyForFinalize: false,
            oldHomeRetained: true,
            oldUserRetained: true,
        }
        writeVerification(backupDir, verification)
        const receipt = path.join(cfg.projectHome, '..', 'migration-receipt.json')
        fs.writeFileSync(receipt, JSON.stringify({ backupDir, appliedAt: verification.appliedAt, sessions: ids.length, messages: beforeHistory.messages, liveAcceptancePending: true }), { mode: 0o600 })
        fs.chownSync(receipt, cfg.newUid, 20)
        log(`Migration applied as zhuhe. Old account retained until real model/tool acceptance: ${backupDir}`)
        return backupDir
    } catch (error) {
        console.error(`apply failed: ${error.message}`)
        try {
            if (stopped) stopServices()
            if (exists(path.join(backupDir, 'plists', 'transformed.ok'))) restorePlists(backupDir)
            else if (stopped) restorePlists(backupDir)
            if (exists(path.join(backupDir, 'old-wrapper'))) {
                fs.copyFileSync(path.join(backupDir, 'old-wrapper'), wrapperTarget)
                fs.chmodSync(wrapperTarget, 0o555)
            }
            if (stopped) { startServices(); await sleep(3000) }
            if (exists(cfg.canonicalCwd) && fs.lstatSync(cfg.canonicalCwd).isSymbolicLink() && fs.readlinkSync(cfg.canonicalCwd) === path.join(cfg.projectHome, 'work')) fs.unlinkSync(cfg.canonicalCwd)
            if (archived) for (const session of sessions.filter(s => s.active)) {
                try { await api('/sessions/' + session.id + '/resume', { permissionMode: session.permissionMode || 'default' }) } catch { log('One original idle session must be resumed manually: ' + session.id) }
            }
            log(`rollback attempted from ${backupDir}`)
        } catch (rollbackError) {
            console.error(`rollback failed: ${rollbackError.message}`)
        }
        throw error
    }
}

async function rollbackMigration(backupDir) {
    ensureRoot()
    if (!isDir(backupDir)) throw new Error(`backup directory not found: ${backupDir}`)
    if (tryShell('/usr/bin/id', ['-u', cfg.oldUser]).stdout !== String(cfg.oldUid)) throw new Error('Old account was finalized; account recreation is not supported. Data backups remain intact.')
    const api = await authenticatedApi()
    const { sessions } = await api('/sessions')
    const details = []
    for (const s of sessions || []) {
        const { session } = await api('/sessions/' + s.id)
        if (hasPendingWork(session)) throw new Error('Rollback postponed: current project has unfinished work')
        details.push(session)
    }
    await archiveIdleSessions(api, details, cfg.newUid)
    stopServices()
    restorePlists(backupDir)
    const oldWrapper = path.join(backupDir, 'old-wrapper')
    if (exists(oldWrapper)) {
        fs.copyFileSync(oldWrapper, wrapperTarget)
        try { fs.chownSync(wrapperTarget, 0, 0) } catch {}
        fs.chmodSync(wrapperTarget, 0o555)
    }
    startServices()
    log(`rollback restored the three plists and old wrapper; legacy home/user were not deleted: ${backupDir}`)
}

function verifyFinalHistory(current, original, backup) {
    const missing = original.sessions.filter(id => !current.sessions.includes(id))
    if (!missing.length) return missing
    if (!backup || JSON.stringify(backup.sessions) !== JSON.stringify(original.sessions)
        || backup.messages !== original.messages || backup.messagesHash !== original.messagesHash) {
        throw new Error('Original sessions are absent from the live database and their exact migration backup has not been verified')
    }
    return missing
}

async function finalizeMigration(backupDir) {
    ensureRoot()
    if (!isDir(backupDir)) throw new Error(`backup directory not found: ${backupDir}`)
    const verificationFile = path.join(backupDir, 'verification.json')
    if (!exists(verificationFile)) throw new Error('verification.json missing; finalize refused')
    const verification = JSON.parse(fs.readFileSync(verificationFile, 'utf8'))
    if (!verification.hubApi?.verified || !verification.dbComplete || !verification.projectBackup?.verified || !verifyServiceUsers().ok) throw new Error('Finalize refused: project backup, identity, database or API validation is incomplete')
    if (oldAgentProcesses().length) throw new Error('Finalize refused: old WWX agent processes remain')
    const proofFile = path.join(cfg.newHome, '.local/lib/hapi-mini/single-user-migration-20261028/acceptance/live-proof.json')
    if (!exists(proofFile) || fs.statSync(proofFile).uid !== cfg.newUid) throw new Error('Live model/tool/network acceptance has not passed')
    const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'))
    if (proof.uid !== cfg.newUid || !proof.realReply || !proof.resumedHistory || proof.networkStatus !== 200 || proof.project !== cfg.canonicalCwd || proof.permissionMode !== 'yolo' || !Number.isFinite(Date.parse(proof.verifiedAt)) || Date.parse(proof.verifiedAt) < Date.parse(verification.appliedAt)) throw new Error('Live acceptance does not match this migration')
    const file = path.join(cfg.canonicalCwd, '.hapi-migration-check-' + proof.nonce + '.json')
    if (proof.proof !== file || fs.statSync(file).uid !== cfg.newUid || JSON.parse(fs.readFileSync(file, 'utf8')).nonce !== proof.nonce) throw new Error('Live tool proof is invalid')
    const api = await authenticatedApi()
    const { session } = await api('/sessions/' + proof.sessionId)
    if (!session || !session.metadata?.path || fs.realpathSync(session.metadata.path) !== fs.realpathSync(cfg.canonicalCwd) || session.permissionMode !== 'yolo') throw new Error('Live test session no longer matches the migrated project')
    const digest = historyDigest(cfg.projectHome)
    const missing = verification.history.sessions.filter(id => !digest.sessions.includes(id))
    let backupHistory
    if (missing.length) {
        // Sessions may be removed after the successful migration. Keep their
        // original records recoverable instead of recreating them in navigation.
        const backupHome = path.join(backupDir, 'sqlite')
        if (!sqliteIntegrity(path.join(backupHome, '.hapi/hapi.db'))) throw new Error('Original history backup integrity failed')
        backupHistory = historyDigest(backupHome)
    }
    verification.sessionsRetainedOnlyInBackup = verifyFinalHistory(digest, verification.history, backupHistory)
    if (!sqliteIntegrity(path.join(cfg.projectHome, '.hapi/hapi.db'))) throw new Error('HAPI database integrity failed')
    if (tryShell('/usr/bin/id', ['-u', cfg.oldUser]).stdout !== String(cfg.oldUid)) throw new Error('Legacy account identity changed')
    // Keep legacy absolute attachment/file links usable by the sole real user.
    // A verified copy of service/project data is stored in backupDir/home.
    // Other macOS profile directories remain untouched at their original path.
    // An ownership repair failure must leave the directory-service account intact.
    chownTree(cfg.legacyHome)
    const r = tryShell('/usr/bin/dscl', ['.', '-delete', `/Users/${cfg.oldUser}`])
    if (r.status !== 0) throw new Error(`dscl delete of ${cfg.oldUser} failed: ${r.stderr || r.stdout}`)
    verification.finalizedAt = new Date().toISOString()
    verification.oldUserRetained = false
    verification.legacyProjectDataOwner = cfg.newUser
    verification.otherProfileDataRetainedUnmodified = true
    writeVerification(backupDir, verification)
    log(`removed directory-service record for ${cfg.oldUser}; home ${cfg.legacyHome} and backup ${backupDir} were retained`)
}

function selfTest() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-migrate-test-'))
    const old = path.join(root, 'old')
    const next = path.join(root, 'new')
    fs.mkdirSync(path.join(old, '.hapi'), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.join(old, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(old, '.hapi', 'metadata.json'), JSON.stringify({ path: `${cfg.legacyHome}/work/project`, homeDir: cfg.legacyHome, message: `${cfg.legacyHome}/must-not-change` }, null, 2))
    const db = path.join(old, '.codex', 'state.sqlite')
    shell('/usr/bin/sqlite3', [db, 'PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT, cwd TEXT); INSERT INTO threads VALUES("1", "/Users/hapi-wwx/work/project");'])
    copyTree(old, next)
    copySqliteDatabases(old, next, path.join(root, 'backup'))
    const before = rewriteCopiedMetadata(next)
    const parsed = JSON.parse(fs.readFileSync(path.join(next, '.hapi', 'metadata.json'), 'utf8'))
    // Test only the explicitly selected metadata file; arbitrary JSON is preserved.
    const mapped = rewriteStructured(parsed)
    if (mapped.path !== `${cfg.canonicalCwd}/project` || mapped.homeDir !== cfg.newHome || mapped.message !== `${cfg.legacyHome}/must-not-change`) throw new Error('path conversion self-test failed')
    if (!sqliteIntegrity(path.join(next, '.codex', 'state.sqlite'))) throw new Error('SQLite integrity self-test failed')
    const cwd = shell('/usr/bin/sqlite3', ['-readonly', path.join(next, '.codex', 'state.sqlite'), 'SELECT cwd FROM threads;'])
    if (cwd !== `${cfg.canonicalCwd}/project`) throw new Error(`SQLite cwd conversion self-test failed: ${cwd}`)
    const plist = path.join(root, 'test.plist')
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>UserName</key><string>hapi-wwx</string><key>WorkingDirectory</key><string>/Users/hapi-wwx/work</string></dict></plist>`)
    const originalLegacy = cfg.legacyHome
    const xml = plistXml(plist).replace(`<string>${originalLegacy}</string>`, `<string>${cfg.projectHome}</string>`)
    if (!xml.includes('<string>hapi-wwx</string>')) throw new Error('plist fixture self-test setup failed')
    fs.rmSync(root, { recursive: true, force: true })
    log(`self-test passed: path conversion, SQLite backup/integrity, structured cwd rewrite (${before.jsonChanged} JSON file)`)
}

function usage() {
    console.log(`Usage: node migrate-single-user.mjs --check | --apply | --rollback <backup-dir> | --finalize <backup-dir> | --self-test\n\n--check is read-only and may run as a normal user. --apply/--rollback/--finalize require root.\nCredentials are used in memory for authenticated API checks and never printed.`)
}

const args = process.argv.slice(2)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
try {
    if (args.length === 0 || args.includes('--help')) usage()
    else if (args[0] === '--check') console.log(JSON.stringify(checkReport(), null, 2))
    else if (args[0] === '--self-test') selfTest()
    else if (args[0] === '--apply') await applyMigration()
    else if (args[0] === '--rollback' && args[1]) await rollbackMigration(args[1])
    else if (args[0] === '--finalize' && args[1]) await finalizeMigration(args[1])
    else die('invalid arguments; use --help', 64)
} catch (error) {
    if (!(error instanceof Error && error.message.startsWith('ERROR:'))) console.error(`ERROR: ${error.message}`)
    process.exitCode = process.exitCode || 1
}
}

export { mapPath, rewriteStructured, sqliteIntegrity, sqliteBackup, transformedPlist, sqliteStructuredRewrite, historyDigest, inventory, repairCopiedPaths, hasPendingWork, cfg, copyTree, findFiles, chownTree, assertSessionWorkspaces, verifyFinalHistory }
