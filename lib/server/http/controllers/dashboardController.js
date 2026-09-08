import sessions from '../../socket.io/services/sessions.js'
import prismaManager from '../../../database/prisma.js'

/**
 * 获取大盘实时运行状态 (在线用户、连接、Pending 运行请求)
 */
export async function getRealtimeStats(req, res) {
  try {
    const clients = sessions.getAllClients() || []
    const onlineConnections = clients.length
    const onlineUsers = sessions.pool ? sessions.pool.size : 0

    let pendingRequests = 0
    clients.forEach((client) => {
      if (client.activeEvents) {
        pendingRequests += client.activeEvents.size
      }
    })

    res.json({
      data: {
        onlineConnections,
        onlineUsers,
        pendingRequests,
      },
      success: true,
    })
  } catch (error) {
    global.logger?.error('[DashboardController] 获取实时指标失败:', error)
    res.status(500).json({ error: error.message, success: false })
  }
}

/**
 * 获取历史聚合用量与性能 SLA 审计指标
 */
export async function getHistoricalStats(req, res) {
  try {
    const { range = '24h', startTime, endTime } = req.query

    let start = new Date()
    let end = new Date()

    if (startTime && endTime) {
      start = new Date(Number(startTime))
      end = new Date(Number(endTime))
    } else {
      if (range === '24h') {
        start.setHours(start.getHours() - 24)
      } else if (range === '7d') {
        start.setDate(start.getDate() - 7)
      } else if (range === '30d') {
        start.setDate(start.getDate() - 30)
      } else if (range === '90d') {
        start.setDate(start.getDate() - 90)
      } else if (range === '365d') {
        start.setDate(start.getDate() - 365)
      } else {
        start.setHours(start.getHours() - 24) // 默认 24h
      }
    }

    await prismaManager.initialize()
    const prisma = prismaManager.getClient()

    const interval = range === '24h' ? 'hour' : 'day'
    const dateFormat = interval === 'hour' ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d'

    // 并行发起所有历史聚合与 SLA 指标查询 (Promise.all 消除串行等待)
    const [
      summary,
      statusCounts,
      averages,
      modelDistribution,
      userRanking,
      presetRanking,
      sessionRanking,
      streamCounts,
      trafficCounts,
      rawTrends,
    ] = await Promise.all([
      // 1. 基础聚合指标 (全状态)
      prisma.lLMCallLog.aggregate({
        _count: { id: true },
        _sum: {
          candidatesTokens: true,
          promptTokens: true,
          thinkingTokens: true,
          totalTokens: true,
        },
        where: { createdAt: { gte: start, lte: end } },
      }),
      // 2. 各状态调用数
      prisma.lLMCallLog.groupBy({
        _count: { id: true },
        by: ['status'],
        where: { createdAt: { gte: start, lte: end } },
      }),
      // 3. 交互性能 SLA 指标均值 (针对成功调用)
      prisma.lLMCallLog.aggregate({
        _avg: { latency: true, tps: true, ttft: true },
        where: { createdAt: { gte: start, lte: end }, status: 'SUCCESS' },
      }),
      // 4. 模型与渠道资源分布
      prisma.lLMCallLog.groupBy({
        _avg: { tps: true, ttft: true },
        _count: { id: true },
        _sum: {
          cacheHitTokens: true,
          cacheMissTokens: true,
          candidatesTokens: true,
          promptTokens: true,
          totalTokens: true,
        },
        by: ['model', 'provider'],
        where: { createdAt: { gte: start, lte: end } },
      }),
      // 5. 用户活跃排行 Top 10
      prisma.lLMCallLog.groupBy({
        _count: { id: true },
        _sum: { totalTokens: true },
        by: ['userId'],
        orderBy: { _sum: { totalTokens: 'desc' } },
        take: 10,
        where: { createdAt: { gte: start, lte: end } },
      }),
      // 6. 预设角色活跃排行 Top 10
      prisma.lLMCallLog.groupBy({
        _count: { id: true },
        _sum: {
          totalTokens: true,
          promptTokens: true,
          candidatesTokens: true,
          cacheHitTokens: true,
        },
        by: ['presetName'],
        orderBy: { _sum: { totalTokens: 'desc' } },
        take: 10,
        where: { createdAt: { gte: start, lte: end } },
      }),
      // 7. 会话/联系人活跃排行 Top 10
      prisma.lLMCallLog.groupBy({
        _count: { id: true },
        _sum: { totalTokens: true },
        by: ['contactorId'],
        orderBy: { _sum: { totalTokens: 'desc' } },
        take: 10,
        where: { createdAt: { gte: start, lte: end } },
      }),
      // 7. 请求类型分布 (isStream)
      prisma.lLMCallLog.groupBy({
        _count: { id: true },
        by: ['isStream'],
        where: { createdAt: { gte: start, lte: end } },
      }),
      // 8. 流量类型分布 (trafficType)
      prisma.lLMCallLog.groupBy({
        _count: { id: true },
        by: ['trafficType'],
        where: { createdAt: { gte: start, lte: end } },
      }),
      // 9. 趋势走势 (时段分布)
      prisma.$queryRaw`
        SELECT 
          strftime(${dateFormat}, created_at) AS time_bucket,
          status,
          COUNT(id) AS call_count,
          SUM(total_tokens) AS token_count,
          AVG(latency) AS avg_latency,
          AVG(ttft) AS avg_ttft
        FROM llm_call_logs
        WHERE created_at >= ${start} AND created_at <= ${end}
        GROUP BY time_bucket, status
        ORDER BY time_bucket ASC
      `,
    ])

    const statusMap = { ABORTED: 0, FAILED: 0, SUCCESS: 0 }
    statusCounts.forEach((item) => {
      statusMap[item.status] = item._count.id
    })

    const totalCalls = (statusMap.SUCCESS || 0) + (statusMap.FAILED || 0) + (statusMap.ABORTED || 0)
    const successRate = totalCalls > 0 ? (statusMap.SUCCESS || 0) / totalCalls : 1

    const streamMap = { nonStream: 0, stream: 0 }
    streamCounts.forEach((item) => {
      if (item.isStream === true || item.isStream === 1) {
        streamMap.stream = item._count.id
      } else {
        streamMap.nonStream = item._count.id
      }
    })

    const trafficTypeDistribution = trafficCounts.map((item) => ({
      callCount: item._count.id,
      type: item.trafficType || 'ON_DEMAND',
    }))

    res.json({
      data: {
        modelDistribution: modelDistribution.map((item) => ({
          model: item.model,
          provider: item.provider,
          callCount: item._count.id,
          totalTokens: item._sum.totalTokens || 0,
          promptTokens: item._sum.promptTokens || 0,
          candidatesTokens: item._sum.candidatesTokens || 0,
          cacheHitTokens: item._sum.cacheHitTokens || 0,
          cacheMissTokens: item._sum.cacheMissTokens || 0,
          avgTtft: item._avg?.ttft ? Math.round(item._avg.ttft) : 0,
          avgTps: item._avg?.tps ? parseFloat(item._avg.tps.toFixed(2)) : 0,
        })),
        presetRanking: presetRanking.map((item) => ({
          presetName: item.presetName || 'Direct Dialogue',
          callCount: item._count.id,
          totalTokens: item._sum.totalTokens || 0,
          promptTokens: item._sum.promptTokens || 0,
          candidatesTokens: item._sum.candidatesTokens || 0,
          cacheHitTokens: item._sum.cacheHitTokens || 0,
        })),
        requestTypeDistribution: {
          nonStreamCount: streamMap.nonStream,
          streamCount: streamMap.stream,
        },
        sessionRanking: sessionRanking.map((item) => ({
          contactorId: item.contactorId || 'Direct Dialogue',
          callCount: item._count.id,
          totalTokens: item._sum.totalTokens || 0,
        })),
        summary: {
          abortedCalls: statusMap.ABORTED || 0,
          avgLatency: Math.round(averages._avg.latency || 0),
          avgTps: parseFloat((averages._avg.tps || 0).toFixed(2)),
          avgTtft: Math.round(averages._avg.ttft || 0),
          candidatesTokens: summary._sum.candidatesTokens || 0,
          failedCalls: statusMap.FAILED || 0,
          promptTokens: summary._sum.promptTokens || 0,
          successCalls: statusMap.SUCCESS || 0,
          successRate,
          thinkingTokens: summary._sum.thinkingTokens || 0,
          totalCalls,
          totalTokens: summary._sum.totalTokens || 0,
        },
        trafficTypeDistribution,
        trends: rawTrends.map((t) => ({
          timeBucket: t.time_bucket,
          status: t.status,
          callCount: Number(t.call_count),
          tokenCount: Number(t.token_count || 0),
          avgLatency: Math.round(t.avg_latency || 0),
          avgTtft: Math.round(t.avg_ttft || 0),
        })),
        userRanking: userRanking.map((item) => ({
          userId: formatUserAuditId(item.userId),
          callCount: item._count.id,
          totalTokens: item._sum.totalTokens || 0,
        })),
      },
      success: true,
    })
  } catch (error) {
    global.logger?.error('[DashboardController] 获取历史统计失败:', error)
    res.status(500).json({ error: error.message, success: false })
  }
}

