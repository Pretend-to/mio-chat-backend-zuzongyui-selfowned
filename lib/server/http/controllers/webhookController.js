import { exec } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import util from 'util'
import nodemailer from 'nodemailer'
import config from '../../../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execPromise = util.promisify(exec)
const REPO_DIR = process.cwd()

/**
 * 检测当前进程的运行环境
 */
function detectProcessManager() {
  // 1. PM2 环境
  if (process.env.PM2_USAGE || process.env.pm_id !== undefined) {
    return { type: 'pm2' }
  }
  // 2. Docker 容器环境
  if (fs.existsSync('/.dockerenv')) {
    return { type: 'docker' }
  }
  // 3. 裸 Node 进程
  return { type: 'node' }
}

/**
 * 根据进程检测结果生成重启命令
 */
function buildRestartCommand(pmInfo) {
  const currentName = process.env.name || 'mio-chat-backend'
  switch (pmInfo.type) {
    case 'pm2': {
      return `sleep 3 && for pm2_bin in pm2 /opt/homebrew/bin/pm2 /usr/local/bin/pm2; do if command -v "$pm2_bin" >/dev/null 2>&1; then "$pm2_bin" restart "${currentName}" 2>/dev/null && break; fi; done`
    }
    case 'docker': {
      return `sleep 3 && kill -15 ${process.pid}`
    }
    case 'node':
    default: {
      return `sleep 3 && kill -15 ${process.pid} ; nohup node app.js > /dev/null 2>&1 &`
    }
  }
}

/**
 * 获取当前工作区所处的本地 Git 分支
 */
export async function getCurrentLocalBranch() {
  try {
    const headPath = path.join(REPO_DIR, '.git', 'HEAD')
    if (fs.existsSync(headPath)) {
      const headContent = fs.readFileSync(headPath, 'utf8').trim()
      const match = headContent.match(/^ref: refs\/heads\/(.+)$/)
      if (match) return match[1]
    }
  } catch {}
  try {
    const { stdout } = await execPromise('git rev-parse --abbrev-ref HEAD', {
      cwd: REPO_DIR,
    })
    return stdout.trim()
  } catch (error) {
    logger.warn('[Webhook] 获取当前本地 Git 分支失败:', error.message)
    return null
  }
}

/**
 * 验证 GitHub Webhook 签名
 * @param {Buffer} rawBody — 请求体的原始字节
 * @param {string} signatureHeader — X-Hub-Signature-256 头的值
 * @param {string} secret — 配置的 webhook secret
 */
function verifyGithubSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) {
    return false
  }
  const parts = signatureHeader.split('=')
  const algo = parts[0]
  const sig = parts[1]
  if (algo !== 'sha256' || !sig) {
    return false
  }
  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(rawBody)
  const expected = hmac.digest('hex')
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}

const _pmInfo = detectProcessManager()
logger.info(`[Deploy] 进程环境检测: ${_pmInfo.type}`)

/**
 * HTML 转义
 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 将 git diff 文本渲染为带颜色的 HTML 块
 */
function renderDiffToHtml(diffText, statText) {
  if (!diffText || !diffText.trim()) {
    return "<div style=\"padding:11px 13px;font-size:12px;color:#6b6a64;font-style:italic;font-family:Georgia,Palatino,'Times New Roman','Songti SC','SimSun',serif;\">仓库已是最新，无代码变更</div>"
  }

  const MAX_LINES = 300
  const lines = diffText.split('\n')
  let html = ''
  let lineCount = 0
  let truncated = false

  const statLine = statText ? statText.trim().replace(/\n.*$/s, '') : ''
  if (statLine) {
    html += `<div style="padding:0 0 8px 0;font-size:11px;color:#1B365D;font-weight:500;font-family:Menlo,Monaco,'Courier New',monospace;">📁 ${escapeHtml(statLine)}</div>`
  }

  html +=
    '<div style="background-color:#f2f0e8;border:0.5px solid #e5e3d8;border-radius:3px;font-family:Menlo,Monaco,\'Courier New\',monospace;font-size:10.5px;line-height:1.55;max-height:200px;overflow-y:auto;">'

  for (const line of lines) {
    if (lineCount >= MAX_LINES) {
      truncated = true
      break
    }

    let bgColor = ''
    let textColor = '#3d3d3a'
    const pad = '0 13px'

    if (line.startsWith('diff --git')) {
      if (lineCount > 0) {
        html += `<div style="height:0;border-top:0.5px dotted #d4d2c8;margin:6px 0 0 0;"></div>`
      }
      html += `<div style="padding:4px 13px 1px 13px;font-weight:600;color:#1B365D;white-space:pre-wrap;word-break:break-all;">${escapeHtml(line)}</div>`
      lineCount++
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      bgColor = '#e6ffec'
      textColor = '#24292e'
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      bgColor = '#ffeef0'
      textColor = '#24292e'
    } else if (line.startsWith('@@')) {
      bgColor = '#f1f8ff'
      textColor = '#0366d6'
    }

    const style = `padding:${pad};${bgColor ? `background-color:${bgColor};` : ''}color:${textColor};white-space:pre-wrap;word-break:break-all;`
    html += `<div style="${style}">${escapeHtml(line)}</div>`
    lineCount++
  }

  if (truncated) {
    html += `<div style="padding:4px 13px;color:#888;font-style:italic;">... 剩余部分已省略 ...</div>`
  }

  html += '</div>'
  return html
}

