import { MioFunction } from '../../../function.js'
import PresetService from '../../../database/services/PresetService.js'

export default class ProfileTool extends MioFunction {
  constructor() {
    super({
      adminOnly: false,
      groupOnly: true,
      description: [
        '管理自己在当前群聊中的身份角色、专长职责 (Duty)、头衔 (Title) 与专属人设 (System Prompt)。',
        '当你与用户的群聊讨论中提炼出自己的定位分工，或用户要求你承担特定任务角色时，调用此工具更新你在群名单中的头衔 (title)、职责介绍 (intro/duty) 以及个人设定 (prompt/soul)。',
        '其他群成员和用户在后续对话中会通过群名单直接看到你的最新职责，并根据你的专长更精准地 @ 唤醒你。',
        '支持操作：read (查看当前设定), update (全量更新), append (追加人设), clear (清空重置)。',
      ].join('\n'),
      name: 'profile',
      parameters: {
        properties: {
          action: {
            default: 'read',
            description: '操作类型：read (读取当前人设与职责), update (更新设定), append (追加新设定), clear (清空人设)',
            enum: ['read', 'update', 'append', 'clear'],
            type: 'string',
          },
          prompt: {
            description: '当 action 为 update 或 append 时：要设置或追加的人设描述、系统指令或行为规范文本',
            type: 'string',
          },
          name: {
            description: '设置你的名字/昵称（例如：小顾、小助手）',
            type: 'string',
          },
          title: {
            description: '设置你在群内或对话中的专属头衔/角色名（例如：综合顾问、系统架构师）',
            type: 'string',
          },
          intro: {
            description: '设置你的专长与职责介绍（例如：负责综合咨询与创意支持）',
            type: 'string',
          },
          duty: {
            description: 'intro 的别名参数（兼容性支持）',
            type: 'string',
          },
          soul: {
            description: 'prompt 的别名参数（兼容性支持）',
            type: 'string',
          },
        },
        required: ['action'],
        type: 'object',
      },
    })
    this.func = this.execute.bind(this)
  }

  getDescription(context = null) {
    const isGroup = Boolean(
      context?.isGroup ||
      context?.platform === 'group' ||
      context?.metaData?.memberId ||
      context?.event?.metaData?.memberId
    )

    if (isGroup) {
      return [
        '管理自己在当前群聊中的身份角色、专长职责 (Duty)、头衔 (Title) 与专属人设 (System Prompt)。',
        '当你与用户的群聊讨论中提炼出自己的定位分工，或用户要求你承担特定任务角色时，调用此工具更新你在群名单中的头衔 (title)、职责介绍 (intro/duty) 以及个人设定 (prompt/soul)。',
        '其他群成员和用户在后续对话中会通过群名单直接看到你的最新职责，并根据你的专长更精准地 @ 唤醒你。',
        '支持操作：read (查看当前设定), update (全量更新), append (追加人设), clear (清空重置)。',
      ].join('\n')
    }

    return this.description
  }

  getParameters(type = null, context = null) {
    const isGroup = Boolean(
      context?.isGroup ||
      context?.platform === 'group' ||
      context?.metaData?.memberId ||
      context?.event?.metaData?.memberId
    )

    if (isGroup) {
      return {
        properties: {
          action: {
            default: 'read',
            description: '操作类型：read (查看当前群内职责与人设), update (更新设定), append (追加人设), clear (清空人设)',
            enum: ['read', 'update', 'append', 'clear'],
            type: 'string',
          },
          name: {
            description: '设置你在群内的名字/昵称（例如：小顾、小助手）',
            type: 'string',
          },
          title: {
            description: '设置你在群内的专属头衔或角色名（例如：系统架构师、前端开发专家、测试工程师）',
            type: 'string',
          },
          intro: {
            description: '设置你在群内的专长与职责介绍（例如：负责系统整体架构设计与核心技术攻关）',
            type: 'string',
          },
          prompt: {
            description: '设置或追加你的专属人设、系统指令或行为规范文本',
            type: 'string',
          },
          duty: {
            description: 'intro 的别名',
            type: 'string',
          },
          soul: {
            description: 'prompt 的别名',
            type: 'string',
          },
        },
        required: ['action'],
        type: 'object',
      }
    }

    return this.parameters
  }