/**
 * 分页获取故障/失败审计日志流
 */
export async function getFailureLogs(req, res) {
  try {
    const { limit = 50, offset = 0 } = req.query

    await prismaManager.initialize()
    const prisma = prismaManager.getClient()

    const [failures, total] = await Promise.all([
      prisma.lLMCallLog.findMany({
        orderBy: {
          createdAt: 'desc',
        },
        skip: Number(offset),
        take: Number(limit),
        where: {
          status: { not: 'SUCCESS' },
        },
      }),
      prisma.lLMCallLog.count({
        where: {
          status: { not: 'SUCCESS' },
        },
      }),
    ])

    res.json({
      data: {
        logs: failures,
        total,
      },
      success: true,
    })
  } catch (error) {
    global.logger?.error('[DashboardController] 获取失败日志失败:', error)
    res.status(500).json({ error: error.message, success: false })
  }
}

/**
 * 获取最近的活跃对话列表 (用于 Tool Call 级联链左侧面板)
 */
export async function getRecentTurns(req, res) {
  try {
    const limit = Number(req.query.limit || 50)
    const offset = Number(req.query.offset || 0)
    const { userId, contactorId, search } = req.query

    await prismaManager.initialize()
    const prisma = prismaManager.getClient()

    // 组装 where 条件
    const where = {}
    if (userId) {
      where.userId = userId
    }
    if (contactorId) {
      where.contactorId = contactorId
    }
    if (search) {
      where.OR = [
        { userId: { contains: search } },
        { contactorId: { contains: search } },
        { sessionTitle: { contains: search } },
        { userIp: { contains: search } }
      ]
    }

    // 构建轻量的高性能 COUNT DISTINCT 统计总量（避免全表 groupBy 爆内存）
    const countPromise = (async () => {
      if (!userId && !contactorId && !search) {
        const res = await prisma.$queryRaw`SELECT COUNT(DISTINCT request_id) AS count FROM llm_call_logs`
        return Number(res[0]?.count || 0)
      }
      // 带过滤条件时构建参数化 SQL
      const conditions = []
      const params = []
      if (userId) {
        conditions.push('user_id = ?')
        params.push(userId)
      }
      if (contactorId) {
        conditions.push('contactor_id = ?')
        params.push(contactorId)
      }
      if (search) {
        conditions.push('(user_id LIKE ? OR contactor_id LIKE ? OR session_title LIKE ? OR user_ip LIKE ?)')
        const s = `%${search}%`
        params.push(s, s, s, s)
      }
      const sqlWhere = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const countRes = await prisma.$queryRawUnsafe(`SELECT COUNT(DISTINCT request_id) AS count FROM llm_call_logs ${sqlWhere}`, ...params)
      return Number(countRes[0]?.count || 0)
    })()

    // 采用 groupBy 对 requestId 进行分页聚合
    const turnsPromise = prisma.lLMCallLog.groupBy({
      _count: {
        id: true
      },
      _max: {
        createdAt: true
      },
      _sum: {
        totalTokens: true
      },
      by: ['requestId', 'userId', 'userIp', 'presetName', 'contactorId', 'sessionTitle'],
      orderBy: {
        _max: {
          createdAt: 'desc'
        }
      },
      skip: offset,
      take: limit,
      where
    })

    // 并行获取列表与总量
    const [turns, total] = await Promise.all([turnsPromise, countPromise])
    // 统一 Token 口径：以该会话最后一次调用的输入输出为准（与级联详情右上角 finalTokens 一致），而非整条累加
    const lastCalls = await Promise.all(
      turns.map(t =>
        prisma.lLMCallLog.findFirst({
          where: { requestId: t.requestId },
          orderBy: { createdAt: 'desc' },
          select: { totalTokens: true, promptTokens: true, candidatesTokens: true }
        })
      )
    )
    res.json({
      data: {
        total,
        turns: turns.map((t, i) => {
          const lastToken = lastCalls[i]
            ? (lastCalls[i].totalTokens ||
                (lastCalls[i].promptTokens || 0) + (lastCalls[i].candidatesTokens || 0))
            : 0
          return {
            requestId: t.requestId,
            userId: formatUserAuditId(t.userId, t.requestId),
            userIp: t.userIp || '未知',
            presetName: t.presetName || 'Direct Dialogue',
            contactorId: t.contactorId,
            sessionTitle: t.sessionTitle || null,
            createdAt: t._max.createdAt ? t._max.createdAt.getTime() : Date.now(),
            totalTokens: lastToken,
            stepsCount: t._count.id
          }
        })
      },
      success: true
    })
  } catch (error) {
    global.logger?.error('[DashboardController] 获取最近对话列表失败:', error)
    res.status(500).json({ error: error.message, success: false })
  }
}