/**
 * 获取当前 webhook 配置
 */
function getWebhookConfig() {
  return config.webhook || {}
}

/**
 * 获取或创建邮件传输器（延迟初始化，读取动态配置）
 */
let _transporter = null
let _transporterConfig = null
function getTransporter() {
  const wh = getWebhookConfig()
  const currentConf = `${wh.smtp_host}:${wh.smtp_port}:${wh.smtp_user}:${(wh.smtp_pass || '').slice(0, 4)}`

  if (!_transporter || _transporterConfig !== currentConf) {
    _transporter = nodemailer.createTransport({
      auth: {
        pass: wh.smtp_pass || '',
        user: wh.smtp_user || '',
      },
      host: wh.smtp_host || 'smtp.qq.com',
      port: wh.smtp_port || 465,
      secure: wh.smtp_secure !== false,
    })
    _transporterConfig = currentConf
  }
  return _transporter
}

/** 获取允许的分支列表 */
function getAllowedBranches() {
  return getWebhookConfig().allowed_branches || ['master', 'production']
}

/** 获取邮件模板内容（延迟读取） */
let _templateRaw = null
function getTemplate() {
  if (!_templateRaw) {
    const templatePath = path.join(REPO_DIR, 'templates', 'email-template.html')
    _templateRaw = fs.readFileSync(templatePath, 'utf8')
  }
  return _templateRaw
}

/**
 * 渲染邮件 HTML
 */
function renderEmailHtml(vars) {
  let html = getTemplate()

  const isSuccess = vars.status === 'success'
  const statusLabel = isSuccess ? '部署成功' : '部署失败'

  const defaults = {
    BRANCH: vars.branch || 'unknown',
    COMMIT_LINK_HTML: vars.commitUrl
      ? `<div style="margin-top:7px;"><a href="${vars.commitUrl}" style="font-size:11px;color:#2D5A8A;text-decoration:none;font-family:Georgia,Palatino,'Times New Roman','Songti SC','SimSun',serif;">查看提交 ›</a></div>`
      : '',
    COMMIT_MSG: vars.commitMsg || '无提交信息',
    DIFF_HTML: vars.diffHtml || renderDiffToHtml('', ''),
    FOOTER_TIME: vars.footerTime || '',
    LOG_CONTENT: vars.logContent || '无输出',
    PUSHER_INITIAL: (vars.pusherName || 'U')[0].toUpperCase(),
    PUSHER_NAME: vars.pusherName || 'Unknown',
    REPO_NAME: vars.repoName || 'unknown',
    STATUS_BG: isSuccess
      ? 'background-color:#E8F5EE'
      : 'background-color:#FDE8E8',
    STATUS_COLOR: isSuccess ? '#2D6A4F' : '#9B2226',
    STATUS_LABEL: `${isSuccess ? '✅' : '❌'} ${statusLabel}`,
    SUBTITLE: vars.subtitle || 'GitHub Webhook 自动触发 · MioChat',
    TIME:
      vars.time ||
      new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    TITLE: vars.title || '自动部署通知',
  }

  for (const [key, val] of Object.entries(defaults)) {
    html = html.replaceAll(`{{${key}}}`, val)
  }

  return html
}