  async execute(e) {
    const { action = 'read' } = e.params || {}
    const rawName = e.params?.name || ''
    const rawPrompt = e.params?.prompt || e.params?.soul || e.params?.content || ''
    const rawTitle = e.params?.title || ''
    const rawIntro = e.params?.intro || e.params?.duty || ''

    const contactorId = e.metaData?.contactorId || e.body?.contactorId || e.body?.metaData?.contactorId
    const memberId = e.metaData?.memberId || e.body?.memberId || e.body?.metaData?.memberId
    const memberName = e.metaData?.memberName || e.body?.memberName || e.body?.metaData?.memberName

    const memoryStore = e.channel?.memory || e.memory

    // 1. 获取当前的人格人设 / opening
    let currentPrompt = ''
    if (memoryStore && typeof memoryStore.readSoul === 'function') {
      try {
        currentPrompt = (await memoryStore.readSoul()) || ''
      } catch {}
    }
    if (!currentPrompt && e.body?.settings?.presetSettings?.opening) {
      currentPrompt = e.body.settings.presetSettings.opening
    }

    try {
      if (action === 'read') {
        return {
          action: 'read',
          contactorId,
          intro: rawIntro || undefined,
          memberId,
          memberName,
          name: rawName || undefined,
          prompt: currentPrompt || '（尚未设定自定义系统人设）',
          success: true,
          title: rawTitle || undefined,
        }
      }

      if (action === 'update' || action === 'append') {
        const nameToSet = rawName.trim()
        const textToSet = rawPrompt.trim()
        const titleToSet = rawTitle.trim()
        const introToSet = rawIntro.trim()

        if (!textToSet && !titleToSet && !introToSet && !nameToSet) {
          return { error: `执行 ${action} 操作时必须至少提供 name、prompt、title 或 intro 之一`, success: false }
        }

        let newPrompt = textToSet
        if (action === 'append' && currentPrompt) {
          newPrompt = textToSet ? `${currentPrompt}\n\n${textToSet}` : currentPrompt
        } else if (!textToSet && currentPrompt) {
          newPrompt = currentPrompt
        }

        // 写回当前请求上下文中的 settings
        if (!e.body) e.body = {}
        if (!e.body.settings) e.body.settings = {}
        if (!e.body.settings.presetSettings) e.body.settings.presetSettings = {}
        if (newPrompt) {
          e.body.settings.presetSettings.opening = newPrompt
        }

        // 通知前端客户端持久化保存（单聊/群聊成员）
        if (e.client && typeof e.client.sendSystemMessage === 'function') {
          e.client.sendSystemMessage('agent_profile_updated', {
            action,
            contactorId,
            intro: introToSet || undefined,
            memberId,
            memberName,
            name: nameToSet || undefined,
            opening: newPrompt,
            prompt: newPrompt,
            title: titleToSet || undefined,
          })
        }

        // 渠道环境持久化落盘
        if (memoryStore && typeof memoryStore.writeSoul === 'function' && newPrompt) {
          try {
            await memoryStore.writeSoul(newPrompt)
          } catch (err) {
            logger.error('[ProfileTool] 写入 MemoryStore 灵魂设定失败:', err)
          }
        }

        // SQLite Preset 更新（若匹配）
        const presetName = e.body?.settings?.presetSettings?.name
        if (presetName && newPrompt) {
          try {
            await PresetService.initialize()
            const dbPreset = await PresetService.findByName(presetName)
            if (dbPreset && dbPreset.type !== 'built-in') {
              await PresetService.update(presetName, {
                ...dbPreset,
                opening: newPrompt,
              })
            }
          } catch (err) {
            logger.error(`[ProfileTool] 更新数据库预设 "${presetName}" 失败:`, err)
          }
        }

        const noticeLines = ['🎭 [人设与角色职责已更新]']
        if (nameToSet) noticeLines.push(`📛 名字: ${nameToSet}`)
        if (titleToSet) noticeLines.push(`🏷️ 头衔: ${titleToSet}`)
        if (introToSet) noticeLines.push(`📋 职责: ${introToSet}`)
        if (newPrompt && newPrompt !== currentPrompt) {
          const preview = newPrompt.length > 50 ? `${newPrompt.slice(0, 50)}...` : newPrompt
          noticeLines.push(`✨ 设定: ${preview}`)
        }
        const noticeText = noticeLines.join('\n')

        this.setOuterRender(e, [{
          content: noticeText,
          placement: 'outer',
          text: noticeText,
          type: 'text',
        }])

        return {
          action,
          contactorId,
          intro: introToSet || undefined,
          memberId,
          memberName,
          message: `人设/角色职责已成功${action === 'append' ? '追加' : '更新'}并持久化 ✅`,
          name: nameToSet || undefined,
          prompt: newPrompt,
          success: true,
          title: titleToSet || undefined,
        }
      }

      if (action === 'clear') {
        if (e.body?.settings?.presetSettings) {
          e.body.settings.presetSettings.opening = ''
        }

        if (e.client && typeof e.client.sendSystemMessage === 'function') {
          e.client.sendSystemMessage('agent_profile_updated', {
            action: 'clear',
            contactorId,
            intro: '',
            memberId,
            memberName,
            opening: '',
            prompt: '',
            title: '',
          })
        }

        if (memoryStore && typeof memoryStore.writeSoul === 'function') {
          try {
            await memoryStore.writeSoul('')
          } catch {}
        }

        const noticeText = '🎭 [人设与群内职责已清空重置]'
        this.setOuterRender(e, [{
          content: noticeText,
          placement: 'outer',
          text: noticeText,
          type: 'text',
        }])

        return {
          action: 'clear',
          contactorId,
          memberId,
          memberName,
          message: '人设/角色职责已清空重置 ✅',
          prompt: '',
          success: true,
        }
      }

      return { error: `未知 action: ${action}`, success: false }
    } catch (err) {
      return { error: err.message, success: false }
    }
  }
}