/**
 * 获取指定用户的聚合审计详情与画像 (调用总数、Token消耗分布、渠道偏好、最近IP)
 */
export async function getUserDetail(req, res) {
  try {
    const { userId } = req.params
    if (!userId) {
      return res.status(400).json({ error: 'userId is required', success: false })
    }

    await prismaManager.initialize()
    const prisma = prismaManager.getClient()

    // 1. 聚合该用户的调用、用量等
    const userAggregate = await prisma.lLMCallLog.aggregate({
      _count: { id: true },
      _max: {
        createdAt: true
      },
      _sum: {
        candidatesTokens: true,
        promptTokens: true,
        totalTokens: true
      },
      where: { userId }
    })

    // 2. 查找该用户最近一次调用的 IP 
    const lastCall = await prisma.lLMCallLog.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { userIp: true },
      where: { userId }
    })

    // 3. 统计该用户最偏好的模型分布
    const modelDistribution = await prisma.lLMCallLog.groupBy({
      _count: { id: true },
      by: ['model'],
      orderBy: {
        _count: { id: 'desc' }
      },
      take: 5,
      where: { userId }
    })

    res.json({
      data: {
        candidatesTokens: userAggregate._sum.candidatesTokens || 0,
        favModels: modelDistribution.map(m => ({
          model: m.model,
          calls: m._count.id
        })),
        lastActive: userAggregate._max.createdAt ? userAggregate._max.createdAt.getTime() : null,
        lastIp: lastCall?.userIp || '未知',
        promptTokens: userAggregate._sum.promptTokens || 0,
        totalCalls: userAggregate._count.id,
        totalTokens: userAggregate._sum.totalTokens || 0,
        userId
      },
      success: true
    })
  } catch (error) {
    global.logger?.error('[DashboardController] 获取用户画像详情失败:', error)
    res.status(500).json({ error: error.message, success: false })
  }
}