/**
 * 发送 HTML 邮件
 */
async function sendDeployEmail(vars) {
  const html = renderEmailHtml(vars)
  const isSuccess = vars.status === 'success'

  const wh = getWebhookConfig()
  const mailOptions = {
    from: `"${wh.email_from_name || 'MioChat 部署'}" <${wh.email_from || wh.smtp_user || 'krumio@qq.com'}>`,
    html: html,
    subject: `${isSuccess ? '✅' : '❌'} ${vars.repoName} · ${vars.branch} ${isSuccess ? '部署成功' : '部署失败'}`,
    to: wh.email_to || '1099834705@qq.com',
  }

  await getTransporter().sendMail(mailOptions)
}

const CRITICAL_PATTERNS = [
  'app.js',
  'lib/',
  'utils/',
  'config/',
  'prisma/',
  'channels/',
  'channel/',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/',
  'bin/',
  'start.sh',
]
const PLUGIN_PATTERNS = ['plugins/', 'lib/plugins/']
const STATIC_PATTERNS = [
  'public/',
  'docs/',
  'tests/',
  'backup/',
  'scratch/',
  'tmp/',
  'tmp_test/',
  'projects/',
  'cvtest/',
  'dist/',
]

/**
 * 智能变更检测 —— 判断变更是否需要重启 PM2
 */
function analyzeChanges(changedFiles) {
  const hasCritical = changedFiles.some(
    (f) =>
      CRITICAL_PATTERNS.some((p) => f === p || f.startsWith(p)) &&
      !PLUGIN_PATTERNS.some((p) => f === p || f.startsWith(p)),
  )
  const onlyPlugins =
    changedFiles.length > 0 &&
    changedFiles.every((f) =>
      PLUGIN_PATTERNS.some((p) => f === p || f.startsWith(p)),
    )
  const onlyStatic =
    changedFiles.length > 0 &&
    changedFiles.every(
      (f) =>
        STATIC_PATTERNS.some((p) => f === p || f.startsWith(p)) ||
        f.endsWith('.md') ||
        f.endsWith('.html') ||
        f.endsWith('.txt'),
    )

  return {
    hasCritical,
    needsRestart: hasCritical && changedFiles.length > 0 && !onlyPlugins,
    onlyPlugins,
    onlyStatic,
  }
}

/**
 * 处理 GitHub Webhook
 */
async function handleWebhook(payload) {
  const repoName = payload.repository?.full_name || 'mio-chat-backend'
  const pusherName = payload.pusher?.name || 'unknown'
  const branch = (payload.ref || '').replace('refs/heads/', '') || 'unknown'
  const headCommit =
    payload.head_commit || payload.commits?.[payload.commits.length - 1]
  const commitMsg = headCommit?.message?.split('\n')[0] || '无提交信息'
  const commitUrl = headCommit?.url || ''
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

  logger.info(`════════════════════════════════════════`)
  logger.info(`🔔 Webhook 收到推送: ${repoName} / ${branch} by ${pusherName}`)
  logger.info(`📝 Commit: ${commitMsg}`)

  // 双重保护：校验当前本地工作区分支必须为 master，否则忽略跳过
  const currentLocalBranch = await getCurrentLocalBranch()
  if (currentLocalBranch !== 'master') {
    logger.info(
      `⏭️  [Webhook] 当前本地 Git 分支为 "${currentLocalBranch}"（非 master 分支），跳过执行`,
    )
    return {
      currentBranch: currentLocalBranch,
      message: 'Skipped, current local branch is not master',
      skipped: true,
    }
  }

  // 跳过非监听分支（必须是 master）
  const allowedBranches = getAllowedBranches()
  if (!allowedBranches.includes(branch) || branch !== 'master') {
    logger.info(`⏭️  分支 ${branch} 非 master 分支，跳过`)
    return { branch, message: 'Skipped, branch not monitored', skipped: true }
  }
  logger.info(`✅ 当前分支与目标分支均为 master，继续处理`)

  // 获取 diff
  const beforeSha = payload.before
  const afterSha = payload.after

  logger.info(`🔍 Before SHA: ${beforeSha}`)
  logger.info(`🔍 After SHA:  ${afterSha}`)

  let diffHtml
  if (
    beforeSha &&
    afterSha &&
    beforeSha !== afterSha &&
    !/^0{40}$/.test(afterSha)
  ) {
    logger.info(
      `📡 Fetching commits before=${beforeSha?.slice(0, 8)} after=${afterSha?.slice(0, 8)} ...`,
    )
    await execPromise(`git fetch origin ${beforeSha} ${afterSha}`, {
      cwd: REPO_DIR,
    }).catch(() => {})
    const [statOut, diffOut] = await Promise.all([
      execPromise(`git diff --stat ${beforeSha}..${afterSha}`, {
        cwd: REPO_DIR,
      })
        .then((r) => r.stdout)
        .catch(() => ''),
      execPromise(`git diff ${beforeSha}..${afterSha}`, { cwd: REPO_DIR })
        .then((r) => r.stdout)
        .catch(() => ''),
    ])
    diffHtml = renderDiffToHtml(diffOut, statOut)
  } else {
    diffHtml = renderDiffToHtml('', '')
  }

  // ===== 执行部署脚本 =====
  const logLines = []
  function log(msg) {
    logger.info(msg)
    logLines.push(msg)
  }

  let deployFailed = false

  logger.info(`════════════════════════════════════════`)
  log('开始部署 Mio-Chat Backend...')
  log(`📂 仓库目录: ${REPO_DIR}`)

  try {
    // 1. git fetch + reset
    log('正在拉取最新代码...')
    const pullResult = await execPromise(
      `git fetch origin && git reset --hard origin/${branch}`,
      { cwd: REPO_DIR },
    )
    log(pullResult.stdout.trim() || '代码已同步')

    // 2. 智能变更检测
    const { stdout: changedFilesRaw } = await execPromise(
      'git diff --name-only @{1}',
      { cwd: REPO_DIR },
    ).catch(() => ({ stdout: '' }))
    const changedFiles = changedFilesRaw.split('\n').filter(Boolean)

    if (changedFiles.length === 0) {
      log('📭 仓库已是最新，无代码变更')
    } else {
      log(`📋 变更文件列表 (${changedFiles.length} 个):`)
      changedFiles.forEach((f, i) => {
        const matchedCritical = CRITICAL_PATTERNS.some(
          (p) => f === p || f.startsWith(p),
        )
        const matchedPlugin = PLUGIN_PATTERNS.some(
          (p) => f === p || f.startsWith(p),
        )
        const matchedStatic =
          STATIC_PATTERNS.some((p) => f === p || f.startsWith(p)) ||
          f.endsWith('.md') ||
          f.endsWith('.html') ||
          f.endsWith('.txt')
        const tags = []
        if (matchedCritical) {
          tags.push('CRITICAL')
        }
        if (matchedPlugin) {
          tags.push('PLUGIN')
        }
        if (matchedStatic) {
          tags.push('STATIC')
        }
        log(`  ${i + 1}. ${f}  [${tags.join('|') || 'OTHER'}]`)
      })
    }

    const { hasCritical, onlyPlugins, onlyStatic, needsRestart } =
      analyzeChanges(changedFiles)

    log(
      `📊 决策诊断: hasCritical=${hasCritical} | onlyPlugins=${onlyPlugins} | onlyStatic=${onlyStatic} → needsRestart=${needsRestart}`,
    )
    if (changedFiles.length === 0) {
      log('✅ 仓库已是最新，无需任何操作')
    } else if (hasCritical) {
      log('⚡ 命中核心后端模式 → 需要重启服务')
    } else if (onlyPlugins) {
      log('📦 仅插件目录变更 → chokidar 热重载自动处理，跳过重启')
    } else if (onlyStatic) {
      log('📄 仅静态/文档文件变更 → 无需重启')
    } else {
      log('🔀 含非核心/非插件/非静态的变更 → 需要重启服务')
    }

    // 3. 安装依赖
    const needsInstall = changedFiles.some(
      (f) =>
        f === 'package.json' ||
        f === 'pnpm-lock.yaml' ||
        f === 'pnpm-workspace.yaml',
    )
    if (needsInstall) {
      log('⚙️ 检测到依赖配置文件变更，正在安装依赖...')
      let installResult
      try {
        installResult = await execPromise(
          'pnpm install --frozen-lockfile --reporter=append-only',
          { cwd: REPO_DIR, timeout: 60_000 },
        )
      } catch (error) {
        log(
          `⚠️ lockfile 过期或安装失败，尝试普通安装... 错误: ${error.message}`,
        )
        try {
          installResult = await execPromise(
            'pnpm install --reporter=append-only',
            { cwd: REPO_DIR, timeout: 60_000 },
          )
        } catch (error) {
          log(`❌ 依赖安装彻底失败: ${error.message}`)
          throw error
        }
      }
      log(installResult.stdout.trim() || '依赖安装完成')
    } else {
      log('⏭️ 依赖配置文件未变更，跳过安装步骤')
    }

    // 4. 使用延迟子进程重启（解决自重启问题）
    if (needsRestart) {
      const cmd = buildRestartCommand(_pmInfo)
      const actionLabel =
        { docker: 'Docker', node: '裸 Node', pm2: 'PM2' }[_pmInfo.type] || 'PM2'
      log(`🔄 触发延迟重启（环境: ${actionLabel}，3 秒后执行）`)
      log(`⚙️  重启命令: ${cmd}`)
      const child = exec(cmd, { cwd: REPO_DIR })
      child.stdout?.on('data', (data) =>
        logger.info(`[Restart Output] ${data.trim()}`),
      )
      child.stderr?.on('data', (data) =>
        logger.error(`[Restart Error] ${data.trim()}`),
      )
    } else {
      log('⏭️  变更无需重启服务，跳过重启')
    }

    log('✅ 更新完成!')
  } catch (error) {
    log(`❌ 部署出错: ${error.message}`)
    log('📧 正在尝试发送失败通知...')
    deployFailed = true
  }

  // 发送邮件通知
  try {
    await sendDeployEmail({
      branch,
      commitMsg,
      commitUrl,
      diffHtml,
      footerTime: `${deployFailed ? '部署失败' : '自动部署完成'} · ${now}`,
      logContent: logLines.join('\n'),
      pusherName,
      repoName,
      status: deployFailed ? 'error' : 'success',
      subtitle: `分支 ${branch} · 由 ${pusherName} 推送`,
      time: now,
      title: `${repoName}`,
    })
    logger.info('📧 邮件已发送')
  } catch (error) {
    logger.error('发送通知邮件失败:', error)
  }

  return { skipped: false }
}