/**
 * 获取特定 requestId 的级联追踪链路
 */
export async function getTurnTrace(req, res) {
  try {
    const { requestId } = req.params
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required', success: false })
    }

    await prismaManager.initialize()
    const prisma = prismaManager.getClient()

    // 查询该请求下的所有大模型调用日志，按 id 升序（即调用顺序）排列
    const llmCalls = await prisma.lLMCallLog.findMany({
      orderBy: { id: 'asc' },
      where: { requestId }
    })

    if (llmCalls.length === 0) {
      return res.status(404).json({ error: 'Request trace not found', success: false })
    }

    const steps = []
    let stepIndex = 1

    for (const call of llmCalls) {
      // 1. 解析当前步骤调用的工具列表
      let toolsCalled = []
      try {
        if (call.toolsCalled) {
          toolsCalled = JSON.parse(call.toolsCalled)
        }
      } catch {
        toolsCalled = []
      }

      // 2. 压入大模型调用步骤
      steps.push({
        cacheHitTokens: call.cacheHitTokens || 0,
        cacheMissTokens: call.cacheMissTokens || 0,
        candidatesTokens: call.candidatesTokens,
        model: call.model,
        promptTokens: call.promptTokens,
        provider: call.provider,
        stepIndex: stepIndex++,
        timestamp: call.createdAt.getTime(),
        toolsCalled,
        totalTokens: call.totalTokens || ((call.promptTokens || 0) + (call.candidatesTokens || 0)),
        ttft: call.ttft || null,
        type: 'llm'
      })

      // 3. 如果当前步骤触发了工具，动态合成对应的 tool 步骤
      let toolDetails = []
      try {
        if (call.toolDetails) {
          toolDetails = JSON.parse(call.toolDetails)
        }
      } catch {
        toolDetails = []
      }

      if (toolDetails.length > 0) {
        for (const detail of toolDetails) {
          steps.push({
            arguments: typeof detail.arguments === 'string' ? detail.arguments : JSON.stringify(detail.arguments),
            output: typeof detail.output === 'string' ? detail.output : JSON.stringify(detail.output),
            stepIndex: stepIndex++,
            timestamp: call.createdAt.getTime() + 500, // 在 LLM 调用后推迟 500ms 作为模拟执行耗时
            toolName: detail.name,
            type: 'tool'
          })
        }
      } else if (toolsCalled.length > 0) {
        // 兼容没有详细信息时的旧数据
        for (const toolName of toolsCalled) {
          steps.push({
            arguments: '{}',
            output: '执行完毕',
            stepIndex: stepIndex++,
            timestamp: call.createdAt.getTime() + 500,
            toolName,
            type: 'tool'
          })
        }
      }
    }

    // 最后一轮的真实 Token 总量 (最后一轮的输入 + 输出 tokens)
    const lastLlmCall = llmCalls[llmCalls.length - 1]
    const finalTokens = lastLlmCall
      ? (lastLlmCall.totalTokens || ((lastLlmCall.promptTokens || 0) + (lastLlmCall.candidatesTokens || 0)))
      : 0

    res.json({
      data: {
        requestId,
        steps,
        totalTokens: finalTokens,
        userId: formatUserAuditId(llmCalls[0].userId, requestId)
      },
      success: true
    })
  } catch (error) {
    global.logger?.error('[DashboardController] 获取链路详情失败:', error)
    res.status(500).json({ error: error.message, success: false })
  }
}

/**
 * 格式化展示用户 ID 审计名称，识别并转化系统内部特殊调用任务
 */
function formatUserAuditId(userId, requestId = '') {
  const reqId = String(requestId || '')
  if (reqId.startsWith('system_title_')) {
    return '标题生成 (Title)'
  }
  if (reqId.startsWith('system_crystal_')) {
    return '会话压缩 (Compress)'
  }
  if (reqId.startsWith('task-')) {
    return '定时任务 (Task)'
  }
  if (reqId.startsWith('vision-bridge-')) {
    return '视觉分析 (Vision)'
  }
  
  if (!userId || userId === 'Direct Chat / API') {
    return 'Direct Chat / API'
  }
  if (userId === 'system') {
    return '系统内部任务 (System)'
  }
  
  return userId
}