// ===== Express 路由处理函数 =====

/**
 * POST /api/webhook - 接收 GitHub Webhook
 */
export async function postWebhook(req, res) {
  const payload = req.body
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

  if (!payload) {
    res.status(400).json({ message: 'Invalid payload' })
    return
  }

  if (payload.repository?.name !== 'mio-chat-backend') {
    res.status(404).json({ message: 'Not Found' })
    return
  }

  // 1. 核心保护：只有当前本地工作区处于 master 分支才响应 Webhook，否则忽视
  const currentBranch = await getCurrentLocalBranch()
  if (currentBranch !== 'master') {
    logger.info(
      `⏭️ [Webhook] 当前本地工作区分支为 "${currentBranch}"（非 master 分支），忽略此 Webhook 请求`,
    )
    res.status(200).json({
      currentBranch,
      message:
        'Ignored: Webhook deployment is only active when current branch is master',
      skipped: true,
    })
    return
  }

  // 2. 检查 Webhook 推送的目标分支：只有推送目标为 master 分支才响应，否则忽视
  const targetBranch = (payload.ref || '').replace('refs/heads/', '')
  if (targetBranch !== 'master') {
    logger.info(
      `⏭️ [Webhook] Webhook 目标分支为 "${targetBranch}"（非 master 分支），忽略此 Webhook 请求`,
    )
    res.status(200).json({
      message: 'Ignored: Webhook only responds to pushes to master branch',
      skipped: true,
      targetBranch,
    })
    return
  }

  // 验证 GitHub 签名（如果配置了 secret）
  const whConfig = getWebhookConfig()
  if (whConfig.secret) {
    const signature = req.headers['x-hub-signature-256']
    if (
      !signature ||
      !verifyGithubSignature(req.rawBody, signature, whConfig.secret)
    ) {
      logger.warn(`[Webhook] 签名验证失败，来自 ${req.ip}`)
      res.status(401).json({ message: 'Invalid signature' })
      return
    }
    logger.info('[Webhook] 签名验证通过')
  } else {
    logger.warn('[Webhook] 未配置 secret，跳过签名验证')
  }

  // 立即返回 200 给 GitHub，防止 10 秒超时
  res
    .status(200)
    .json({ message: 'Webhook received, starting deployment in background' })

  // 在后台异步执行部署任务
  handleWebhook(payload).catch((error) => {
    logger.error('Webhook 后台处理异常:', error)

    // 失败时发送邮件
    sendDeployEmail({
      branch: (payload.ref || '').replace('refs/heads/', ''),
      commitMsg: error.message,
      diffHtml: `<div style="background-color:#FDE8E8;border:0.5px solid #f5c6cb;border-radius:3px;padding:11px 13px;font-family:Menlo,Monaco,'Courier New',monospace;font-size:10.5px;line-height:1.5;color:#9B2226;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow-y:auto;margin:0;">${escapeHtml(error.stack || error.message)}</div>`,
      footerTime: `部署失败 · ${now}`,
      logContent: error.stack || error.message,
      pusherName: payload.pusher?.name || 'unknown',
      repoName: payload.repository?.full_name || 'mio-chat-backend',
      status: 'error',
      subtitle: '部署脚本执行异常',
      time: now,
      title: payload.repository?.full_name || 'mio-chat-backend',
    }).catch((error) => {
      logger.error('发送失败通知邮件也挂了:', error)
    })
  })
}

/**
 * GET /api/webhook/demo - 发送 Demo 邮件
 */
export async function getDemo(req, res) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

  try {
    await sendDeployEmail({
      branch: 'master',
      commitMsg:
        'feat: 优化视觉模型请求，移除 GPT-5.2 不必要的 max_completion_tokens 参数',
      commitUrl:
        'https://github.com/Pretend-to/mio-chat-backend/commit/edcff0a',
      diffHtml: (() => {
        const sampleDiff = [
          'diff --git a/src/bridge/llm.ts b/src/bridge/llm.ts',
          'index a1b2c3d..e4f5g6h 100644',
          '--- a/src/bridge/llm.ts',
          '+++ b/src/bridge/llm.ts',
          '@@ -120,7 +120,7 @@ export class LLMBridge {',
          '     const model = this.resolveModel(request);',
          '     const stream = request.stream ?? true;',
          ' ',
          '-    if (model === "gpt-5.2" && request.maxCompletionTokens) {',
          '+    if (request.maxCompletionTokens) {',
          '     }',
          ' ',
          '@@ -145,6 +145,12 @@ export class LLMBridge {',
          '   }',
          ' ',
          '+  /**',
          '+   * 健康检查端点，供 k8s liveness probe 使用',
          '+   */',
          '+  async healthCheck(): Promise<boolean> {',
          '+    return this.client.status === "connected";',
          '+  }',
          '+',
          'diff --git a/src/types.ts b/src/types.ts',
          'index 9i8k7l6..5j4h3g2 100644',
          '--- a/src/types.ts',
          '+++ b/src/types.ts',
          '@@ -42,6 +42,7 @@ export interface LLMRequest {',
          '   temperature?: number;',
          '+  topP?: number;',
          ' }',
        ].join('\n')
        return renderDiffToHtml(
          sampleDiff,
          '2 files changed, 8 insertions(+), 2 deletions(-)',
        )
      })(),
      footerTime: `Demo 邮件 · ${now}`,
      logContent: [
        '开始更新 Mio-Chat...',
        '进入项目目录...',
        '正在拉取最新代码...',
        '重置到最新版本...',
        'dist 目录检查完成',
        '正在安装依赖...',
        'Already up to date',
        '正在重启服务...',
        '[PM2] [Mio-Chat](1) ✓',
        '更新完成!',
      ].join('\n'),
      pusherName: 'kamisamy',
      repoName: 'Pretend-to/mio-chat-backend',
      status: 'success',
      subtitle: '分支 master · 由 kamisamy 推送',
      time: now,
      title: 'Pretend-to/mio-chat-backend',
    })

    logger.info('Demo 邮件已发送')
    res.status(200).json({ message: 'Demo email sent!' })
  } catch (error) {
    logger.error('Demo 邮件发送失败:', error)
    res.status(500).json({ error: error.message, message: 'Demo email failed' })
  }
}
